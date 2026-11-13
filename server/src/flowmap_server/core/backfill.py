"""First-launch price history: candles -> grid columns with no depth.

Data plane. On a COLD subscribe (no Parquet tail to rehydrate) the
grid ring is empty, so the client's eager ``requestHistory`` after the first
snapshot returns nothing. This module fetches a bounded span of candles for the
symbol and converts them into :class:`~flowmap_server.core.grid.FinalizedColumn`
objects that :meth:`Grid.preload` accepts, so the ring holds recent price
history before the first attach.

**What the history is.** Candles carry OHLCV (crypto klines also carry a taker
buy/sell split), NOT the resting order book. Nothing was observed about the book
for that period, so the columns carry no depth at all: the heatmap is empty there
and the price line, volume and CVD are real. The caller emits a
``Marker{kind=gap}`` between the history and live. These columns are seeded into
the ring but are deliberately NOT recorded to Parquet (only live columns persist
for a future rehydration).

The network fetch is fully behind the injectable ``BackfillFn`` seam
(``async (market, symbol, *, max_cols, now_ns) -> Sequence[Candle]``): pytest
feeds canned candles and never hits the network; the default production seam
(:func:`default_backfill_fn`) dispatches crypto -> Crocodile ``iter_backfill``
klines where a venue has a native REST backfill and ccxt ``fetchOHLCV`` for the
rest, equity -> Crocodile's Yahoo 1 m bars; all imported lazily so the heavy
provider deps never load in tests.

Conversion rules (mirrors :meth:`Grid.preload`'s contract):

- one column per candle, ``col_seq`` assigned ``0..N-1`` (strictly contiguous,
  which preload requires), ``t0_ns`` snapped onto the grid's ``dt`` grid and
  forced strictly increasing. Columns are therefore one candle apart in time,
  not one ``dt`` apart; the client's piecewise t0<->column map keeps the time
  axis true;
- a single epoch 0 whose ``p0`` is centered on the last candle's close, with
  ``tick_multiple``/``dt_ns``/``rows`` equal to the grid cfg and the tick equal
  to ``cfg.tick`` — or, on an auto_tick grid, the price-proportional tick
  ``adaptive_tick_for(close, cfg.tick)`` the live first mid will adopt. On a
  banded grid the first live mid then builds the band frame as a new epoch,
  exactly as it does after a cold start;
- every column's bid and ask density is zero;
- bars carry the candle OHLC and (crypto only) ``vol_buy``/``vol_sell``/
  ``cvd_cum`` from the taker split; equity bars have no side split so those
  stay 0 (cvd flat). ``vwap_*`` accumulate from the candle typical price for
  both markets.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import threading
import time
from collections.abc import Awaitable, Callable, Sequence

import msgspec
import numpy as np

from flowmap_server.core.grid import FinalizedColumn, GridCfg, adaptive_tick_for
from flowmap_server.proto.events import BarColumn, EpochParams

__all__ = ["Candle", "BackfillFn", "columns_from_candles", "default_backfill_fn"]

logger = logging.getLogger(__name__)

_NAN = float("nan")
# Total wall-clock timeout for every network client this module builds:
# the boot path holds the session's _start_lock while backfilling, so one hung
# endpoint must cost seconds, not aiohttp's 5-minute default.
_HTTP_TIMEOUT_S = 15.0
_HTTP_TIMEOUT_MS = int(_HTTP_TIMEOUT_S * 1000)

# Cache only the configured trust context, never loop-owned sessions or tasks.
# Separate pools keep slow metadata jobs from delaying first CA construction.
_CA_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="backfill-ca")
_CA_CONTEXT_FUTURES: dict[str, concurrent.futures.Future] = {}
_CCXT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="backfill-ccxt")

# A venue's ccxt market table is a large download. It used to be fetched on every
# backfill miss (api-v1). The table is cached per (venue, market type)
# for an hour and installed on each short-lived client with ``set_markets``. Only
# plain data is shared: a ccxt client is bound to the loop that created it, so
# clients are never reused across backfills. Guarded by a lock because the
# backfill runs on executor threads.
_MARKETS_TTL_S = 3600.0
_MARKETS_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_MARKETS_LOCK = threading.Lock()


def _cached_ccxt_markets(key: tuple[str, str]) -> dict | None:
    with _MARKETS_LOCK:
        hit = _MARKETS_CACHE.get(key)
    if hit is None:
        return None
    stored_at, markets = hit
    if time.monotonic() - stored_at > _MARKETS_TTL_S:
        return None
    return markets


def _remember_ccxt_markets(key: tuple[str, str], markets: dict) -> None:
    if not markets:
        return  # an empty table is a failed or unlisted answer, never worth an hour
    with _MARKETS_LOCK:
        _MARKETS_CACHE[key] = (time.monotonic(), markets)


async def _await_owned(future: asyncio.Future, *, cancel: Callable[[], None] | None = None):
    """Drain owned work before propagating cancellation, including repeated cancels."""
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        if cancel is not None:
            cancel()
        while not future.done():
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:  # shielded work: keep waiting until it finishes
                continue
            except Exception:  # cancellation remains the caller's outcome
                break
        if not future.cancelled():
            error = future.exception()
            if error is not None and not isinstance(error, asyncio.CancelledError):
                logger.debug("provider cleanup failed during cancellation", exc_info=error)
        raise


def _initialize_ca_context(cafile: str, result: concurrent.futures.Future) -> None:
    try:
        import ssl

        result.set_result(ssl.create_default_context(cafile=cafile))
    except BaseException as error:
        # Concurrent initial callers share the failure; a later request can retry.
        if _CA_CONTEXT_FUTURES.get(cafile) is result:
            _CA_CONTEXT_FUTURES.pop(cafile, None)
        result.set_exception(error)


async def _certifi_context(cafile: str):
    candidate = concurrent.futures.Future()
    # CPython's atomic setdefault publishes one shared, thread-safe Future even
    # to callers on different loops. No thread lock is waited on by those loops.
    result = _CA_CONTEXT_FUTURES.setdefault(cafile, candidate)
    if result is candidate:
        try:
            _CA_EXECUTOR.submit(_initialize_ca_context, cafile, result)
        except BaseException as error:
            _CA_CONTEXT_FUTURES.pop(cafile, None)
            result.set_exception(error)
    # A caller cannot cancel shared initialization out from under other callers.
    return await _await_owned(asyncio.wrap_future(result))


class Candle(msgspec.Struct):
    """One OHLCV candle for backfill (canonical, provider-agnostic).

    ``t0_ns`` is the candle-open UTC ns. ``buy_volume``/``sell_volume`` are the
    taker aggressor split (crypto klines); ``None`` for markets without a split
    (equity), which leaves the CVD built from the candles' taker split empty.
    """

    t0_ns: int
    o: float
    h: float
    l: float
    c: float
    volume: float
    buy_volume: float | None = None
    sell_volume: float | None = None


# async (market, symbol, *, max_cols, now_ns) -> candles (oldest-first ideally;
# the converter sorts defensively). Returns [] to decline (e.g. sim).
BackfillFn = Callable[..., Awaitable[Sequence[Candle]]]


def _finite(*vals: float) -> bool:
    return all(v is not None and np.isfinite(v) for v in vals)


def _clean_candles(candles: Sequence[Candle]) -> list[Candle]:
    """Finite, non-negative-volume, positive-close candles, sorted by raw t0."""
    clean: list[Candle] = []
    for cd in candles:
        if not _finite(cd.o, cd.h, cd.l, cd.c, cd.volume):
            continue
        if cd.volume < 0.0 or not (cd.c > 0.0):
            continue
        clean.append(cd)
    clean.sort(key=lambda cd: cd.t0_ns)
    return clean


def _price_frame(ref: float, cfg: GridCfg) -> tuple[float, float, float] | None:
    """``(tick, p0, step)`` of the seeded epoch, framed on the reference close.

    The tick is resolved AFTER the reference close so an auto_tick grid (crypto
    feeds serving sub-dollar instruments) frames the history on the same
    price-proportional step the live first mid will install. For every
    other grid this is ``cfg.tick`` verbatim. The frame is centred on the close
    and snapped onto the step grid, so live data continues in this epoch
    without an immediate re-anchor.
    """
    tick = adaptive_tick_for(ref, cfg.tick) if cfg.auto_tick else cfg.tick
    step = tick * cfg.tick_multiple
    if tick <= 0.0 or step <= 0.0:
        return None
    span = cfg.rows * step
    p0 = max(0.0, round((ref - span / 2.0) / step) * step)
    return tick, p0, step


def _price_bars(clean: Sequence[Candle], dt: int) -> list[BarColumn]:
    """One bar per candle, t0 snapped onto the dt grid and strictly increasing.

    A candle sharing a slot with the previous one is forced to ``prev_t0 + dt``
    (preload requires strictly increasing t0). No candle is dropped. Crypto
    candles carry a real taker split, which becomes ``vol_buy``/``vol_sell`` and
    the cumulative CVD; without a split those stay 0.
    """
    bars: list[BarColumn] = []
    cvd_cum = 0.0
    vwap_num = 0.0
    vwap_den = 0.0
    prev_t0: int | None = None
    for cd in clean:
        t0 = (cd.t0_ns // dt) * dt
        if prev_t0 is not None and t0 <= prev_t0:
            t0 = prev_t0 + dt
        prev_t0 = t0

        has_split = cd.buy_volume is not None and cd.sell_volume is not None
        vb = float(cd.buy_volume) if has_split else 0.0  # type: ignore[arg-type]
        vs = float(cd.sell_volume) if has_split else 0.0  # type: ignore[arg-type]
        if has_split and _finite(vb, vs):
            cvd_cum += vb - vs
        else:
            vb = vs = 0.0
        tp = (cd.h + cd.l + cd.c) / 3.0
        vwap_num += tp * float(cd.volume)
        vwap_den += float(cd.volume)
        bars.append(
            BarColumn(
                epoch=0,
                col_seq=len(bars),
                t0_ns=t0,
                o=float(cd.o),
                h=float(cd.h),
                l=float(cd.l),
                c=float(cd.c),
                vol_buy=vb,
                vol_sell=vs,
                cvd_cum=cvd_cum,
                vwap_num_cum=vwap_num,
                vwap_den_cum=vwap_den,
            )
        )
    return bars


def columns_from_candles(
    candles: Sequence[Candle], cfg: GridCfg
) -> tuple[list[FinalizedColumn], EpochParams] | None:
    """Convert candles to price-only ``(columns, epoch)`` for :meth:`Grid.preload`.

    One column per candle. Every column's density is zero: a candle says where
    price traded, not what was resting in the book, so no depth is drawn for it.

    Returns ``None`` when nothing usable can be produced (no finite candles, a
    degenerate price frame) — the caller then degrades to a cold start. Never
    raises on ordinary bad input; only programming errors surface.
    """
    rows = cfg.rows
    dt = cfg.dt_ns
    if rows <= 0 or cfg.tick * cfg.tick_multiple <= 0.0 or dt <= 0:
        return None

    clean = _clean_candles(candles)
    if not clean:
        return None
    ref = float(clean[-1].c)
    if not (ref > 0.0):
        return None
    frame = _price_frame(ref, cfg)
    if frame is None:
        return None
    tick, p0, _step = frame

    # One shared all-zero row: preload copies each column into the ring.
    empty = np.zeros(rows, dtype=np.float16)
    columns = [
        FinalizedColumn(
            epoch=0, col_seq=bar.col_seq, t0_ns=bar.t0_ns, bid=empty, ask=empty, bar=bar
        )
        for bar in _price_bars(clean, dt)
    ]
    epoch = EpochParams(
        epoch=0,
        tick=tick,
        tick_multiple=cfg.tick_multiple,
        dt_ns=dt,
        p0=p0,
        rows=rows,
    )
    return columns, epoch


# --- default (production) network seam -----------------------------------------
# Imported lazily; NEVER exercised by pytest (tests inject their own BackfillFn).


async def default_backfill_fn(
    market: str, symbol: str, *, max_cols: int, now_ns: int
) -> list[Candle]:
    """Production backfill seam: crypto klines / equity Yahoo bars -> candles.

    Best-effort and self-contained: any provider failure returns ``[]`` so the
    session degrades to a clean cold start. ``sim`` never backfills (it
    generates live data immediately)."""
    if max_cols <= 0:
        return []
    try:
        if market == "sim":
            return []
        from flowmap_server.feeds.crypto import is_crypto_market
        from flowmap_server.feeds.equity import EQUITY_MARKETS

        if is_crypto_market(market):
            return await crypto_klines(market, symbol, max_bars=max_cols, now_ns=now_ns)
        if market in EQUITY_MARKETS:
            return await _equity_candles(symbol, max_cols=max_cols)
    except Exception:  # backfill is best-effort; cold start on any error
        logger.warning("backfill failed for %s:%s; cold start", market, symbol, exc_info=True)
    return []


# Market segments that mean "derivatives" to ccxt's defaultType option. Used
# only to disambiguate a bare symbol (BTCUSDT) when a venue lists both a spot
# and a perp pair under near-identical names.
_SWAP_SEGMENTS = frozenset({"usdm", "coinm", "linear", "inverse", "swap", "perp", "futures"})


# Interval label -> its span in ns. The two the app asks for: 1 m grid columns
# and 1 h quote sparks.
_INTERVAL_NS: dict[str, int] = {"1m": 60 * 10**9, "1h": 3600 * 10**9}


async def crypto_klines(
    market: str, symbol: str, *, interval: str = "1m", max_bars: int, now_ns: int
) -> list[Candle]:
    """Crypto klines, from whichever path the venue actually has.

    The engine's hand-written REST backfill covers ``ohlcv`` for Binance only
    (``SUPPORTED_CHANNELS``). Every other venue is reachable through ccxt's
    ``fetchOHLCV``, so falling back there is the difference between a chart with
    history and a cold start on all but one of the venues.
    """
    from crocodile.crypto.client.backfill import SUPPORTED_CHANNELS

    from flowmap_server.data.venues import UnlistedSymbolError
    from flowmap_server.feeds.crypto import resolve_symbol_cached

    exchange, _, seg = market.partition("-")
    seg = seg or "spot"
    # Same translation the live feed does: a symbol in the other venue's
    # spelling must not silently cost us the native path (and with it the taker
    # split) by failing the venue's REST call. Memoized: a re-subscribe
    # or restart must not re-download the venue's whole ccxt market table.
    try:
        symbol = await resolve_symbol_cached(market, symbol)
    except UnlistedSymbolError:
        # The venue does not list the symbol: there is no kline to fetch, so
        # this is a clean cold start, not a ValueError into the kline path.
        logger.warning("%s does not list %s; no klines to backfill", market, symbol)
        return []
    kw = {"interval": interval, "max_bars": max_bars, "now_ns": now_ns}
    if "ohlcv" in SUPPORTED_CHANNELS.get(exchange, frozenset()):
        # Native first: only the venue's own klines carry the taker buy/sell
        # split, which is what makes the CVD built from the candles real rather
        # than flat. ccxt's unified OHLCV has no such column.
        try:
            native = await _native_candles(exchange, symbol, seg, **kw)
        except Exception:  # fall through to ccxt below
            logger.warning("native klines failed for %s; trying ccxt", market, exc_info=True)
        else:
            if native:
                return native
    return await _ccxt_candles(exchange, symbol, seg, **kw)


async def _native_candles(
    exchange: str, symbol: str, seg: str, *, interval: str, max_bars: int, now_ns: int
) -> list[Candle]:
    from crocodile.crypto.client.backfill import iter_backfill

    span = _INTERVAL_NS.get(interval, 60 * 10**9)
    start = now_ns - max_bars * span
    out: list[Candle] = []
    backfill_obj, session = await _hardened_backfill(exchange, seg)
    try:
        async for rec in iter_backfill(
            exchange,
            "ohlcv",
            symbol,
            start,
            now_ns,
            market=seg,
            interval=interval,
            backfill_obj=backfill_obj,
        ):
            ts = rec.source_ts if rec.source_ts is not None else rec.local_ts
            # The merged OHLCV makes the taker split optional: a venue that does
            # not report it now says None instead of a fabricated 0.0. Pass the
            # absence through — Candle already treats None as "no split", which
            # keeps CVD flat instead of drawing a fake all-sell bar.
            buy, sell = rec.buy_volume, rec.sell_volume
            out.append(
                Candle(
                    t0_ns=int(ts),
                    o=float(rec.open),
                    h=float(rec.high),
                    l=float(rec.low),
                    c=float(rec.close),
                    volume=float(rec.volume),
                    buy_volume=None if buy is None else float(buy),
                    sell_volume=None if sell is None else float(sell),
                )
            )
            if len(out) >= max_bars:
                break
    finally:
        if session is not None:
            await _await_owned(asyncio.ensure_future(session.close()))
    return out


# Binance REST bases per market segment. The engine's `make_live_backfill`
# wires klines to the SPOT base for every segment, so a usdm/coinm backfill
# would silently read spot candles; naming the base here fixes that as a
# side-effect of hardening the session.
_BINANCE_KLINE_BASE = {
    "spot": "https://api.binance.com/api/v3",
    "usdm": "https://fapi.binance.com/fapi/v1",
    "coinm": "https://dapi.binance.com/dapi/v1",
}


async def _hardened_backfill(exchange: str, seg: str) -> tuple[object | None, object | None]:
    """A backfill object whose REST session trusts the certifi CA bundle.

    Same problem `_harden_rest_ssl` solves for the live feed: on a stock macOS
    framework Python the default OpenSSL trust store cannot verify these hosts,
    and the engine's own backfill builds its session internally where that
    wrapper cannot reach. Returns ``(None, None)`` — plain engine defaults —
    for venues we have no hardening recipe for, or if certifi is unavailable.
    """
    if exchange != "binance":
        return None, None
    try:
        import functools
        import aiohttp
        import certifi

        from crocodile.crypto.exchanges.binance.backfill import (
            BinanceBackfill,
            _live_fetch_klines,
        )
    except Exception:  # keep engine defaults if anything is absent
        return None, None
    ctx = await _certifi_context(certifi.where())
    session = aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=ctx),
        timeout=aiohttp.ClientTimeout(total=_HTTP_TIMEOUT_S),
    )
    try:
        base = _BINANCE_KLINE_BASE.get(seg, _BINANCE_KLINE_BASE["spot"])
        bf = BinanceBackfill(
            fetch_aggtrades=None,
            fetch_klines=functools.partial(_live_fetch_klines, rest_base=base, session=session),
            fetch_open_interest=None,
            fetch_open_interest_hist=None,
        )
    except Exception:  # never leak the session we just opened
        await _await_owned(asyncio.ensure_future(session.close()))
        raise
    return bf, session


class _CCXTJob:
    """One exchange lifecycle, created through close on one worker-owned loop."""

    def __init__(self, fetch: Callable[[threading.Event], Awaitable[list[Candle]]]) -> None:
        self.fetch = fetch
        self.cancelled = threading.Event()
        self.owner: tuple[asyncio.AbstractEventLoop, asyncio.Task] | None = None

    def cancel(self) -> None:
        self.cancelled.set()
        owner = self.owner
        if owner is not None:
            loop, task = owner
            try:
                loop.call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass  # The owned loop finished between reading owner and dispatch.

    def run(self) -> list[Candle]:
        if self.cancelled.is_set():
            raise asyncio.CancelledError
        return asyncio.run(self._run())

    async def _run(self) -> list[Candle]:
        self.owner = asyncio.get_running_loop(), asyncio.current_task()
        try:
            if self.cancelled.is_set():
                raise asyncio.CancelledError
            return await self.fetch(self.cancelled)
        finally:
            self.owner = None


async def _ccxt_candles(
    exchange: str, symbol: str, seg: str, *, interval: str, max_bars: int, now_ns: int
) -> list[Candle]:
    job = _CCXTJob(lambda cancelled: _ccxt_candles_owned(
        exchange, symbol, seg, interval=interval, max_bars=max_bars,
        now_ns=now_ns, cancelled=cancelled,
    ))
    result = _CCXT_EXECUTOR.submit(job.run)

    def cancel() -> None:
        # Remove queued jobs; if a worker won the race, signal and drain it.
        if not result.cancel():
            job.cancel()

    return await _await_owned(asyncio.wrap_future(result), cancel=cancel)


async def _ccxt_candles_owned(
    exchange: str, symbol: str, seg: str, *, interval: str, max_bars: int,
    now_ns: int, cancelled: threading.Event,
) -> list[Candle]:
    """1-minute klines for any ccxt venue, via ``fetchOHLCV``.

    Returns ``[]`` rather than raising when the venue is not a ccxt id (the
    on-chain and CoinGecko readers), does not serve OHLCV, or does not list the
    symbol — the caller treats an empty result as a clean cold start.

    No taker split: ccxt's unified OHLCV has no buy/sell breakdown, so the
    candles carry ``None`` and the CVD built from them stays flat instead of
    inventing a direction.
    """
    from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector
    from flowmap_server.data.venues import ccxt_knows

    # `ccxt_knows`, not `factory.is_ccxt_exchange` — the latter is False for the
    # five venues that also have a native connector, and those are precisely the
    # ones whose klines we need from ccxt (the engine's own REST backfill serves
    # ohlcv for Binance alone).
    if not ccxt_knows(exchange):
        return []
    import ccxt.async_support as ccxt_async

    default_type = "swap" if seg in _SWAP_SEGMENTS else "spot"
    if cancelled.is_set():
        raise asyncio.CancelledError
    # Explicit total timeout instead of relying on ccxt's per-request
    # default — the backfill runs under the session's boot lock.
    ex = getattr(ccxt_async, exchange)(
        {
            "enableRateLimit": True,
            "timeout": _HTTP_TIMEOUT_MS,
            "options": {"defaultType": default_type},
        }
    )
    try:
        if cancelled.is_set():
            raise asyncio.CancelledError
        if not ex.has.get("fetchOHLCV"):
            return []
        table_key = (exchange, default_type)
        markets = _cached_ccxt_markets(table_key)
        if markets is None:
            markets = await ex.load_markets()
            _remember_ccxt_markets(table_key, markets)
        else:
            ex.set_markets(markets)
        if cancelled.is_set():
            raise asyncio.CancelledError
        unified = CCXTConnector._resolve_symbol(symbol, markets, ex.markets_by_id)
        if unified is None:
            logger.warning("ccxt backfill: %s does not list %r", exchange, symbol)
            return []
        span = _INTERVAL_NS.get(interval, 60 * 10**9)
        since_ms = (now_ns - max_bars * span) // 10**6
        if cancelled.is_set():
            raise asyncio.CancelledError
        rows = await ex.fetch_ohlcv(unified, interval, since=int(since_ms), limit=max_bars)
    finally:
        await _await_owned(asyncio.ensure_future(ex.close()))
    out: list[Candle] = []
    for ts_ms, o, h, l, c, vol in rows[-max_bars:]:
        if None in (ts_ms, o, h, l, c):
            continue
        out.append(
            Candle(
                t0_ns=int(ts_ms) * 10**6,
                o=float(o),
                h=float(h),
                l=float(l),
                c=float(c),
                volume=float(vol or 0.0),
            )
        )
    return out


async def _equity_candles(symbol: str, *, max_cols: int) -> list[Candle]:
    from flowmap_server.feeds._yahoo import equity_bars

    bars = await equity_bars(symbol.upper())
    out: list[Candle] = []
    for bar in bars[-max_cols:]:
        ts = bar.source_ts if bar.source_ts is not None else bar.local_ts
        if None in (bar.open, bar.high, bar.low, bar.close, bar.volume):
            continue
        out.append(
            Candle(
                t0_ns=int(ts),
                o=float(bar.open),
                h=float(bar.high),
                l=float(bar.low),
                c=float(bar.close),
                volume=float(bar.volume),
            )
        )
    return out
