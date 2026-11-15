"""Option chains of the instrument on the chart, read through Crocodile's live layer.

An option chain is not a stream here: no keyless source pushes one. It is read on request, and
what it states is one publisher's row for each contract. Which publisher depends on the
instrument, and the answer names it:

- ``cboe``: Cboe's own delayed file (fifteen minutes behind) for a US share, ETF or index. It
  states bid and ask with their sizes, the last trade, the day's volume, open interest,
  implied volatility and greeks.
- ``bybit`` and ``deribit``: a crypto venue's own options of the base coin on the chart, live.
  Bybit states sizes, greeks, volume and open interest; Deribit's summary states no size and
  no greeks, and quotes premiums in the coin.
- ``tradingview``: the aggregator's scanner, for everything else it lists (NSE and Borsa
  Istanbul underlyings, and as the fallback for a US name Cboe has no file for). It states a
  bid, an ask, a theoretical price and its own model's volatility and greeks, and nothing
  about size, volume or open interest.

A field a publisher does not state is ``null`` in the answer; nothing is filled in from
another publisher, and two publishers are never mixed in one chain.

How an instrument becomes an underlying:

- ``equity`` (US shares): the symbol itself for Cboe; for the scanner, whose tickers carry the
  listing venue, the three US venues are named as candidates in ONE request and the series
  state which of them they belong to.
- ``indices``: the index's Cboe spelling where it has one (``SP:SPX`` is ``_SPX``), else its
  scanner ticker.
- ``world-<mic>`` and the other asset markets: the scanner's own spelling of the instrument.
- a crypto venue: the base coin of the symbol (``BTCUSDT`` and ``BTC/USDT`` are ``BTC``), on the
  venue itself when it lists options and on the other one otherwise.
- the sim feed has no underlying: the answer is ``unsupported``.

A chain is one SERIES: a contract family and an expiry. An index lists several families that
expire on one day with the same strikes (``SPX`` and ``SPXW``), so a family is never merged
into another.

Every reading is cached for a short time and shared by concurrent requests: while a reading
is fresh, a screen that polls costs the source nothing, and requests that miss together share
one load. A request waits at most ``LOAD_WAIT_S`` for a load; the load itself goes on and
serves the next request. When a refresh fails or is not back in time, the last good reading is
served with ``stale`` set and its own capture time; when there is none, the next publisher is
asked, and when none answers the status is ``unreachable``.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import math
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Final

from crocodile.core.schema.enums import OptType
from crocodile.core.schema.records import OptionsChain
from crocodile.equity.universal.live.assets import SOURCE, OptionSeries, split_ticker
from crocodile.equity.universal.live.chains import (
    BYBIT_SOURCE,
    CBOE_SOURCE,
    DERIBIT_SOURCE,
    PublishedChain,
    PublishedChains,
)
from crocodile.equity.universal.live.model import LiveListing
from crocodile.equity.universal.live.sources.tradingview import ticker_of

from flowmap_server.feeds.asset_markets import asset_feed, asset_market, asset_ticker
from flowmap_server.feeds.crypto import is_crypto_market, split_market
from flowmap_server.feeds.global_equity import world_mic

__all__ = [
    "BOARD_TTL_S",
    "CBOE_INDEX_SYMBOLS",
    "CHAIN_TTL_S",
    "LOAD_WAIT_S",
    "SERIES_TTL_S",
    "US_OPTION_VENUES",
    "OptionChains",
    "close_published_chains",
    "crypto_base",
    "option_sources",
    "option_underlyings",
]

logger = logging.getLogger(__name__)

US_OPTION_VENUES: Final[tuple[str, ...]] = ("NASDAQ", "NYSE", "AMEX")
"""The scanner's codes of the US listing venues, in the order a share is looked for."""

SERIES_TTL_S: Final = 300.0
"""A listing of series changes when an expiry is added or rolls off: minutes, not seconds."""

CHAIN_TTL_S: Final = 20.0
"""How long one series' contracts are served before they are read again."""

LOAD_WAIT_S: Final = 12.0
"""How long one request waits for a reading. The screen asks again every twenty seconds, so
an answer must be back well inside that; a slower load finishes on its own and is there for
the next request."""

BOARD_TTL_S: Final = 20.0
"""How long a publisher's whole chain is served before it is read again."""

CBOE_BOARD_TTL_S: Final = 60.0
"""Cboe's file is fifteen minutes behind the market and, for an index, several megabytes:
reading it more often than once a minute buys nothing."""

