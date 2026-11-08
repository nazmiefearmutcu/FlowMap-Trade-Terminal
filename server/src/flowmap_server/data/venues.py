"""Live venue + symbol enumeration, straight from the market engine.

The engine enumerates venues and symbols, so this module is the live path.
The bundled lists in :mod:`flowmap_server.data.universe` are the offline
fallback, not the whole truth.

Two things are enumerated, and they have very different costs:

**Venues** (:func:`venue_catalog`) — free. ``list_all_exchanges()`` is a union
of the engine's hand-written connectors and ccxt's venue table, both module
constants. No network, safe to call per request.

**Symbols** (:func:`venue_symbols`) — one REST round-trip per venue, cached.

Spelling is the load-bearing detail. A venue with a hand-written connector
wants its OWN symbol id (Binance ``ETHBTC``, OKX ``BTC-USD-SWAP``, Deribit
``BTC-PERPETUAL``); ccxt speaks a unified id (``ETH/BTC``). The engine's
``exchange_instruments`` routes through ccxt whenever the venue is a ccxt id —
which includes Binance and OKX — so enumerating through it would hand the
symbol picker a spelling the native connector then rejects. So: enumerate from
the native connector first and fall back to ccxt only for venues that have no
native reader (or whose native listing fails). :func:`resolve_symbol` closes
the remaining gap at subscribe time, so a symbol typed in either spelling still
works.

Native listings go through the same certifi hardening the live feed uses — a
stock macOS framework Python cannot verify these hosts otherwise, and the
failure looks like "venue has no symbols" rather than a TLS error.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, NamedTuple

from flowmap_server.feeds.crypto import (
    CRYPTO_EXCHANGES,
    NATIVE_EXCHANGES,
    _harden_rest_ssl,
    split_market,
)
from flowmap_server.feeds.equity import EQUITY_MARKET

__all__ = [
    "SYMBOL_TTL_NS",
    "UnlistedSymbolError",
    "VenueInfo",
    "ccxt_knows",
    "resolve_symbol",
    "venue_catalog",
    "venue_symbols",
]

logger = logging.getLogger(__name__)

# Segments that mean "derivatives" to ccxt's `defaultType`.
_SWAP_SEGMENTS = frozenset({"usdm", "coinm", "linear", "inverse", "swap", "perp", "futures"})
# ccxt market flag that identifies a segment's settlement family (USDT- vs coin-margined).
_SETTLE_FLAG = {"usdm": "linear", "linear": "linear", "coinm": "inverse", "inverse": "inverse"}

# One venue's instrument list is stable on the scale of a session; re-listing
# per search keystroke would be a rate-limit incident, not a feature.
SYMBOL_TTL_NS = 15 * 60 * 10**9

# A venue listing runs inside a request handler, under a per-market lock, so an
# unbounded await blocks every other caller for that venue. The engine's own
# readers have no wall-clock bound of their own: Deribit does 20 sequential REST
# calls at 10 s + 3 retries each, Bybit pages a cursor with no page cap. Cap it
# here.
LIST_TIMEOUT_S = 25.0

# A venue that just failed is not retried on the next keystroke, but neither is
# the failure treated as a 15-minute answer: a short negative TTL debounces the
# outage without freezing an empty picker until the venue is forgotten.
EMPTY_TTL_NS = 30 * 10**9

# Segments a venue accepts after the "-" in a market string. Only venues whose
# connector takes a segment kwarg have any; the rest encode it in the symbol.
_SEGMENTS: dict[str, tuple[str, ...]] = {
    "binance": ("spot", "usdm", "coinm"),
    "bybit": ("spot", "linear", "inverse", "option"),
}

class VenueInfo:
    """One selectable venue, as the discovery API reports it."""

    __slots__ = ("asset_class", "depth", "id", "native", "segments")

    def __init__(
        self,
        id: str,
        asset_class: str,
        native: bool,
        segments: tuple[str, ...],
        depth: str | None = None,
    ) -> None:
        self.id = id
        self.asset_class = asset_class
        self.native = native
        self.segments = segments
        # Crypto: a native connector streams true book diffs, a ccxt venue is
        # re-read whole each tick, and the client badges the difference — so the
        # `native` flag IS the depth there. Off the crypto side it is not:
        # no equity tier serves L2 (keyless is SYNTH, Alpaca is L1), and
        # /api/universe reports the same market. Non-crypto venues therefore
        # state their own depth, read off the feed.
        self.depth = depth or ("L2" if native else "L2-snapshot")

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "assetClass": self.asset_class,
            "depth": self.depth,
            "native": self.native,
            "segments": list(self.segments),
        }


def _feed_depth(capability: dict[str, object]) -> str:
    return str(capability.get("depth", "unknown"))


def _sim_depth() -> str:
    """Sim depth read off SimFeed itself (construction is pure)."""
    from flowmap_server.feeds.sim import SimFeed

    return _feed_depth(SimFeed(seed=0).capability)


def _equity_depth() -> str:
    """Equity depth read off EquityFeed's own tier selection, never assumed.

    Mirrors ``api.rest._equity_capability``: keys are auto-detected from env, so
    a keyed machine reports its real tier with no code change. Construction does
    no I/O. Falls back to the keyless answer if the env is unreadable.
    """
    import os

    from flowmap_server.config import Config
    from flowmap_server.feeds.equity import EquityFeed

    try:
        cfg = Config.from_env(os.environ)
    except Exception:  # a bad env falls back to keyless defaults
        logger.warning("invalid server environment; using keyless defaults", exc_info=True)
        cfg = Config()
    return _feed_depth(EquityFeed("AAPL", cfg).capability)


def venue_catalog() -> list[VenueInfo]:
    """Every venue this build can actually stream. No network."""
    out = [
        VenueInfo("sim", "sim", True, (), depth=_sim_depth()),
        VenueInfo(EQUITY_MARKET, "equity", True, (), depth=_equity_depth()),
    ]
    for ex in sorted(CRYPTO_EXCHANGES):
        # CRYPTO_EXCHANGES already excludes the non-streamable readers — the
        # catalog and the router cannot disagree about what is subscribable.
        out.append(VenueInfo(ex, "crypto", ex in NATIVE_EXCHANGES, _SEGMENTS.get(ex, ())))
    return out


class UnlistedSymbolError(ValueError):
    """The venue's own market table loaded and does not list this symbol.

    Raised before any connector is built for the symbol, so a mistyped symbol
    costs one cached table lookup, not a subscribe to the venue.
    """


class _VenueTables(NamedTuple):
    """One venue's loaded ccxt market table, as ``CCXTConnector`` reads it."""

    markets: dict[str, Any]
    markets_by_id: dict[str, Any]


