"""Futures, currencies, indices and government bonds, through Crocodile's asset layer.

Four venues beside the stock exchanges of ``world``:

``futures-<venue>``  one derivatives exchange, by the scanner's venue code in lower case
                     (``futures-eurex``, ``futures-cme_mini``, ``futures-bist``). The symbol is
                     the contract as the venue spells it: ``FDAX1!`` for the continuous front
                     contract, ``ESZ2026`` for a dated one.
``forex``            a currency pair of the composite feed: ``EURUSD``.
``indices``          an index or a commodity benchmark, by its full ticker: ``SP:SPX``,
                     ``BIST:XU100``.
``bonds``            a government bond or its yield: ``US10Y``.

None of these has a public order book, so every one of them is the ``SYNTH`` tier and says so:
the depth on screen is a profile built from the session's one-minute bars, split at the last
price. For a future the profile is volume at price. A currency pair, an index and a bond
yield have no traded volume in any public bar, so their profile is **time at price**: each
minute counts once at the price it traded around. ``capability["profile_basis"]`` states
which (``volume`` or ``time``), and the badge stays ``SYNTH`` either way.

Where the chart source has no bars for an instrument (a future outside the US venues, a dated
contract, a bond yield), the profile starts from the session's own figures and grows from the
polls themselves: for a future the session-volume change between two polls at the price the
scanner reported it, for the other kinds the time between two polls at the polled price.
Such an instrument has no reconstructed history either: the picture starts when it is opened.

There is no per-venue calendar for these instruments, so the session is read from two facts:

- the currency market's week: closed from Friday 22:00 UTC to Sunday 22:00 UTC, with the
  reopening as the countdown;
- the chart itself: an instrument whose newest one-minute bar is more than ninety minutes old
  is not trading (an index after its exchange closed, a future on a holiday). It is shown
  closed, with its last session and no countdown, because nothing here knows when it reopens.

The trading day rolls at 22:00 UTC, the hour the currency and the US futures day turn.

A price that is not positive has no place on this chart: a bond whose yield is negative is read
as having no price, and shows none.
"""

from __future__ import annotations

import datetime
import functools
import logging
import math
import zoneinfo
from collections.abc import Awaitable, Callable, Sequence

from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV as EqBar
from crocodile.equity.universal.live.assets import (
    DEFAULT_VENUE,
    AssetFeed,
    AssetKind,
    AssetQuote,
    known_venues,
    split_ticker,
    yahoo_symbol_for,
)
from crocodile.equity.universal.live.model import LiveLevel, LiveListing, LiveSnapshot, LiveTier

from flowmap_server.config import Config
from flowmap_server.core.backfill import Candle
from flowmap_server.feeds.base import DropCounters
from flowmap_server.feeds.equity_synth import SynthEquityFeed
from flowmap_server.feeds.equity_profile import (
    PROFILE_PEAK_TARGET,
    _bar_finite,
    _bar_ts,
    _ProfileBuilder,
    _typical_price,
)
from flowmap_server.feeds.global_equity import (
    GlobalEquityFeed,
    world_backfill_fn,
    world_capability,
)
from flowmap_server.proto.events import SIDE_SRC_NA, SIDE_UNKNOWN, Trade

__all__ = [
    "ASSET_BOARD_LIMIT",
    "ASSET_VENUES",
    "AssetMarketFeed",
    "asset_board",
    "asset_backfill_fn",
    "asset_feed",
    "asset_market",
    "asset_market_labels",
    "asset_market_strings",
    "asset_symbol",
    "asset_ticker",
    "close_asset_feed",
    "is_asset_market",
    "reset_asset_state",
]

logger = logging.getLogger(__name__)