CBOE_INDEX_SYMBOLS: Final[dict[str, str]] = {
    "SP:SPX": "_SPX",
    "CBOE:VIX": "_VIX",
    "TVC:VIX": "_VIX",
    "TVC:RUT": "_RUT",
}
"""The indices of the ``indices`` market that Cboe publishes a chain for, by its spelling.
Each was read on 2026-11-12. The Dow is absent on purpose: Cboe's Dow options (``_DJX``) are
written on one hundredth of the index, which is not the instrument on the chart."""

_PUBLISHER_LABEL: Final[dict[str, str]] = {
    CBOE_SOURCE: "cboe",
    BYBIT_SOURCE: "bybit",
    DERIBIT_SOURCE: "deribit",
    SOURCE: SOURCE,
}
_QUOTE_COINS: Final[tuple[str, ...]] = ("FDUSD", "USDT", "USDC", "USD", "EUR", "TRY")
"""Quote coins a symbol written without a separator ends in, longest first. ``TUSD`` and
``BUSD`` are left out on purpose: ``XBTUSD`` would read as ``XB`` quoted in ``TUSD``."""

_COIN_ALIASES: Final[dict[str, str]] = {"XBT": "BTC", "XDG": "DOGE"}
"""Venue spellings of a coin that the option venues spell the usual way."""
_COIN = re.compile(r"[A-Z0-9]{2,10}")
_CBOE_SHARE = re.compile(r"[A-Z0-9]{1,6}(\.[A-Z]{1,2})?")

_MAX_ENTRIES: Final = 64

SeriesFn = Callable[[Sequence[str]], Awaitable[list[OptionSeries]]]
ChainFn = Callable[[str, date, str], Awaitable[list[OptionsChain]]]
BoardFn = Callable[[str, str], Awaitable[PublishedChain]]
"""``(publisher, underlying)`` to that publisher's whole chain."""


def option_underlyings(market: str, symbol: str) -> tuple[str, ...]:
    """The scanner tickers this instrument's options may be listed under; empty when the
    market has no ticker the source spells."""
    spelled = symbol.strip()
    if not spelled:
        return ()
    if market == "equity":
        if ":" in spelled:
            # A US share is named without its venue; a full ticker is not a share symbol.
            return ()
        candidates = tuple(f"{venue}:{spelled.upper()}" for venue in US_OPTION_VENUES)
    else:
        mic = world_mic(market)
        named = asset_market(market)
        if mic is not None:
            ticker = ticker_of(LiveListing(mic=mic, local_symbol=spelled))
            candidates = (ticker,) if ticker is not None else ()
        elif named is not None:
            try:
                candidates = (asset_ticker(named[0], named[1], spelled),)
            except ValueError:
                return ()
        else:
            return ()
    try:
        for ticker in candidates:
            split_ticker(ticker)
    except ValueError:
        return ()
    return candidates


def crypto_base(symbol: str) -> str | None:
    """The base coin a crypto symbol names: ``BTCUSDT``, ``BTC/USDT``, ``BTC-PERPETUAL`` and
    ``BTC-USDT-SWAP`` are all ``BTC``. ``None`` when no coin can be read off it."""
    spelled = symbol.strip().upper()
    head = re.split(r"[/\-_:]", spelled, maxsplit=1)[0]
    # A head that still ends in a quote coin is a pair written together (``BTCUSDT``, and the
    # ``BTCUSD`` of ``BTCUSD_PERP``). A coin whose own name ends that way (``SUSD``) is kept:
    # stripping it would leave less than a coin.
    for quote in _QUOTE_COINS:
        if head.endswith(quote) and len(head) - len(quote) >= 2:
            head = head[: -len(quote)]
            break
    head = _COIN_ALIASES.get(head, head)
    return head if _COIN.fullmatch(head) else None