_cache: dict[str, tuple[int, list[str]]] = {}
_locks: dict[str, asyncio.Lock] = {}
_price_ticks: dict[str, dict[str, float]] = {}
# Loaded market tables, keyed by (exchange, default market type): that type decides
# which market a bare id resolves to. A table that failed to load is kept as None
# for EMPTY_TTL_NS only, so an outage is not re-downloaded on every subscribe.
_tables: dict[tuple[str, str], tuple[int, _VenueTables | None]] = {}
_table_locks: dict[tuple[str, str], asyncio.Lock] = {}
# Exchanges whose table is currently unavailable: the failure is logged once per
# outage, not once per subscribe.
_tables_unavailable: set[str] = set()


async def venue_price_tick(market: str, symbol: str) -> float | None:
    """Use the same cached instrument listing as the picker, including segment."""
    await venue_symbols(market)
    return _price_ticks.get(market, {}).get(symbol)


async def venue_symbols(market: str, *, now_ns: int | None = None) -> list[str]:
    """Symbols listed by *market*, in the spelling that venue's feed expects.

    Returns ``[]`` — never raises — when the venue is unreachable, so discovery
    degrades to the bundled shortlist instead of failing the request. Results
    are cached for :data:`SYMBOL_TTL_NS` and concurrent callers collapse onto
    one fetch.
    """
    now = time.time_ns() if now_ns is None else now_ns
    hit = _cache.get(market)
    if hit is not None and now - hit[0] < SYMBOL_TTL_NS:
        return hit[1]
    lock = _locks.setdefault(market, asyncio.Lock())
    async with lock:
        # Re-check: a caller that queued on the lock wants the fetch the holder
        # just did, not a second one.
        hit = _cache.get(market)
        if hit is not None and now - hit[0] < SYMBOL_TTL_NS:
            return hit[1]
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                symbols = await _list_symbols(market)
        except (TimeoutError, asyncio.TimeoutError):
            logger.warning("symbol enumeration timed out for %r", market)
            symbols = []
        except Exception:  # discovery must not fail on a venue outage
            logger.warning("symbol enumeration failed for %r", market, exc_info=True)
            symbols = []
        # Stamp the time the answer was OBTAINED, not the time the request
        # started: a slow fetch would otherwise be born already aged. Honour an
        # injected clock so tests stay deterministic.
        done = time.time_ns() if now_ns is None else now_ns
        if symbols:
            _cache[market] = (done, symbols)
            return symbols
        if hit is not None:
            # Keep the last good list rather than blanking the picker — and
            # refresh its stamp, or every later call re-fetches and the failure
            # becomes the rate-limit incident the cache exists to prevent.
            _cache[market] = (done, hit[1])
            return hit[1]
        # Nothing good to fall back on: remember the emptiness only briefly.
        _cache[market] = (done - SYMBOL_TTL_NS + EMPTY_TTL_NS, [])
        return []


