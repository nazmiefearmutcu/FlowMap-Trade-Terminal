"""Search / discovery REST routes: venues, universe, movers, quote, previews.

- ``/api/venues`` is PURE: the engine's venue set (native connectors + every
  ccxt id + equity + sim), read from module constants.
- ``/api/universe`` is PURE for the aggregate markets (the bundled directory +
  live-derived capabilities) and enumerates live, with a cache, when asked for
  a specific venue — the fuller counterpart to ``/api/symbols``.
- ``/api/movers`` and ``/api/quote`` are display-only price surfaces. ALL network
  is behind the TTL-debounced :class:`~flowmap_server.api.market_cache.MarketDataCache`
  on ``app.state.market_cache`` (injectable; canned in tests). A closed/stale
  equity value is surfaced as ``stale`` — never presented as a live NBBO print.
  A cache miss makes the request await one provider fetch; a usable cached value
  is returned at once and refreshed in the background when it is stale.
- ``/api/previews`` reads the bounded cache and startup-warmup progress only;
  it never starts provider work.

The cache absence is tolerated: if no cache is wired (should not happen in the
real app), movers/quote degrade to empty/unreachable rather than 500.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request

from flowmap_server.api.errors import ApiError
from flowmap_server.api.market_cache import (
    MarketDataCache,
    QuoteData,
    mover_to_json,
    quote_to_json,
)
from flowmap_server.api.rest import current_directory
from flowmap_server.config import Config
from flowmap_server.data.universe import filter_directory
from flowmap_server.data.venues import venue_catalog, venue_symbols
from flowmap_server.feeds.crypto import CryptoFeed, is_crypto_market, split_market

__all__ = ["router"]

router = APIRouter(prefix="/api")

_MOVERS_DEFAULT = 20
# Mirrors _MOVERS_MAX in api/market_cache.py (the cache fetches this many and
# slices per caller); equality is pinned by test_market_cache.py so the two
# clamps cannot drift silently.
_MOVERS_MAX = 100
_UNIVERSE_DEFAULT = 100
_UNIVERSE_MAX = 1000
# Movers ranks one of exactly two pools (see market_cache.default_movers_fn).
# Any other string used to fall through to Binance and come back labelled
# as Binance with a 200, so it is refused here instead.
_MOVERS_MARKETS = frozenset({"crypto", "equity"})
# Quote markets: the two pools, the sim feed (answers honestly unreachable),
# or a venue the build can serve.
_QUOTE_SIMPLE_MARKETS = frozenset({"crypto", "equity", "sim"})
# A symbol is a short ticker or pair: letters, digits and the separators venues
# use (BRK.B, BTC/USDT, BTC-PERP, ^GSPC, ETH:USDC). Anything else is refused
# before it can reach an upstream request or a cache key.
_SYMBOL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:+=^-]{0,63}")


def _cache(request: Request) -> MarketDataCache | None:
    return getattr(request.app.state, "market_cache", None)


def _invalid(detail: str, code: str = "invalid_params") -> ApiError:
    return ApiError(422, code, detail)


def _check_symbol(symbol: str) -> None:
    if not _SYMBOL_PATTERN.fullmatch(symbol):
        raise _invalid(f"invalid symbol {symbol[:80]!r}: 1-64 letters, digits or . _ / : + = ^ -",
                       code="invalid_symbol")


def _check_quote_market(market: str) -> None:
    if market in _QUOTE_SIMPLE_MARKETS or is_crypto_market(market):
        return
    raise _invalid(f"unknown market {market[:80]!r}", code="unknown_market")


@router.get("/venues")
async def venues() -> dict[str, list[dict[str, object]]]:
    """Every venue this build can stream. Pure — no network.

    This is what makes the picker's venue list the engine's list rather than a
    copy of it: the five native crypto connectors, every ccxt venue id, the
    equity market and the sim feed.
    """
    return {"venues": [v.as_dict() for v in venue_catalog()]}


@router.get("/universe")
async def universe(
    request: Request, market: str = "all", q: str = "", limit: int = _UNIVERSE_DEFAULT
) -> dict[str, list[dict[str, object]]]:
    """Symbol universe: ``market`` = all|crypto|equity|sim, or a venue string.

    ``all``/``crypto``/``equity``/``sim`` stay PURE — they serve the bundled
    directory, so the first paint never waits on a venue. Naming a specific
    crypto venue (``kraken``, ``binance-usdm``) enumerates that venue live and
    caches it; an unreachable venue degrades to the bundled shortlist rather
    than to an error.
    """
    n = max(1, min(limit, _UNIVERSE_MAX))
    if market not in ("", "all", "crypto", "equity", "sim") and is_crypto_market(market):
        entries = await _venue_entries(market, q=q, limit=n, cfg=_app_config(request))
        if entries is not None:
            return {"symbols": entries}
    entries = filter_directory(current_directory(), q=q, market=market, limit=n)
    return {"symbols": entries}


def _app_config(request: Request) -> Config:
    """The config the running app was built with (the one its subscribes use)."""
    cfg = getattr(request.app.state, "cfg", None)
    return cfg if isinstance(cfg, Config) else Config()


async def _venue_entries(
    market: str, *, q: str, limit: int, cfg: Config | None = None
) -> list[dict[str, object]] | None:
    """Live-enumerated rows for one venue, or ``None`` when it served nothing."""
    symbols = await venue_symbols(market)
    if not symbols:
        return None
    # Ask the feed rather than restating it. A hand-written copy here drifted
    # once already (it omitted the liquidation marker that a binance-usdm
    # subscribe really delivers), and the directory promising less — or more —
    # than a subscribe returns is exactly the dishonesty the capability block
    # exists to prevent. Same trick as rest._equity_capability. The feed gets the
    # app's OWN config: a default Config() ignored operator overrides (such as
    # FLOWMAP_BOOK_TOP_N), so the directory could not match the live subscribe.
    exchange, segment = split_market(market)
    capability = CryptoFeed(
        exchange=exchange, symbol="", market=segment, cfg=cfg or Config()
    ).capability
    needle = q.lower()
    out: list[dict[str, object]] = []
    for s in symbols:
        if needle and needle not in s.lower():
            continue
        out.append({"market": market, "symbol": s, "capability": capability})
        if len(out) >= limit:
            break
    return out


@router.get("/movers")
async def movers(
    request: Request, market: str = "crypto", limit: int = _MOVERS_DEFAULT
) -> dict[str, list[dict[str, object]]]:
    """Top movers for a market, ranked by |24 h %change| (display-only)."""
    if market not in _MOVERS_MARKETS:
        raise _invalid(f"market must be one of {sorted(_MOVERS_MARKETS)}; got {market[:80]!r}",
                       code="unknown_market")
    n = max(1, min(limit, _MOVERS_MAX))
    cache = _cache(request)
    if cache is None:
        return {"movers": []}
    quotes = await cache.movers(market, n)
    return {"movers": [mover_to_json(q) for q in quotes]}


@router.get("/quote")
async def quote(request: Request, market: str, symbol: str) -> dict[str, object]:
    """Single-symbol display-only quote (price + 24 h change + spark).

    Awaits one provider fetch on a cache miss (see ``MarketDataCache.quote``).
    """
    _check_quote_market(market)
    _check_symbol(symbol)
    cache = _cache(request)
    if cache is None:
        q = QuoteData(market=market, symbol=symbol.upper(), reachable=False, stale=True)
        return quote_to_json(q)
    return quote_to_json(await cache.quote(market, symbol))


@router.get("/previews")
async def previews(request: Request, after: int = 0, generation: str | None = None) -> dict[str, object]:
    """Incremental cached previews and startup progress; never starts provider I/O."""
    cache = _cache(request)
    if cache is None:
        return {"quotes": [], "revision": 0, "generation": "", "warming": False,
                "total": 0, "completed": 0, "ready": 0}
    return cache.preview_snapshot(after, generation)
