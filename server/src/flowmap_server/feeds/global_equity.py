"""World-equity feed: any listing of any exchange Crocodile's live layer can reach.

A market string ``world-<mic>`` (``world-xist``, ``world-xtai``) names one exchange by its ISO
10383 operating MIC, and the symbol is the exchange's own local symbol (``THYAO``, ``2330``).
The feed asks Crocodile's :class:`~crocodile.equity.universal.live.feed.LiveFeed` for the
deepest view any publisher gives for that listing and states honestly which one it got:

============  ================================================================
Tier          What ``events()`` emits
============  ================================================================
book (L2)     the publisher's own resting ladder (3 to 10 price levels per side
              with real sizes), re-read every few seconds: ``depth`` is
              ``L2-snapshot``, exactly the reading of a polled crypto book. BBO
              from the top of that ladder. Tape from the publisher's prints (or
              its last print), side **inferred** by the quote rule.
top (L1)      the publisher's best bid and ask with sizes: ``depth`` is ``L1``.
              Tape as above.
last (SYNTH)  no publisher exposes resting orders for the listing: the same
              two-sided volume-at-price profile the keyless US tier draws, from
              the session's one-minute bars, split at the last price. Tape is
              the polled last price, sized by the session-volume change when the
              publisher states one. ``depth`` is ``SYNTH``.
============  ================================================================

The tier is fixed at construction, with no I/O: it is the deepest tier the market's source chain
declares, and only while the exchange calendar says the market is open. A closed market gets the
``SYNTH`` reading, because what can be drawn then is the last session's volume profile, never a
book. A book-tier feed draws no synthetic history: its warmup emits the session's real bars for
the price overlay and nothing into the depth grid, so a real ladder is never shown beside an
estimated one under one badge.

Session authority is :func:`crocodile.core.markets.calendar.calendar_for`: the exchange's own
calendar where the library knows it, otherwise weekdays outside the market's weekend.

``now_ns_fn`` / ``bars_fn`` / ``snapshot_fn`` / ``sleep_fn`` are injectable seams so pytest never
touches the network.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import math
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence

import numpy as np

from crocodile.core.markets.calendar import ExchangeCalendar, calendar_for
from crocodile.core.markets.errors import MarketError
from crocodile.core.markets.exchanges import ExchangeRegistry
from crocodile.core.markets.symbols import validate_local_symbol
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV as EqBar
from crocodile.equity.universal.live.feed import LiveFeed
from crocodile.equity.universal.live.model import TIER_RANK, LiveListing, LiveSnapshot, LiveTier
from crocodile.equity.universal.live.registry import coverage, sources_for

from flowmap_server.config import Config
from flowmap_server.core.backfill import Candle, default_backfill_fn
from flowmap_server.feeds.base import BarSample, BookState, DropCounters, FeedEvent, ts_ns_sane
from flowmap_server.feeds.equity import EquityFeed, _closed_marker_text
from flowmap_server.feeds.equity_profile import _bar_ts, _ProfileBuilder
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = [
    "WORLD_VENUE",
    "GlobalEquityFeed",
    "close_live_feed",
    "is_world_market",
    "live_feed",
    "world_backfill_fn",
    "world_capability",
    "world_market",
    "world_mic",
    "world_mics",
]

logger = logging.getLogger(__name__)

WORLD_VENUE = "world"
_PREFIX = WORLD_VENUE + "-"
# Book tiers re-read the publisher's ladder at this cadence (the sources' own floor is 5 s).
_BOOK_POLL_NS = 5 * 10**9
# A ladder older than this is not re-asserted as the live book: the publisher stopped answering.
_BOOK_STALE_NS = 45 * 10**9
_POLL_FAILURES_BEFORE_NOTICE = 3
_MINUTE_NS = 60 * 10**9
# The chart source runs minutes behind the market. Up to this much of that delay is drawn with
# the profile as last known; a longer silence is not a delay, and the picture starts cold.
_DELAY_BRIDGE_MAX_NS = 30 * _MINUTE_NS
_SYNTH_VENUE = "synthetic"
_BAR_VENUE = "bar"
_DEPTH_OF_TIER: dict[LiveTier, str] = {
    LiveTier.L2: "L2-snapshot",
    LiveTier.L1: "L1",
    LiveTier.LAST: "SYNTH",
}

SnapshotFn = Callable[[], Awaitable[LiveSnapshot | None]]


def world_market(mic: str) -> str:
    """The market string of one exchange: ``XIST`` -> ``world-xist``."""
    return _PREFIX + mic.lower()


def world_mic(market: str) -> str | None:
    """The operating MIC a ``world-<mic>`` market names, or ``None`` when it names none."""
    lowered = market.lower()
    if not lowered.startswith(_PREFIX):
        return None
    mic = lowered[len(_PREFIX) :].upper()
    return mic if mic in world_mics() else None


def is_world_market(market: str) -> bool:
    return world_mic(market) is not None


_MICS: frozenset[str] | None = None


def world_mics() -> frozenset[str]:
    """Every operating MIC with a live source chain (sanctioned markets stay closed)."""
    global _MICS
    if _MICS is None:
        _MICS = frozenset(row.mic for row in coverage() if not row.closed and row.sources)
    return _MICS


_LIVE: LiveFeed | None = None


def live_feed() -> LiveFeed:
    """The process-wide Crocodile live feed (one HTTP session per publisher)."""
    global _LIVE
    if _LIVE is None:
        _LIVE = LiveFeed()
    return _LIVE


async def close_live_feed() -> None:
    """Close the shared live feed's sessions. Safe to call when it was never opened."""
    global _LIVE
    feed, _LIVE = _LIVE, None
    if feed is not None:
        await feed.close()