def _table_ttl(tables: _VenueTables | None) -> int:
    return SYMBOL_TTL_NS if tables is not None else EMPTY_TTL_NS


async def _venue_tables(
    exchange: str, segment: str, *, now_ns: int | None = None
) -> _VenueTables | None:
    """The venue's loaded ccxt market table, or ``None`` when it cannot be loaded.

    Concurrent callers share one load, under the same bound as a listing. A
    failure never raises here: the caller fails open, and the outage is logged
    once until the venue loads again.
    """
    key = (exchange, "swap" if segment in _SWAP_SEGMENTS else "spot")
    now = time.time_ns() if now_ns is None else now_ns
    hit = _tables.get(key)
    if hit is not None and now - hit[0] < _table_ttl(hit[1]):
        return hit[1]
    lock = _table_locks.setdefault(key, asyncio.Lock())
    async with lock:
        # Re-check: a caller that queued on the lock wants the load its holder just did.
        hit = _tables.get(key)
        if hit is not None and now - hit[0] < _table_ttl(hit[1]):
            return hit[1]
        tables: _VenueTables | None
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                tables = await _load_tables(exchange, key[1] == "swap")
        except Exception:  # a table outage must not fail a subscribe; timeouts included
            tables = None
            if exchange not in _tables_unavailable:
                _tables_unavailable.add(exchange)
                logger.warning(
                    "market table unavailable for %r; symbols are not pre-checked",
                    exchange, exc_info=True,
                )
        else:
            _tables_unavailable.discard(exchange)
        _tables[key] = (time.time_ns() if now_ns is None else now_ns, tables)
        return tables


async def _load_tables(exchange: str, swap: bool) -> _VenueTables:
    import ccxt.async_support as ccxt_async

    options = {"defaultType": "swap" if swap else "spot"}
    ex = getattr(ccxt_async, exchange)({"enableRateLimit": True, "options": options})
    try:
        await ex.load_markets()
        return _VenueTables(markets=ex.markets, markets_by_id=ex.markets_by_id)
    finally:
        await ex.close()


async def _list_symbols(market: str) -> list[str]:
    exchange, segment = split_market(market)
    if exchange in NATIVE_EXCHANGES:
        native = await _native_symbols(exchange, segment)
        if native:
            return native
        logger.info("native listing empty for %r; falling back to ccxt", market)
    return await _ccxt_symbols(market, exchange, segment)


async def _native_symbols(exchange: str, segment: str) -> list[str]:
    from crocodile.core.sink.memory import MemorySink
    from crocodile.crypto.exchanges.factory import make_connector
    from crocodile.crypto.instruments.registry import InstrumentRegistry

    kw: dict[str, Any] = {}
    if exchange == "binance" and segment:
        kw["market"] = segment
    elif exchange == "bybit" and segment:
        kw["category"] = segment
    conn = make_connector(
        exchange,
        symbols=[],
        channels=[],
        out=MemorySink(),
        registry=InstrumentRegistry(),
        **kw,
    )
    _harden_rest_ssl(conn)
    try:
        instruments = await conn.list_instruments()
    finally:
        await _close_quietly(conn)
    market = f"{exchange}-{segment}" if segment else exchange
    ticks: dict[str, float] = {}
    for i in instruments:
        tick = getattr(i, "tick_size", None)
        if tick is not None and math.isfinite(tick) and tick > 0:
            ticks[str(i.symbol_raw)] = float(tick)
    _price_ticks[market] = ticks
    return sorted({str(i.symbol_raw) for i in instruments if i.symbol_raw})


def ccxt_knows(exchange: str) -> bool:
    """True when ccxt has a driver for *exchange*.

    NOT ``factory.is_ccxt_exchange``: that answers "is this venue SERVED BY the
    ccxt connector", which is False for every venue that also has a native
    connector — measured against crocodile 0.3.2 and ccxt 4.5.69, six of the ten
    natives are also ccxt ids (binance, bybit, coinbase, deribit, derive, okx).
    Those are exactly the venues where we still want ccxt for what the native
    reader does not do — symbol translation and kline backfill — so the question
    here is the other one.
    """
    try:
        import ccxt
    except ModuleNotFoundError:
        return False
    return exchange in ccxt.exchanges