ASSET_VENUES: dict[str, AssetKind] = {
    "futures": AssetKind.FUTURE,
    "forex": AssetKind.FOREX,
    "indices": AssetKind.INDEX,
    "bonds": AssetKind.BOND,
}
_FUTURES_PREFIX = "futures-"
# Kinds whose public bars carry no traded volume: their profile is time at price.
_TIME_PROFILE_KINDS = frozenset({AssetKind.FOREX, AssetKind.INDEX, AssetKind.BOND})
_WEEK_CLOSE_HOUR_UTC = 22
_DAY_ROLL = datetime.timedelta(hours=24 - _WEEK_CLOSE_HOUR_UTC)
# A chart whose newest minute is older than this is a market that is not trading. Longer than
# the US futures' daily one-hour halt plus the chart's own delay, so the halt is not a close.
_QUIET_NS = 90 * 60 * 10**9
# The longest stretch one poll may claim as time at its price: a missed poll is not an hour.
_MAX_POLL_WEIGHT_MIN = 1.0
_SYNTH_VENUE = "synthetic"
_MINUTE = "1m"

# The most rows one board request asks for. Every board is read whole, so a search finds an
# instrument wherever the scanner happens to rank it: the largest venue measured (Eurex,
# 19,385 contracts on 2026-11-12) answers in one request, and the cap sits above it.
ASSET_BOARD_LIMIT = 25_000
_KIND_WORDS = {
    AssetKind.FOREX: "Currency pairs (composite quotes)",
    AssetKind.INDEX: "Indices and benchmarks",
    AssetKind.BOND: "Government bonds and yields",
}

# The pairs a currency listing opens with. The composite feed has no volume to rank by, so
# without a head the list would open on whatever the scanner returns first. Display order
# only: every pair is listed, and a pair named here that the scanner does not list is not.
_FOREX_HEAD = (
    "EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP", "EURJPY",
    "GBPJPY", "EURCHF", "USDTRY", "EURTRY", "USDCNH", "USDMXN", "USDZAR", "USDINR", "USDBRL",
)
_BENCHMARK_TENOR = "10Y"
_CRYPTO_INDEX_VENUE = "CRYPTOCAP"

SnapshotFn = Callable[[], Awaitable[LiveSnapshot | None]]


def _listing_order(kind: AssetKind, rows: list[AssetQuote]) -> list[AssetQuote]:
    """The order a market's instruments are listed in.

    Futures keep the scanner's order, most traded first. The other kinds have no volume to
    rank by: currencies open with the major pairs, indices with the ones that have a chart
    here (the national benchmarks) and close with the crypto market-cap series, bonds open
    with the ten-year benchmarks. Within each group the order is alphabetical.
    """
    if kind is AssetKind.FUTURE:
        return rows
    if kind is AssetKind.FOREX:
        rank = {symbol: index for index, symbol in enumerate(_FOREX_HEAD)}
        return sorted(rows, key=lambda row: (rank.get(row.symbol, len(rank)), row.symbol))
    if kind is AssetKind.INDEX:
        return sorted(
            rows,
            key=lambda row: (
                yahoo_symbol_for(kind, row.ticker) is None,
                row.venue == _CRYPTO_INDEX_VENUE,
                row.ticker,
            ),
        )
    return sorted(rows, key=lambda row: (not row.symbol.endswith(_BENCHMARK_TENOR), row.symbol))


@functools.cache
def _venue_counts(kind: AssetKind) -> dict[str, int]:
    """The venues Crocodile measured for a kind, with the instrument count of each."""
    return dict(known_venues(kind))


def asset_market(market: str) -> tuple[AssetKind, str | None] | None:
    """The kind and venue a market string names, or ``None`` when it is not an asset market."""
    lowered = market.lower()
    if lowered == 'futures-eurex-official':
        return None
    if lowered.startswith(_FUTURES_PREFIX):
        venue = lowered[len(_FUTURES_PREFIX) :].upper()
        return (AssetKind.FUTURE, venue) if venue in _venue_counts(AssetKind.FUTURE) else None
    kind = ASSET_VENUES.get(lowered)
    if kind is None or kind is AssetKind.FUTURE:
        return None
    return kind, DEFAULT_VENUE.get(kind)