def option_sources(market: str, symbol: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """The publishers to ask for this instrument's options, in order, each with what it is
    asked for. Empty when no publisher spells the instrument."""
    spelled = symbol.strip()
    plan: list[tuple[str, tuple[str, ...]]] = []
    if not spelled or market == "sim":
        return ()
    if is_crypto_market(market):
        base = crypto_base(spelled)
        if base is None:
            return ()
        venue = split_market(market)[0]
        order = (DERIBIT_SOURCE, BYBIT_SOURCE) if venue == "deribit" else (BYBIT_SOURCE, DERIBIT_SOURCE)
        return tuple((publisher, (base,)) for publisher in order)
    if market == "equity" and _CBOE_SHARE.fullmatch(spelled.upper()):
        plan.append((CBOE_SOURCE, (spelled.upper(),)))
    elif market == "indices" and spelled in CBOE_INDEX_SYMBOLS:
        plan.append((CBOE_SOURCE, (CBOE_INDEX_SYMBOLS[spelled],)))
    scanner = option_underlyings(market, spelled)
    if scanner:
        plan.append((SOURCE, scanner))
    return tuple(plan)


_PUBLISHED: PublishedChains | None = None


def _published() -> PublishedChains:
    global _PUBLISHED
    if _PUBLISHED is None:
        _PUBLISHED = PublishedChains()
    return _PUBLISHED


async def close_published_chains() -> None:
    """Close the process-wide publisher client (app shutdown, smoke scripts)."""
    global _PUBLISHED
    client, _PUBLISHED = _PUBLISHED, None
    if client is not None:
        await client.close()


async def _default_board(publisher: str, underlying: str) -> PublishedChain:
    client = _published()
    if publisher == CBOE_SOURCE:
        return await client.cboe(underlying)
    if publisher == BYBIT_SOURCE:
        return await client.bybit(underlying)
    if publisher == DERIBIT_SOURCE:
        return await client.deribit(underlying)
    raise ValueError(f"unknown option publisher {publisher!r}")


async def _default_series(underlyings: Sequence[str]) -> list[OptionSeries]:
    return await asset_feed().option_series(underlyings)


async def _default_chain(underlying: str, expiry: date, root: str) -> list[OptionsChain]:
    return await asset_feed().option_chain(underlying, expiry=expiry, root=root)


@dataclass(frozen=True, slots=True)
class _Entry[V]:
    value: V
    loaded_at: float
    """Monotonic seconds: decides freshness."""

    captured_ms: int
    """Wall-clock milliseconds: what the screen shows as the reading's time."""


class _Shelf[K: Hashable, V]:
    """A small TTL cache whose concurrent misses share one load.

    The load runs as its own task, so a caller that goes away (a closed dialog cancels its
    request) does not cancel the reading the next caller is waiting for.
    """

    def __init__(
        self,
        ttl_s: float,
        *,
        now_fn: Callable[[], float],
        wall_ms_fn: Callable[[], int],
        max_entries: int = _MAX_ENTRIES,
        wait_s: float = LOAD_WAIT_S,
    ) -> None:
        self._ttl_s = ttl_s
        self._wait_s = wait_s
        self._now = now_fn
        self._wall_ms = wall_ms_fn
        self._max = max_entries
        self._entries: OrderedDict[K, _Entry[V]] = OrderedDict()
        self._loading: dict[K, asyncio.Task[_Entry[V]]] = {}

    async def get(self, key: K, load: Callable[[], Awaitable[V]]) -> tuple[_Entry[V], bool]:
        """The entry of ``key`` and whether it is stale (a refresh failed, or was not back
        within the wait, and this is the last good reading). Raises the load's error, or
        ``TimeoutError``, when there is no reading at all."""
        entry = self._entries.get(key)
        if entry is not None and self._now() - entry.loaded_at < self._ttl_s:
            self._entries.move_to_end(key)
            return entry, False
        task = self._loading.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key, load))
            self._loading[key] = task
            task.add_done_callback(functools.partial(self._settle, key))
        try:
            return await asyncio.wait_for(asyncio.shield(task), self._wait_s), False
        except Exception:
            if entry is None:
                raise
            logger.debug("option refresh failed for %r; serving the last reading", key, exc_info=True)
            return entry, True

    async def _load(self, key: K, load: Callable[[], Awaitable[V]]) -> _Entry[V]:
        value = await load()
        entry = _Entry(value=value, loaded_at=self._now(), captured_ms=self._wall_ms())
        self._entries[key] = entry
        self._entries.move_to_end(key)
        while len(self._entries) > self._max:
            self._entries.popitem(last=False)
        return entry

    def forget(self, key: K) -> None:
        """Drop a reading that turned out to be out of date, so the next request reads anew."""
        self._entries.pop(key, None)

    def _settle(self, key: K, task: asyncio.Task[_Entry[V]]) -> None:
        if self._loading.get(key) is task:
            del self._loading[key]
        if not task.cancelled():
            task.exception()  # retrieved here, so an unawaited failure is not logged as lost


def _finite(value: float | None) -> float | None:
    return value if value is not None and math.isfinite(value) else None


def _side(record: OptionsChain) -> dict[str, object]:
    return {
        "symbol": record.symbol,
        "bid": _finite(record.bid_px),
        "bidSize": _finite(record.bid_sz),
        "ask": _finite(record.ask_px),
        "askSize": _finite(record.ask_sz),
        "last": _finite(record.last_price),
        "theo": _finite(record.mark_price),
        "iv": _finite(record.mark_iv),
        "volume": _finite(record.volume),
        "openInterest": _finite(record.open_interest),
        "delta": _finite(record.delta),
        "gamma": _finite(record.gamma),
        "theta": _finite(record.theta),
        "vega": _finite(record.vega),
        "rho": _finite(record.rho),
    }