async def _ccxt_symbols(market: str, exchange: str, segment: str = "") -> list[str]:
    """ccxt's listing for *market*, restricted to the market segment it names.

    The segment is passed to ccxt as ``defaultType`` so ``binance-usdm`` lists
    perpetuals, not the spot table. A segment this fallback cannot map is not
    listed at all, rather than silently listing a different market type.
    """
    if not ccxt_knows(exchange):
        return []
    if segment and segment not in _SWAP_SEGMENTS and segment != "spot":
        logger.warning("no ccxt market type for segment %r of %r; not listing", segment, market)
        return []
    import ccxt.async_support as ccxt_async

    options: dict[str, object] = {}
    if segment:
        options["defaultType"] = "swap" if segment in _SWAP_SEGMENTS else "spot"
    config: dict[str, object] = {"enableRateLimit": True}
    if options:
        config["options"] = options
    ex = getattr(ccxt_async, exchange)(config)
    try:
        loaded = await ex.load_markets()
    finally:
        await ex.close()
    # defaultType "swap" loads every settlement family at once (USDT- and coin-margined
    # perpetuals alike), so keep only the family the segment names. An unknown flag is
    # kept; only an explicit False removes a market.
    settle_flag = _SETTLE_FLAG.get(segment)
    markets = {
        sym: m for sym, m in loaded.items()
        if settle_flag is None or (m or {}).get(settle_flag) is not False
    }
    # Universal connectors already load this table for discovery. Reuse its
    # price precision rather than assigning the simulation tick to each coin.
    # Ticks are keyed by the full market string, the key venue_price_tick reads.
    ticks: dict[str, float] = {}
    for sym, item in markets.items():
        precision = ((item or {}).get("precision") or {}).get("price")
        tick = _ccxt_price_tick(precision, ex.precisionMode)
        if tick is not None:
            ticks[str(sym)] = tick
            raw = (item or {}).get("id")
            if raw:
                ticks[str(raw)] = tick
    _price_ticks[market] = ticks
    # Only an explicit `active: False` removes a market; ccxt uses None for unknown status.
    return sorted(str(sym) for sym, m in markets.items() if (m or {}).get("active") is not False)


def _ccxt_price_tick(precision: object, mode: int) -> float | None:
    import ccxt

    if not isinstance(precision, (int, float)) or not math.isfinite(precision):
        return None
    if mode == ccxt.TICK_SIZE:
        tick = float(precision)
    elif mode == ccxt.DECIMAL_PLACES and -20 <= precision <= 20:
        tick = 10.0 ** -precision
    else:
        # Significant-digit precision is price-dependent, not a fixed tick.
        return None
    return tick if tick > 0 and math.isfinite(tick) else None


async def resolve_symbol(market: str, symbol: str) -> str:
    """Return *symbol* in the spelling *market*'s connector expects.

    A native venue is given its own id; a ccxt venue is given the unified id.
    Cross-spelling input is translated through the venue's ccxt market table,
    which carries both (``markets[unified]["id"]`` IS the venue-native symbol).

    A symbol that the loaded table does not list raises :class:`UnlistedSymbolError`
    before any connector is built for it. When the table cannot be loaded, the
    input is returned untouched: the connector's own error is a better message
    than a guess, and a venue outage must not block a subscribe.
    """
    exchange, segment = split_market(market)
    native = exchange in NATIVE_EXCHANGES
    already_native = (('/' in symbol and ':' not in symbol) if exchange == 'kraken'
                      else symbol.startswith('t') if exchange == 'bitfinex'
                      else '/' not in symbol)
    # Native venue with a native-looking symbol, or ccxt venue with a unified one:
    # already the right shape, so no translation is needed.
    shaped = (native and already_native) or (not native and '/' in symbol)
    if not ccxt_knows(exchange):
        return symbol
    tables = await _venue_tables(exchange, segment)
    if tables is None:
        return symbol
    try:
        from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector

        unified = CCXTConnector._resolve_symbol(symbol, tables.markets, tables.markets_by_id)
    except Exception:  # a failed translation must not block a subscribe
        logger.warning("symbol translation failed for %s:%s", market, symbol, exc_info=True)
        return symbol
    if unified is None and symbol not in tables.markets and symbol not in tables.markets_by_id:
        raise UnlistedSymbolError(f"{symbol!r} is not listed on {market!r}")
    if shaped or unified is None:
        return symbol
    if not native:
        return unified
    if exchange == 'kraken':
        # Spot WebSocket v2 takes BTC/USD, unlike REST's XXBTZUSD.
        return unified.split(':', 1)[0].replace('XBT', 'BTC')
    venue_id = (tables.markets.get(unified) or {}).get("id")
    if exchange == 'bitfinex' and venue_id:
        return str(venue_id) if str(venue_id).startswith('t') else 't' + str(venue_id)
    return str(venue_id) if venue_id else symbol


async def _close_quietly(conn: object) -> None:
    session = getattr(conn, "_session", None)
    if session is not None and not getattr(session, "closed", True):
        try:
            await session.close()
        except Exception:  # teardown: the connection is gone either way
            logger.debug("venue session close failed", exc_info=True)