def is_asset_market(market: str) -> bool:
    return asset_market(market) is not None


def asset_market_strings() -> list[str]:
    """Every asset market this build offers, in catalogue order."""
    futures = [_FUTURES_PREFIX + venue.lower() for venue in sorted(_venue_counts(AssetKind.FUTURE))]
    return [*futures, "forex", "indices", "bonds"]


def asset_market_labels() -> dict[str, str]:
    """Market string to a readable name, for the picker (``futures-eurex`` says little alone)."""
    out: dict[str, str] = {}
    for venue, count in sorted(_venue_counts(AssetKind.FUTURE).items()):
        out[_FUTURES_PREFIX + venue.lower()] = f"{venue} futures ({count} contracts)"
    for market, kind in ASSET_VENUES.items():
        if kind is not AssetKind.FUTURE:
            out[market] = _KIND_WORDS[kind]
    return out


def asset_symbol(quote: AssetQuote) -> str:
    """The symbol a board row is subscribed by in its market: an index by its full ticker
    (indices come from many venues), everything else by the venue's own symbol."""
    return quote.ticker if quote.kind is AssetKind.INDEX else quote.symbol


async def asset_board(market: str) -> list[AssetQuote]:
    """Every instrument of one asset market as the scanner lists it, in listing order (see
    :func:`_listing_order`).

    Empty for a market string that names no asset market. Rows the scanner repeats are
    returned once.
    """
    if market == 'futures-eurex-official':
        return []
    named = asset_market(market)
    if named is None:
        return []
    kind, venue = named
    # A venue's board is sized by the count measured for it. A kind without a venue (indices)
    # is scanned across its whole market and filtered afterwards, so it asks for the cap.
    known = _venue_counts(kind).get(venue, 0) if venue is not None else 0
    limit = max(1, min(known or ASSET_BOARD_LIMIT, ASSET_BOARD_LIMIT))
    rows = await asset_feed().board(kind, venue, limit=limit)
    seen: set[str] = set()
    out: list[AssetQuote] = []
    for row in rows:
        if row.ticker not in seen:
            seen.add(row.ticker)
            out.append(row)
    return _listing_order(kind, out)


def asset_ticker(kind: AssetKind, venue: str | None, symbol: str) -> str:
    """The scanner ticker of a market's symbol. An index symbol is already a full ticker."""
    spelled = symbol.strip()
    ticker = spelled if venue is None else f"{venue}:{spelled}"
    try:
        split_ticker(ticker)
    except ValueError as exc:
        hint = " (an index is named by its full ticker, e.g. SP:SPX)" if venue is None else ""
        raise ValueError(f"invalid {kind.value} symbol {symbol!r}{hint}") from exc
    return ticker


_ASSETS: AssetFeed | None = None
# The newest one-minute bar each ticker's chart has shown, by whoever read it last (the
# backfill reads it before the feed is asked whether its market is closed).
_NEWEST_BAR_NS: dict[str, int] = {}


def _note_bars(ticker: str, stamps: Sequence[int]) -> None:
    newest = max(stamps, default=0)
    if newest > 0:
        _NEWEST_BAR_NS[ticker] = newest


def reset_asset_state() -> None:
    """Forget what the charts have shown (tests)."""
    _NEWEST_BAR_NS.clear()


def asset_feed() -> AssetFeed:
    """The process-wide Crocodile asset feed."""
    global _ASSETS
    if _ASSETS is None:
        _ASSETS = AssetFeed()
    return _ASSETS


async def close_asset_feed() -> None:
    global _ASSETS
    feed, _ASSETS = _ASSETS, None
    if feed is not None:
        await feed.close()