async def world_backfill_fn(
    market: str, symbol: str, *, max_cols: int, now_ns: int
) -> Sequence[Candle]:
    """The app's backfill seam: world markets here, every other market as before.

    A ``world-<mic>`` market gets the session's one-minute bars of the listing as backfill
    candles: the same reconstruction the US equity and crypto markets get (real bar prices
    and volume, drawn as a volume-at-price history and badged ``reconstructed``). Empty when
    the chart source does not cover the exchange or cannot be read, which is a clean cold
    start. Any other market is handed to :func:`default_backfill_fn` unchanged.
    """
    mic = world_mic(market)
    if mic is None:
        return await default_backfill_fn(market, symbol, max_cols=max_cols, now_ns=now_ns)
    if max_cols <= 0:
        return []
    try:
        bars = await live_feed().minute_bars(LiveListing(mic=mic, local_symbol=symbol))
    except Exception:  # backfill is best-effort; cold start on any error
        logger.warning("world backfill failed for %s:%s; cold start", market, symbol, exc_info=True)
        return []
    return [
        Candle(t0_ns=bar.ts_ns, o=bar.open, h=bar.high, l=bar.low, c=bar.close, volume=bar.volume)
        for bar in bars[-max_cols:]
    ]


def _declared_tier(mic: str) -> LiveTier:
    chain = sources_for(mic)
    if not chain:
        return LiveTier.LAST
    return min((cls.tier_for(mic) for cls in chain), key=TIER_RANK.__getitem__)


def world_capability(tier: LiveTier) -> dict[str, object]:
    """The capability a world feed states for one tier."""
    if tier is LiveTier.LAST:
        return {
            "depth": "SYNTH",
            "tape": "poll",
            "trade_side": "na",
            "cvd": "na",
            "vwap": "approx",
            "markers": ["gap", "session_break"],
        }
    return {
        "depth": _DEPTH_OF_TIER[tier],
        "tape": "poll",
        "trade_side": "inferred",
        "cvd": "inferred",
        "vwap": "approx",
        "markers": ["gap", "session_break"],
    }


def _profile_tick_for(price: float) -> float:
    """Volume-at-price bucket: the fifth significant digit of the price."""
    if not math.isfinite(price) or price <= 0.0:
        return 0.01
    return 10.0 ** (math.floor(math.log10(price)) - 4)