def _strike_rows(records: Sequence[OptionsChain]) -> list[dict[str, object]]:
    """One row per strike, ascending, with the call and the put the series lists there. A
    strike often lists one side only; the other stays ``None``."""
    rows: dict[float, dict[str, object]] = {}
    repeated: list[str] = []
    for record in records:
        if not math.isfinite(record.strike):
            continue
        row = rows.setdefault(record.strike, {"strike": record.strike, "call": None, "put": None})
        side = "call" if record.opt_type is OptType.CALL else "put"
        if row[side] is None:
            row[side] = _side(record)
        else:
            repeated.append(record.symbol)
    if repeated:
        # One series lists one call and one put per strike. A second one has no cell to go
        # to; it is named here rather than dropped without a trace.
        logger.warning(
            "option series lists %d contract(s) twice at a strike; not shown: %s",
            len(repeated),
            ", ".join(repeated[:8]),
        )
    return [rows[strike] for strike in sorted(rows)]


def _series_json(series: OptionSeries) -> dict[str, object]:
    return {"root": series.root, "expiry": series.expiry.isoformat(), "contracts": series.contracts}


def _pick(
    series: Sequence[OptionSeries], expiry: date | None, root: str | None
) -> OptionSeries:
    """The series a request names, or the one nearest to it.

    Without an expiry that is the first expiry (of the named family, when one is named). With
    an expiry the listing no longer has (it rolled off), it is the listed expiry closest to
    that day, the earlier one on a tie. A family the listing does not have is ignored. The
    answer's ``selected`` always says which series the strikes belong to.
    """
    ordered = sorted(series, key=lambda item: (item.expiry, -item.contracts, item.root))
    family = [item for item in ordered if item.root == root] if root is not None else []
    pool = family or ordered
    if expiry is None:
        return pool[0]
    for candidates in (pool, ordered):
        on_day = [item for item in candidates if item.expiry == expiry]
        if on_day:
            return on_day[0]
    return min(pool, key=lambda item: (abs((item.expiry - expiry).days), item.expiry))


@dataclass(frozen=True, slots=True)
class _Listing:
    """What one publisher lists for the instrument: its series, and how to read one."""

    publisher: str
    underlying: str
    series: list[OptionSeries]
    captured_ms: int
    stale: bool
    underlying_price: float | None = None
    premium_unit: str | None = None
    delay_s: int | None = None
    board: PublishedChain | None = None
    """The whole chain, when the publisher sends it in one answer."""

    candidates: tuple[str, ...] = ()
    """The scanner tickers the listing was asked under (its cache key)."""