def snapshot_of(quote: AssetQuote) -> LiveSnapshot:
    """A scanner row in the shape the world feed's loop reads.

    The listing slot holds only the symbol: an asset is not a listing of an allow-listed
    exchange, and nothing downstream reads that slot. A currency pair's bid and ask carry no
    size, so they are levels without one and never become a book.
    """
    return LiveSnapshot(
        source="tradingview",
        listing=LiveListing(mic="", local_symbol=quote.symbol),
        symbol_raw=quote.ticker,
        captured_ns=quote.captured_ns,
        last=quote.last,
        prev_close=quote.prev_close,
        open=quote.open,
        high=quote.high,
        low=quote.low,
        volume=quote.volume,
        bids=(LiveLevel(quote.bid, None),) if quote.bid is not None else (),
        asks=(LiveLevel(quote.ask, None),) if quote.ask is not None else (),
        currency=quote.currency,
        price_scale=quote.price_scale,
        delay_s=quote.delay_s,
        name=quote.name,
    )


async def asset_backfill_fn(
    market: str, symbol: str, *, max_cols: int, now_ns: int
) -> Sequence[Candle]:
    """The app's backfill seam: asset markets here, every other market as before.

    An asset market gets the session's one-minute bars of the instrument as backfill candles;
    empty when the chart source does not spell it or cannot be read, which is a clean cold
    start. A kind whose bars carry no volume is given the same weight for every bar, so its
    reconstructed history is the same time-at-price reading its live profile is. The weight
    is the peak the live profile is normalised to: time at price has no unit of its own, and
    this one puts a minute of history on the scale the live columns are drawn in.
    """
    if market == 'futures-eurex-official':
        return []
    named = asset_market(market)
    if named is None:
        return await world_backfill_fn(market, symbol, max_cols=max_cols, now_ns=now_ns)
    if max_cols <= 0:
        return []
    kind, venue = named
    try:
        ticker = asset_ticker(kind, venue, symbol)
        bars = await asset_feed().minute_bars(kind, ticker)
    except Exception:  # backfill is best-effort; cold start on any error
        logger.warning("asset backfill failed for %s:%s; cold start", market, symbol, exc_info=True)
        return []
    _note_bars(ticker, [bar.ts_ns for bar in bars])
    timed = kind in _TIME_PROFILE_KINDS
    return [
        Candle(
            t0_ns=bar.ts_ns,
            o=bar.open,
            h=bar.high,
            l=bar.low,
            c=bar.close,
            volume=PROFILE_PEAK_TARGET if timed else bar.volume,
        )
        for bar in bars[-max_cols:]
    ]


class _TimeProfileBuilder(_ProfileBuilder):
    """Time at price: every finite bar counts once, whatever its volume.

    A minute bar counts at its typical price. The session's own bar, the fallback when there
    are no minutes, counts at its close: of a whole session only the last price is a price
    the instrument is known to have spent time at.
    """

    def add_bar(self, bar: EqBar) -> bool:
        if not _bar_finite(bar):
            return False
        price = _typical_price(bar) if bar.interval == _MINUTE else float(bar.close)
        return self.add_volume(price, 1.0)