class GlobalEquityFeed(EquityFeed):
    """One listing of one exchange (implements the Feed protocol).

    A subclass of :class:`EquityFeed` so the session layer's equity handling (closed-market
    warmup, the keyless replay gate, the closed banner) applies unchanged; it reports the
    ``keyless`` tier for that purpose and states its real depth in ``capability``.
    """

    # The grid cannot know a listing's price scale before the first book: a 0.05 penny stock
    # and a 200,000 KRW share need ticks seven decades apart.
    price_adaptive_tick = True

    def __init__(
        self,
        symbol: str,
        mic: str,
        cfg: Config,
        *,
        live: LiveFeed | None = None,
        now_ns_fn: Callable[[], int] | None = None,
        bars_fn: Callable[[], Awaitable[Sequence[EqBar]]] | None = None,
        snapshot_fn: SnapshotFn | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
        calendar: ExchangeCalendar | None = None,
        stats: DropCounters | None = None,
    ) -> None:
        super().__init__(
            symbol, cfg, now_ns_fn=now_ns_fn, bars_fn=bars_fn, sleep_fn=sleep_fn, stats=stats
        )
        self.mic = mic.upper()
        ExchangeRegistry().get(self.mic)
        # A local symbol keeps the exchange's own spelling and case (``RRl`` is not ``RRL``).
        # It is checked here, before any request is built from it: a symbol the engine's
        # listing grammar refuses (whitespace, control characters, ``@`` or ``:``) is a
        # refused subscribe, not a feed that fails on its first poll. The empty symbol is the
        # capability probe the directory uses, as it does for the crypto feed.
        spelled = unicodedata.normalize("NFC", symbol.strip())
        if spelled:
            try:
                spelled = validate_local_symbol(spelled)
            except MarketError as exc:
                raise ValueError(f"invalid symbol for {self.mic}: {exc}") from exc
        self.symbol = spelled
        self.market = world_market(self.mic)
        self._listing = LiveListing(mic=self.mic, local_symbol=self.symbol)
        self._world_calendar = calendar if calendar is not None else calendar_for(self.mic)
        self._tz = self._world_calendar.tz
        self._live = live
        self._snapshot_fn = snapshot_fn
        declared = _declared_tier(self.mic)
        self.live_tier = declared if not self.is_closed_now() else LiveTier.LAST
        self.capability = world_capability(self.live_tier)
        # Which exchange this is, for the client: its clocks read in the exchange's own zone
        # and its prices in the exchange's currency. Flat scalars, like every capability key.
        info = ExchangeRegistry().get(self.mic)
        self.capability.update(
            {
                "exchange_mic": self.mic,
                "exchange_name": info.name.title(),
                "exchange_tz": str(self._tz),
                "currency": info.currency,
            }
        )
        self._reset_tape_state()

    def _reset_tape_state(self) -> None:
        """Forget what the tape has seen: a fresh stream repeats nothing and owes nothing."""
        self._seen_prints: set[tuple[int | None, float, float]] = set()
        self._last_print_key: tuple[int | None, float | None, float | None] | None = None
        self._last_volume: float | None = None
        self._last_price: float | None = None
        self._session_bar_snapshot: LiveSnapshot | None = None

    # -- seams the asset markets replace (feeds.asset_markets) --------------------------

    def _record_symbol(self) -> str:
        """The symbol the bar records of this feed carry."""
        return self._listing.symbol

    def _make_builder(self) -> _ProfileBuilder:
        return _ProfileBuilder(self._profile_tick)

    def _on_snapshot(self, builder: _ProfileBuilder, snapshot: LiveSnapshot, now: int) -> None:
        """A live poll answered. A listing's profile grows from its minute bars alone."""

    def _delay_bridge_ts(self, last_bar_ts: int, now: int) -> int | None:
        """Where the chart's delay begins: the end of the last charted minute, or ``None``.

        The live profile is the session's bars as far as the chart has them, asserted at the
        present. The chart is minutes late, so between its last minute and the first live
        column there is a stretch with no bar. Stating the profile once at the start of that
        stretch lets the grid carry it to the present: the same reading the live columns
        give, over the minutes the chart has not caught up with. ``None`` when there is no
        such stretch, when it is too long to be a delay, or when the bars are another
        session's.
        """
        start = last_bar_ts + _MINUTE_NS
        if last_bar_ts <= 0 or start >= now or now - start > _DELAY_BRIDGE_MAX_NS:
            return None
        if self._stale_profile_date(last_bar_ts, now) is not None:
            return None
        return start

    # -- tier / session ---------------------------------------------------------

    def _select_tier(self) -> str:
        return "keyless"

    def _et_date(self, ts_ns: int) -> datetime.date:  # type: ignore[override]
        """Exchange-local date of a stamp (the base groups bars by New York date)."""
        return (
            datetime.datetime.fromtimestamp(ts_ns / 1e9, tz=datetime.timezone.utc)
            .astimezone(self._tz)
            .date()
        )

    def _session_state(self, now_ns: int) -> tuple[str, int | None]:
        now = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=datetime.timezone.utc)
        day = now.astimezone(self._tz).date()
        calendar = self._world_calendar
        try:
            if calendar.is_session(day) and (
                calendar.session_open_utc(day) <= now < calendar.session_close_utc(day)
            ):
                return "open", None
        except (MarketError, ValueError):
            logger.debug("calendar of %s has no answer for %s", self.mic, day, exc_info=True)
        return "closed", self._next_world_open_ns(now)

    def _next_world_open_ns(self, now: datetime.datetime) -> int | None:
        day = now.astimezone(self._tz).date()
        calendar = self._world_calendar
        for add in range(0, 12):
            candidate = day + datetime.timedelta(days=add)
            try:
                if not calendar.is_session(candidate):
                    continue
                opens = calendar.session_open_utc(candidate)
            except (MarketError, ValueError):
                continue
            if opens > now:
                return int(opens.timestamp() * 1e9)
        return None

    # -- data seams ---------------------------------------------------------------

    def _feed(self) -> LiveFeed:
        return self._live if self._live is not None else live_feed()

    async def _default_fetch_bars(self) -> Sequence[EqBar]:
        """Today's one-minute bars as engine bar records; empty when the chart has none."""
        now = self._now_ns()
        bars = await self._feed().minute_bars(self._listing)
        return [
            EqBar(
                "yahoo_chart",
                self._record_symbol(),
                self.symbol,
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
        bars = list(await super()._fetch_bars())
        if not bars:
            fallback = await self._session_bar()
            if fallback is not None:
                bars = [fallback]
        for bar in bars:
            if math.isfinite(bar.close) and bar.close > 0.0:
                self._profile_tick = _profile_tick_for(float(bar.close))
                break
        return bars

    async def _refresh_bars(self) -> Sequence[EqBar]:
        """Minute bars for a live refresh. The session fallback is warmup-only: its figures are
        the session's cumulative totals, so adding it again each refresh would count the volume
        once more on every minute."""
        return await EquityFeed._fetch_bars(self)

    async def _session_bar(self) -> EqBar | None:
        """The session's own bar, from the publisher's session figures, when there are no
        minute bars. Built only from stated numbers: a session with no stated volume, high or
        low gives no bar, and so no profile."""
        snapshot = await self._poll_snapshot_safe()
        if snapshot is None:
            return None
        self._session_bar_snapshot = snapshot
        last, high, low, volume = snapshot.last, snapshot.high, snapshot.low, snapshot.volume
        if last is None or high is None or low is None or volume is None or not volume > 0.0:
            return None
        ts = snapshot.source_ts_ns if snapshot.source_ts_ns is not None else snapshot.captured_ns
        return EqBar(
            snapshot.source,
            self._record_symbol(),
            snapshot.symbol_raw,
            snapshot.captured_ns,
            AssetClass.EQUITY,
            ts,
            interval="1d",
            open=snapshot.open if snapshot.open is not None else last,
            high=high,
            low=low,
            close=last,
            volume=volume,
        )

    async def _poll_snapshot(self) -> LiveSnapshot | None:
        if self._snapshot_fn is not None:
            return await self._snapshot_fn()
        feed = self._feed()
        self._listing = await feed.identify(self._listing)
        return await feed.poll(self._listing)

    async def _poll_snapshot_safe(self) -> LiveSnapshot | None:
        try:
            return await self._poll_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:  # a stale tape is honest; never kill the loop
            logger.debug("live poll failed for %s@%s", self.symbol, self.mic, exc_info=True)
            return None

    # -- snapshot -> events ---------------------------------------------------------

    @staticmethod
    def _book_of(snapshot: LiveSnapshot, ts_ns: int) -> BookState | None:
        """The publisher's sized ladder as a book, or ``None`` when it has no sized level."""
        bids = [(level.price, level.size) for level in snapshot.bids if level.size is not None]
        asks = [(level.price, level.size) for level in snapshot.asks if level.size is not None]
        if not bids and not asks:
            return None
        return BookState(
            ts_ns=ts_ns,
            bid_px=np.array([price for price, _ in bids], dtype=np.float64),
            bid_sz=np.array([size for _, size in bids], dtype=np.float64),
            ask_px=np.array([price for price, _ in asks], dtype=np.float64),
            ask_sz=np.array([size for _, size in asks], dtype=np.float64),
            source=snapshot.source,
            provenance="native",
            observed_ns=snapshot.captured_ns,
        )

    @staticmethod
    def _side_of(price: float, snapshot: LiveSnapshot) -> tuple[int, int]:
        """Quote rule against the publisher's own top of book; unknown between the quotes."""
        bid, ask = snapshot.best_bid, snapshot.best_ask
        if ask is not None and price >= ask.price:
            return SIDE_BUY, SIDE_SRC_INFERRED
        if bid is not None and price <= bid.price:
            return SIDE_SELL, SIDE_SRC_INFERRED
        return SIDE_UNKNOWN, SIDE_SRC_NA

    def _trades_of(self, snapshot: LiveSnapshot, now: int) -> list[Trade]:
        """The prints this poll adds to the tape. Never repeats a print it already emitted."""
        out: list[Trade] = []
        book_tier = self.live_tier is not LiveTier.LAST
        if snapshot.prints:
            first_poll = not self._seen_prints
            for item in snapshot.prints:
                key = (item.ts_ns, item.price, item.size)
                if key in self._seen_prints:
                    continue
                self._seen_prints.add(key)
                if first_poll and item is not snapshot.prints[-1]:
                    # The tape a first poll returns is history: it seeds the de-duplication.
                    # Only its newest print, the publisher's last trade, opens the tape.
                    continue
                ts = item.ts_ns if item.ts_ns is not None and ts_ns_sane(item.ts_ns, now_ns=now) else now
                side, src = self._side_of(item.price, snapshot) if book_tier else (SIDE_UNKNOWN, SIDE_SRC_NA)
                out.append(Trade(ts_ns=ts, price=item.price, size=item.size, side=side,
                                 side_src=src, venue=snapshot.source))
            if len(self._seen_prints) > 4096:
                self._seen_prints = {(i.ts_ns, i.price, i.size) for i in snapshot.prints}
        elif snapshot.last is not None and snapshot.last_size is not None:
            key3 = (snapshot.source_ts_ns, snapshot.last, snapshot.last_size)
            volume_moved = (
                snapshot.volume is not None
                and self._last_volume is not None
                and snapshot.volume > self._last_volume
            )
            # The first poll's last print opens the tape: it is the publisher's latest trade.
            if self._last_print_key is None or key3 != self._last_print_key or volume_moved:
                side, src = self._side_of(snapshot.last, snapshot) if book_tier else (SIDE_UNKNOWN, SIDE_SRC_NA)
                out.append(Trade(ts_ns=now, price=snapshot.last, size=snapshot.last_size,
                                 side=side, side_src=src, venue=snapshot.source))
            self._last_print_key = key3
        elif snapshot.last is not None:
            grown = (
                snapshot.volume - self._last_volume
                if snapshot.volume is not None and self._last_volume is not None
                else None
            )
            if grown is not None and grown > 0.0:
                # The session volume grew by this much since the last poll: one print of that
                # size at the last price (Crocodile's volume-delta derivation).
                side, src = self._side_of(snapshot.last, snapshot) if book_tier else (SIDE_UNKNOWN, SIDE_SRC_NA)
                out.append(Trade(ts_ns=now, price=snapshot.last, size=float(grown), side=side,
                                 side_src=src, venue=snapshot.source))
            elif self._last_price is None or snapshot.last != self._last_price:
                # No size is published for it: a display-only last-price tick, exactly as the
                # keyless US tape shows one.
                out.append(Trade(ts_ns=now, price=snapshot.last, size=1.0, side=SIDE_UNKNOWN,
                                 side_src=SIDE_SRC_NA, venue=_SYNTH_VENUE))
        if snapshot.volume is not None:
            self._last_volume = snapshot.volume
        if snapshot.last is not None:
            self._last_price = snapshot.last
        return out

    @staticmethod
    def _closing_print(bars: Sequence[EqBar]) -> Trade | None:
        """The last minute of the shown session that traded, as one display print.

        A closed market has no live tape, and an empty tape says nothing about where the
        session ended. The session's last one-minute bar with volume does: its close and the
        volume of that minute, stamped with the bar's own time. It is the same reading as the
        volume-delta print of the live loop (trading over an interval reported as one print),
        so the side is unknown and the venue is ``bar``, never an exchange. A session known
        only by its whole-day bar gives none: a day's volume is not a print.
        """
        for bar in reversed(bars):
            if bar.interval != "1m":
                continue
            if math.isfinite(bar.close) and bar.close > 0.0 and bar.volume > 0.0:
                return Trade(
                    ts_ns=_bar_ts(bar),
                    price=float(bar.close),
                    size=float(bar.volume),
                    side=SIDE_UNKNOWN,
                    side_src=SIDE_SRC_NA,
                    venue=_BAR_VENUE,
                )
        return None

    # -- feed protocol ----------------------------------------------------------------

    async def _keyless_events(self, *, history_only: bool = False) -> AsyncIterator[FeedEvent]:
        self._reset_tape_state()
        try:
            bars = await self._fetch_bars()
        except Exception:  # a failed warmup must degrade, not kill the feed
            logger.warning("world warmup bars failed for %s@%s", self.symbol, self.mic, exc_info=True)
            bars = []
        warmup = self._select_warmup_bars(bars)
        builder = self._make_builder()
        synth = self.live_tier is LiveTier.LAST
        last_bar_ts = 0
        ref: float | None = None
        for index, bar in enumerate(warmup):
            ts = _bar_ts(bar)
            last_bar_ts = max(last_bar_ts, ts)
            ref = float(bar.close)
            if synth:
                builder.add_bar(bar)
                yield builder.book_state(ts, ref)
            yield BarSample(ts, float(bar.open), float(bar.high), float(bar.low), ref, float(bar.volume))
            if index % 8 == 7:
                await asyncio.sleep(0)

        now = self._now_ns()
        state, next_open = self._session_state(now)
        if state == "closed" or history_only:
            self.feed_state = "closed"
            self.next_open_ts = next_open
            if history_only:
                closing = self._closing_print(warmup)
                if closing is not None:
                    yield closing
            yield Marker(
                ts_ns=last_bar_ts or now,
                kind="session_break",
                text=_closed_marker_text(builder.has_profile()),
            )
            return
        bridge = self._delay_bridge_ts(last_bar_ts, now)
        if synth and bridge is not None and builder.has_profile():
            yield builder.book_state(bridge, ref)
        async for event in self._world_live(builder, last_bar_ts, ref):
            yield event

    async def _world_live(
        self, builder: _ProfileBuilder, last_bar_ts: int, ref: float | None
    ) -> AsyncIterator[FeedEvent]:
        """One column per grid tick: the publisher's ladder (book tiers) or the session's
        volume profile split at the last price (``SYNTH``); a poll every few seconds."""
        synth = self.live_tier is LiveTier.LAST
        grid_s = self._cfg.dt_equity_keyless_grid_ns / 1e9
        poll_ns = self._cfg.dt_equity_keyless_ns if synth else _BOOK_POLL_NS
        next_refresh = self._now_ns() + self._bar_refresh_ns
        next_poll = self._now_ns()
        poll: asyncio.Task[LiveSnapshot | None] | None = None
        book: BookState | None = None
        book_seen_ns = 0
        stale_announced = False
        try:
            while True:
                now = self._now_ns()
                state, next_open = self._session_state(now)
                if state == "closed":
                    self.feed_state = "closed"
                    self.next_open_ts = next_open
                    yield Marker(
                        ts_ns=now,
                        kind="session_break",
                        text=_closed_marker_text(builder.has_profile()),
                    )
                    return

                if synth and now >= next_refresh:
                    try:
                        for bar in self._select_warmup_bars(await self._refresh_bars()):
                            ts = _bar_ts(bar)
                            if ts > last_bar_ts and builder.add_bar(bar):
                                last_bar_ts = ts
                                yield BarSample(ts, float(bar.open), float(bar.high),
                                                float(bar.low), float(bar.close), float(bar.volume))
                    except Exception:  # a stale profile survives a bad refresh
                        logger.warning("world bar refresh failed for %s@%s", self.symbol, self.mic,
                                       exc_info=True)
                    next_refresh = now + self._bar_refresh_ns

                if poll is None and now >= next_poll:
                    poll = asyncio.create_task(
                        self._poll_snapshot_safe(), name=f"world-poll:{self.symbol}@{self.mic}"
                    )
                    next_poll = now + poll_ns
                if poll is not None and poll.done():
                    snapshot = poll.result()
                    poll = None
                    if snapshot is None or snapshot.is_empty:
                        self.poll_failures += 1
                        if self.poll_failures == _POLL_FAILURES_BEFORE_NOTICE:
                            yield Marker(
                                ts_ns=now,
                                kind="gap",
                                text=(
                                    f"no live answer after {self.poll_failures} polls; "
                                    "the last values may be stale"
                                ),
                            )
                    else:
                        self.poll_failures = 0
                        reference = snapshot.reference_price
                        if reference is not None and math.isfinite(reference) and reference > 0.0:
                            ref = float(reference)
                        if not synth:
                            fresh = self._book_of(snapshot, now)
                            if fresh is not None:
                                book, book_seen_ns = fresh, now
                                bid, ask = snapshot.best_bid, snapshot.best_ask
                                if (
                                    bid is not None and ask is not None
                                    and bid.size is not None and ask.size is not None
                                ):
                                    yield BBO(ts_ns=now, bid_px=bid.price, bid_sz=bid.size,
                                              ask_px=ask.price, ask_sz=ask.size)
                        self._on_snapshot(builder, snapshot, now)
                        for trade in self._trades_of(snapshot, now):
                            yield trade

                if synth:
                    stale_date = self._stale_profile_date(last_bar_ts, now)
                    if stale_date is not None:
                        self.feed_state = "degraded"
                        if not stale_announced:
                            stale_announced = True
                            yield Marker(
                                ts_ns=now,
                                kind="gap",
                                text=(
                                    f"stale profile from {stale_date.isoformat()}: "
                                    "live depth withheld until today's bars load"
                                ),
                            )
                    else:
                        stale_announced = False
                        self.feed_state = "live"
                        yield builder.book_state(now, ref)
                elif book is not None and now - book_seen_ns <= _BOOK_STALE_NS:
                    self.feed_state = "live"
                    stale_announced = False
                    yield BookState(
                        ts_ns=now,
                        bid_px=book.bid_px,
                        bid_sz=book.bid_sz,
                        ask_px=book.ask_px,
                        ask_sz=book.ask_sz,
                        source=book.source,
                        provenance=book.provenance,
                        observed_ns=book.observed_ns,
                    )
                elif book is not None:
                    # The publisher stopped answering: the last ladder is withheld, not held up
                    # as the current book.
                    self.feed_state = "degraded"
                    if not stale_announced:
                        stale_announced = True
                        yield Marker(ts_ns=now, kind="gap",
                                     text="order book withheld: the publisher stopped answering")
                await self._sleep(grid_s)
        finally:
            if poll is not None and not poll.done():
                poll.cancel()