class OptionChains:
    """The option series and chains the ``/api/options`` route serves."""

    def __init__(
        self,
        *,
        series_fn: SeriesFn | None = None,
        chain_fn: ChainFn | None = None,
        board_fn: BoardFn | None = None,
        now_fn: Callable[[], float] = time.monotonic,
        wall_ms_fn: Callable[[], int] | None = None,
        series_ttl_s: float = SERIES_TTL_S,
        chain_ttl_s: float = CHAIN_TTL_S,
        board_ttl_s: float = BOARD_TTL_S,
        cboe_ttl_s: float = CBOE_BOARD_TTL_S,
        load_wait_s: float = LOAD_WAIT_S,
    ) -> None:
        self._series_fn: SeriesFn = series_fn if series_fn is not None else _default_series
        self._chain_fn: ChainFn = chain_fn if chain_fn is not None else _default_chain
        self._board_fn: BoardFn = board_fn if board_fn is not None else _default_board
        wall = wall_ms_fn if wall_ms_fn is not None else (lambda: time.time_ns() // 1_000_000)
        self._series: _Shelf[tuple[str, ...], list[OptionSeries]] = _Shelf(
            series_ttl_s, now_fn=now_fn, wall_ms_fn=wall, wait_s=load_wait_s
        )
        self._chains: _Shelf[tuple[str, date, str], list[OptionsChain]] = _Shelf(
            chain_ttl_s, now_fn=now_fn, wall_ms_fn=wall, wait_s=load_wait_s
        )
        # A whole chain is large (an index is tens of thousands of contracts), so few are kept;
        # enough that looking at a handful of other names does not push an index out and force
        # its file to be read again.
        self._boards: _Shelf[tuple[str, str], PublishedChain] = _Shelf(
            board_ttl_s, now_fn=now_fn, wall_ms_fn=wall, wait_s=load_wait_s, max_entries=8
        )
        self._cboe: _Shelf[tuple[str, str], PublishedChain] = _Shelf(
            cboe_ttl_s, now_fn=now_fn, wall_ms_fn=wall, wait_s=load_wait_s, max_entries=16
        )

    async def _listing(self, publisher: str, asked: tuple[str, ...]) -> _Listing | None:
        """What ``publisher`` lists for the instrument, or ``None`` when it lists nothing.
        Raises when the publisher cannot be read and there is no earlier reading."""
        if publisher == SOURCE:
            listed, stale = await self._series.get(asked, lambda: self._series_fn(asked))
            # A share listed on one US venue answers under that venue only. Should two
            # candidates both list options, the first in venue order is the instrument's.
            underlying = next(
                (ticker for ticker in asked if any(s.underlying == ticker for s in listed.value)),
                None,
            )
            if underlying is None:
                return None
            return _Listing(
                publisher=publisher,
                underlying=underlying,
                series=[item for item in listed.value if item.underlying == underlying],
                captured_ms=listed.captured_ms,
                stale=stale,
                candidates=asked,
            )
        shelf = self._cboe if publisher == CBOE_SOURCE else self._boards
        key = (publisher, asked[0])
        entry, stale = await shelf.get(key, lambda: self._board_fn(publisher, asked[0]))
        board = entry.value
        series = board.series()
        if not series:
            return None
        return _Listing(
            publisher=publisher,
            underlying=board.underlying,
            series=series,
            captured_ms=entry.captured_ms,
            stale=stale,
            underlying_price=_finite(board.underlying_price),
            premium_unit=board.premium_unit,
            delay_s=board.delay_s,
            board=board,
        )

    async def view(
        self, market: str, symbol: str, *, expiry: date | None = None, root: str | None = None
    ) -> dict[str, object]:
        """The JSON body of one ``/api/options`` answer. Never raises for a provider fault."""
        answer: dict[str, object] = {
            "market": market,
            "symbol": symbol,
            "status": "unsupported",
            "underlying": None,
            "underlyingPrice": None,
            "premiumUnit": None,
            "delayS": None,
            "series": [],
            "selected": None,
            "strikes": [],
            "capturedMs": None,
            "stale": False,
            "source": SOURCE,
        }
        if market == 'futures-eurex-official':
            answer['source'] = 'eurex_delayed_posttrade'
            return answer
        plan = option_sources(market, symbol)
        if not plan:
            return answer
        failed = False
        for publisher, asked in plan:
            try:
                listing = await self._listing(publisher, asked)
            except Exception:  # a provider fault moves on to the next publisher, never a 500
                logger.debug("option listing failed: %s %s", publisher, asked, exc_info=True)
                failed = True
                continue
            if listing is not None:
                return await self._fill(answer, listing, expiry, root)
        answer["status"] = "unreachable" if failed else "none"
        return answer

    async def _fill(
        self, answer: dict[str, object], listing: _Listing, expiry: date | None, root: str | None
    ) -> dict[str, object]:
        chosen = _pick(listing.series, expiry, root)
        ordered = sorted(listing.series, key=lambda item: (item.expiry, item.root))
        answer["source"] = _PUBLISHER_LABEL.get(listing.publisher, listing.publisher)
        answer["underlying"] = listing.underlying
        answer["underlyingPrice"] = listing.underlying_price
        answer["premiumUnit"] = listing.premium_unit
        answer["delayS"] = listing.delay_s
        answer["series"] = [_series_json(item) for item in ordered]
        answer["selected"] = {"root": chosen.root, "expiry": chosen.expiry.isoformat()}
        if listing.board is not None:
            records = listing.board.of_series(chosen.expiry, chosen.root)
            captured_ms, stale = listing.captured_ms, listing.stale
        else:
            key = (listing.underlying, chosen.expiry, chosen.root)
            try:
                chain, chain_stale = await self._chains.get(
                    key, lambda: self._chain_fn(listing.underlying, chosen.expiry, chosen.root)
                )
            except Exception:  # the series are known, their contracts could not be read
                logger.debug("option chain failed for %s %s", listing.underlying, chosen, exc_info=True)
                answer["status"] = "unreachable"
                return answer
            if not chain.value and not chain_stale:
                # The listing named a series that has no contracts any more (its expiry passed
                # while the listing was cached): read the listing anew on the next request.
                self._series.forget(listing.candidates)
            records = chain.value
            captured_ms, stale = chain.captured_ms, listing.stale or chain_stale
        answer["status"] = "ok"
        answer["strikes"] = _strike_rows(records)
        answer["capturedMs"] = captured_ms
        answer["stale"] = stale
        return answer