class AssetMarketFeed(GlobalEquityFeed):
    """One future, currency pair, index or bond (implements the Feed protocol).

    A subclass of the world feed for its loop (warmup, polling, tape rules, the closed-market
    print) and nothing of its exchange identity: there is no MIC, no listing and no exchange
    calendar here, so the constructor builds on :class:`SynthEquityFeed` directly.
    """

    def __init__(
        self,
        symbol: str,
        market: str,
        cfg: Config,
        *,
        assets: AssetFeed | None = None,
        now_ns_fn: Callable[[], int] | None = None,
        bars_fn: Callable[[], Awaitable[Sequence[EqBar]]] | None = None,
        snapshot_fn: SnapshotFn | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
        stats: DropCounters | None = None,
    ) -> None:
        named = asset_market(market)
        if named is None:
            raise NotImplementedError(f"market {market!r} is not an asset market")
        SynthEquityFeed.__init__(
            self, symbol, cfg, now_ns_fn=now_ns_fn, bars_fn=bars_fn, sleep_fn=sleep_fn, stats=stats
        )
        self.kind, self.venue = named
        self.market = market.lower()
        self.symbol = symbol.strip()
        # The empty symbol is the directory's capability probe, as it is for every feed.
        self.ticker = asset_ticker(self.kind, self.venue, self.symbol) if self.symbol else ""
        self.mic = self.market
        self._tz = zoneinfo.ZoneInfo("UTC")
        self._assets = assets
        self._snapshot_fn = snapshot_fn
        self.live_tier = LiveTier.LAST
        timed = self.kind in _TIME_PROFILE_KINDS
        self.capability = world_capability(LiveTier.LAST)
        self.capability.update(
            {
                "exchange_tz": "UTC",
                "instrument_kind": self.kind.value,
                "profile_basis": "time" if timed else "volume",
            }
        )
        # Whether the chart source has minute bars for this instrument. Without them the
        # profile grows from the polls (see ``_on_snapshot``).
        self._chart_bars = False
        self._reset_tape_state()

    def _reset_tape_state(self) -> None:
        """A fresh stream also forgets the last poll: the first poll of a stream that is
        opened again must not claim the hours since the previous one as time or volume."""
        super()._reset_tape_state()
        self._last_poll_ns: int | None = None
        self._last_profile_volume: float | None = None

    # -- identity / session ---------------------------------------------------------

    def _record_symbol(self) -> str:
        return self.ticker

    def _make_builder(self) -> _ProfileBuilder:
        if self.kind in _TIME_PROFILE_KINDS:
            return _TimeProfileBuilder(self._profile_tick)
        return _ProfileBuilder(self._profile_tick)

    def _et_date(self, ts_ns: int) -> datetime.date:  # type: ignore[override]
        """The trading day of a stamp: it rolls at 22:00 UTC, not at midnight."""
        stamp = datetime.datetime.fromtimestamp(ts_ns / 1e9, tz=datetime.timezone.utc)
        return (stamp + _DAY_ROLL).date()

    def _stale_profile_date(self, last_bar_ts: int, now: int) -> datetime.date | None:
        """Never: a market that trades round the clock has no earlier session to mistake for
        today's, and one that stopped trading is closed by its quiet chart instead."""
        return None

    def _session_state(self, now_ns: int) -> tuple[str, int | None]:
        now = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=datetime.timezone.utc)
        weekday, hour = now.weekday(), now.hour
        weekend = (
            weekday == 5
            or (weekday == 4 and hour >= _WEEK_CLOSE_HOUR_UTC)
            or (weekday == 6 and hour < _WEEK_CLOSE_HOUR_UTC)
        )
        if weekend:
            days_to_sunday = (6 - weekday) % 7
            opens = (now + datetime.timedelta(days=days_to_sunday)).replace(
                hour=_WEEK_CLOSE_HOUR_UTC, minute=0, second=0, microsecond=0
            )
            return "closed", int(opens.timestamp() * 1e9)
        newest = _NEWEST_BAR_NS.get(self.ticker)
        if newest is not None and now_ns - newest > _QUIET_NS:
            return "closed", None
        return "open", None

    # -- data seams -------------------------------------------------------------------

    def _asset_feed(self) -> AssetFeed:
        return self._assets if self._assets is not None else asset_feed()

    async def _default_fetch_bars(self) -> Sequence[EqBar]:
        now = self._now_ns()
        bars = await self._asset_feed().minute_bars(self.kind, self.ticker)
        return [
            EqBar(
                "yahoo_chart",
                self.ticker,
                self.ticker,
                now,
                AssetClass.EQUITY,
                bar.ts_ns,
                interval="1m",
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=bar.volume,
            )
            for bar in bars
        ]

    async def _fetch_bars(self) -> Sequence[EqBar]:
        bars = await super()._fetch_bars()
        minutes = [_bar_ts(bar) for bar in bars if bar.interval == _MINUTE]
        self._chart_bars = bool(minutes)
        _note_bars(self.ticker, minutes)
        return bars

    async def _refresh_bars(self) -> Sequence[EqBar]:
        bars = await super()._refresh_bars()
        minutes = [_bar_ts(bar) for bar in bars if bar.interval == _MINUTE]
        if minutes:
            # The chart answers after all (a failed warmup, a contract that just began to
            # trade): from here its minutes grow the profile, and the polls must stop, or
            # every minute would be counted twice.
            self._chart_bars = True
        _note_bars(self.ticker, minutes)
        return bars

    async def _session_bar(self) -> EqBar | None:
        """The session's own bar. A kind without traded volume still has one: its figures
        with no volume, which the time profile counts once at the last price."""
        bar = await super()._session_bar()
        snapshot = self._session_bar_snapshot
        if snapshot is not None:
            # What the session bar counted is counted: the first live poll adds only what
            # came after this snapshot.
            self._last_poll_ns = self._now_ns()
            if snapshot.volume is not None:
                self._last_profile_volume = snapshot.volume
        if bar is not None or self.kind not in _TIME_PROFILE_KINDS or snapshot is None:
            return bar
        last = snapshot.last
        if last is None or not (math.isfinite(last) and last > 0.0):
            return None
        return EqBar(
            snapshot.source,
            self.ticker,
            snapshot.symbol_raw,
            snapshot.captured_ns,
            AssetClass.EQUITY,
            snapshot.captured_ns,
            interval="1d",
            open=snapshot.open if snapshot.open is not None else last,
            high=snapshot.high if snapshot.high is not None else last,
            low=snapshot.low if snapshot.low is not None else last,
            close=last,
            volume=0.0,
        )

    async def _poll_snapshot(self) -> LiveSnapshot | None:
        if self._snapshot_fn is not None:
            return await self._snapshot_fn()
        for quote in await self._asset_feed().quotes([self.ticker]):
            if quote.ticker == self.ticker:
                return snapshot_of(quote)
        return None

    def _on_snapshot(self, builder: _ProfileBuilder, snapshot: LiveSnapshot, now: int) -> None:
        """Grow the profile from the poll itself when the chart has no minutes to grow it from.

        A future adds the session volume the scanner reported since the last poll, at the
        price it reported. The other kinds add the time since the last poll, in minutes, at
        the polled price. With chart bars neither is added: the bars already count it.
        """
        previous_ns, self._last_poll_ns = self._last_poll_ns, now
        previous_volume = self._last_profile_volume
        if snapshot.volume is not None:
            self._last_profile_volume = snapshot.volume
        price = snapshot.last
        if self._chart_bars or price is None:
            return
        if self.kind in _TIME_PROFILE_KINDS:
            if previous_ns is not None and now > previous_ns:
                minutes = min((now - previous_ns) / 60e9, _MAX_POLL_WEIGHT_MIN)
                builder.add_volume(price, minutes)
        elif snapshot.volume is not None and previous_volume is not None:
            builder.add_volume(price, snapshot.volume - previous_volume)

    @staticmethod
    def _closing_print(bars: Sequence[EqBar]) -> Trade | None:
        """The last traded minute, as the world feed states it. An instrument whose bars carry
        no volume has no such print, so its last minute is shown as a display tick instead:
        the price it stood at, size one, venue ``synthetic``, exactly as a live last-price
        tick is."""
        found = GlobalEquityFeed._closing_print(bars)
        if found is not None:
            return found
        for bar in reversed(bars):
            if bar.interval == _MINUTE and math.isfinite(bar.close) and bar.close > 0.0:
                return Trade(
                    ts_ns=_bar_ts(bar),
                    price=float(bar.close),
                    size=1.0,
                    side=SIDE_UNKNOWN,
                    side_src=SIDE_SRC_NA,
                    venue=_SYNTH_VENUE,
                )
        return None
