"""World-equity feed tests: hand-built live snapshots, injected seams, NO network.

Every clock, bar, publisher answer and exchange calendar is injected (``now_ns_fn``,
``sleep_fn``, ``bars_fn``, ``snapshot_fn``, ``calendar=``), so pytest never touches a publisher.
The fake clock advances only when the feed sleeps, and the fake calendar's closing time ends a
live loop on its own, so every ``events()`` run terminates without real time.
"""

from __future__ import annotations

import asyncio
import datetime
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from typing import cast
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from crocodile.core.markets.calendar import ExchangeCalendar
from crocodile.core.markets.errors import MarketError
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV as StkBar
from crocodile.equity.universal.live.model import (
    LiveLevel,
    LiveListing,
    LivePrint,
    LiveSnapshot,
    LiveTier,
)

from flowmap_server.config import Config
from flowmap_server.feeds.base import BarSample, BookState, Feed, FeedEvent
from flowmap_server.feeds.global_equity import (
    GlobalEquityFeed,
    is_world_market,
    world_market,
    world_mic,
    world_mics,
)
from flowmap_server.proto.events import (
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    BBO,
    Marker,
    Trade,
)

SEC = 10**9
THU = datetime.date(2026, 11, 12)  # a Thursday: a weekday session
FRI = datetime.date(2026, 11, 13)
SAT = datetime.date(2026, 11, 14)
MON = datetime.date(2026, 11, 16)

IST = ZoneInfo("Europe/Istanbul")  # XIST, Borsa Istanbul
TPE = ZoneInfo("Asia/Taipei")  # XTAI, Taiwan Stock Exchange
ZRH = ZoneInfo("Europe/Zurich")  # XSWX, SIX Swiss Exchange
TYO = ZoneInfo("Asia/Tokyo")  # XJPX, Japan Exchange Group

UTC = datetime.timezone.utc

BID_LADDER = ((100.0, 50.0), (99.5, 30.0), (99.0, 20.0), (98.5, 10.0), (98.0, 5.0))
ASK_LADDER = ((100.5, 40.0), (101.0, 25.0), (101.5, 15.0), (102.0, 8.0), (102.5, 4.0))


# --- injected seams -------------------------------------------------------------


def _at(tz: ZoneInfo, day: datetime.date, hh: int, mm: int = 0, ss: int = 0) -> int:
    """UTC ns of a wall-clock time in one exchange's zone (the house helper's form)."""
    dt = datetime.datetime.combine(day, datetime.time(hh, mm, ss), tzinfo=tz)
    return int(dt.timestamp() * 1e9)


def _utc(y: int, mo: int, d: int, hh: int, mm: int = 0) -> int:
    return int(datetime.datetime(y, mo, d, hh, mm, tzinfo=UTC).timestamp() * 1e9)


class FakeClock:
    """A UTC-ns clock that advances only when the feed sleeps."""

    def __init__(self, start_ns: int) -> None:
        self.now_ns = start_ns

    def __call__(self) -> int:
        return self.now_ns

    async def sleep(self, seconds: float) -> None:
        self.now_ns += round(seconds * SEC)
        await asyncio.sleep(0)  # let a pending poll task run, as a real sleep would


class FakeCalendar:
    """Weekday sessions between two local times of day, in one exchange's zone."""

    def __init__(
        self,
        tz: ZoneInfo,
        *,
        open_at: datetime.time = datetime.time(9, 0),
        close_at: datetime.time = datetime.time(17, 0),
    ) -> None:
        self.tz = tz
        self._open = open_at
        self._close = close_at

    def is_session(self, d: datetime.date) -> bool:
        return d.weekday() < 5

    def session_open_utc(self, d: datetime.date) -> datetime.datetime:
        return datetime.datetime.combine(d, self._open, tzinfo=self.tz).astimezone(UTC)

    def session_close_utc(self, d: datetime.date) -> datetime.datetime:
        return datetime.datetime.combine(d, self._close, tzinfo=self.tz).astimezone(UTC)


class BrokenCalendar:
    """A calendar that has no answer for any day (a crocodile MarketError)."""

    def __init__(self, tz: ZoneInfo) -> None:
        self.tz = tz

    def is_session(self, d: datetime.date) -> bool:
        raise MarketError("no calendar for this test")

    def session_open_utc(self, d: datetime.date) -> datetime.datetime:
        raise MarketError("no calendar for this test")

    def session_close_utc(self, d: datetime.date) -> datetime.datetime:
        raise MarketError("no calendar for this test")


class Script:
    """One answer per poll: the scripted snapshots in order, then ``then`` for every later poll."""

    def __init__(self, *items: LiveSnapshot | None, then: LiveSnapshot | None = None) -> None:
        self._items = list(items)
        self._then = then
        self.calls = 0

    async def __call__(self) -> LiveSnapshot | None:
        index = self.calls
        self.calls += 1
        if index < len(self._items):
            return self._items[index]
        return self._then


def _cal(
    tz: ZoneInfo,
    *,
    close: datetime.time = datetime.time(17, 0),
) -> FakeCalendar:
    return FakeCalendar(tz, open_at=datetime.time(9, 0), close_at=close)


def _feed(
    mic: str,
    clock: FakeClock,
    calendar: object,
    *,
    symbol: str = "2330",
    bars: Sequence[StkBar] = (),
    poll: Callable[[], Awaitable[LiveSnapshot | None]] | None = None,
) -> GlobalEquityFeed:
    async def bars_fn() -> list[StkBar]:
        return list(bars)

    return GlobalEquityFeed(
        symbol,
        mic,
        Config(),
        now_ns_fn=clock,
        bars_fn=bars_fn,
        snapshot_fn=poll if poll is not None else Script(),
        sleep_fn=clock.sleep,
        calendar=cast(ExchangeCalendar, calendar),
    )


async def _run(feed: GlobalEquityFeed, cap: int = 5000) -> tuple[list[FeedEvent], bool]:
    """Consume ``events()`` up to ``cap`` events. The flag says whether the generator ended."""
    events: list[FeedEvent] = []
    gen = cast(AsyncGenerator[FeedEvent, None], feed.events())
    try:
        async for event in gen:
            events.append(event)
            if len(events) >= cap:
                return events, False
        return events, True
    finally:
        await gen.aclose()


# --- records --------------------------------------------------------------------


def _bar(ts_ns: int, o: float, h: float, low: float, c: float, v: float) -> StkBar:
    return StkBar(
        source="yahoo",
        symbol="2330",
        symbol_raw="2330",
        asset_class=AssetClass.EQUITY,
        local_ts=ts_ns,
        source_ts=ts_ns,
        interval="1m",
        open=o,
        high=h,
        low=low,
        close=c,
        volume=v,
    )


def _levels(pairs: tuple[tuple[float, float | None], ...]) -> tuple[LiveLevel, ...]:
    return tuple(LiveLevel(price=p, size=s) for p, s in pairs)


def _snap(
    *,
    mic: str = "XTAI",
    symbol: str = "2330",
    source: str = "twse_mis",
    captured_ns: int,
    last: float | None = None,
    last_size: float | None = None,
    source_ts_ns: int | None = None,
    open_: float | None = None,
    high: float | None = None,
    low: float | None = None,
    volume: float | None = None,
    bids: tuple[tuple[float, float | None], ...] = (),
    asks: tuple[tuple[float, float | None], ...] = (),
    prints: tuple[LivePrint, ...] = (),
) -> LiveSnapshot:
    return LiveSnapshot(
        source=source,
        listing=LiveListing(mic=mic, local_symbol=symbol),
        symbol_raw=symbol,
        captured_ns=captured_ns,
        source_ts_ns=source_ts_ns,
        last=last,
        last_size=last_size,
        open=open_,
        high=high,
        low=low,
        volume=volume,
        bids=_levels(bids),
        asks=_levels(asks),
        prints=prints,
    )


def _book(captured_ns: int, *, prints: tuple[LivePrint, ...] = ()) -> LiveSnapshot:
    """A five-level ladder on each side of one Taiwan listing."""
    return _snap(captured_ns=captured_ns, bids=BID_LADDER, asks=ASK_LADDER, prints=prints)


def _trades(events: Sequence[FeedEvent]) -> list[Trade]:
    return [e for e in events if isinstance(e, Trade)]


def _warm(tz: ZoneInfo, *, close: float = 100.0) -> list[StkBar]:
    """One earlier minute bar on the same local day. Without it the warmup takes the session
    fallback, which polls the publisher once, and the scripted answers shift by one poll."""
    return [_bar(_at(tz, THU, 8, 30), close, close, close, close, 1.0)]


BID_PX = np.array([p for p, _ in BID_LADDER], dtype=np.float64)
BID_SZ = np.array([s for _, s in BID_LADDER], dtype=np.float64)
ASK_PX = np.array([p for p, _ in ASK_LADDER], dtype=np.float64)
ASK_SZ = np.array([s for _, s in ASK_LADDER], dtype=np.float64)


# --- identity -------------------------------------------------------------------


def test_market_is_the_world_mic_and_the_symbol_keeps_its_case() -> None:
    feed = _feed("xist", FakeClock(_at(IST, THU, 12)), _cal(IST), symbol="RRl")
    assert feed.market == "world-xist"
    assert feed.mic == "XIST"
    assert feed.symbol == "RRl"


def test_world_market_and_world_mic_round_trip() -> None:
    assert world_market("XIST") == "world-xist"
    assert world_mic("world-xist") == "XIST"
    assert world_mic("world-XIST") == "XIST"


def test_sanctioned_or_unknown_mics_are_not_world_markets() -> None:
    assert world_mic("world-misx") is None
    assert not is_world_market("world-misx")
    assert world_mic("world-zzzz") is None


def test_non_world_markets_are_not_world_markets() -> None:
    assert not is_world_market("equity")
    assert not is_world_market("binance-spot")
    assert world_mic("equity") is None
    assert is_world_market("World-XTAI")


def test_world_mics_excludes_sanctioned_markets_and_has_the_known_exchanges() -> None:
    mics = world_mics()
    assert {"XIST", "XTAI", "XETR"} <= mics
    assert "MISX" not in mics


# --- tier at construction -------------------------------------------------------


def test_open_xtai_states_the_l2_snapshot_depth() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, THU, 12)), _cal(TPE))
    assert feed.live_tier is LiveTier.L2
    assert feed.capability["depth"] == "L2-snapshot"
    assert feed.capability["trade_side"] == "inferred"
    assert feed.capability["cvd"] == "inferred"


def test_open_xswx_states_the_l1_depth() -> None:
    feed = _feed("XSWX", FakeClock(_at(ZRH, THU, 12)), _cal(ZRH))
    assert feed.live_tier is LiveTier.L1
    assert feed.capability["depth"] == "L1"


def test_open_xist_states_the_synth_depth_with_no_side() -> None:
    feed = _feed("XIST", FakeClock(_at(IST, THU, 12)), _cal(IST))
    assert feed.live_tier is LiveTier.LAST
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["trade_side"] == "na"
    assert feed.capability["cvd"] == "na"


@pytest.mark.parametrize(("mic", "tz"), [("XTAI", TPE), ("XSWX", ZRH), ("XIST", IST)])
def test_a_closed_market_of_any_tier_states_synth(mic: str, tz: ZoneInfo) -> None:
    feed = _feed(mic, FakeClock(_at(tz, THU, 20)), _cal(tz))
    assert feed.is_closed_now()
    assert feed.live_tier is LiveTier.LAST
    assert feed.capability["depth"] == "SYNTH"


def test_the_tier_is_keyless_for_the_session_layer_and_prices_adapt() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, THU, 12)), _cal(TPE))
    assert feed.tier == "keyless"
    assert feed.price_adaptive_tick is True


def test_the_feed_satisfies_the_feed_protocol() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, THU, 12)), _cal(TPE))
    assert isinstance(feed, Feed)
    assert isinstance(feed.capability, dict)


# --- session state --------------------------------------------------------------


def test_open_inside_the_calendar_window_and_closed_outside_it() -> None:
    clock = FakeClock(_at(TPE, THU, 12))
    feed = _feed("XTAI", clock, _cal(TPE))
    assert not feed.is_closed_now()
    clock.now_ns = _at(TPE, THU, 8, 59, 59)
    assert feed.is_closed_now()
    clock.now_ns = _at(TPE, THU, 9, 0)
    assert not feed.is_closed_now()
    clock.now_ns = _at(TPE, THU, 17, 0)  # the close is exclusive
    assert feed.is_closed_now()


def test_a_weekend_is_closed() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, SAT, 12)), _cal(TPE))
    assert feed.is_closed_now()


async def test_next_open_is_the_next_session_open() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, FRI, 18)), _cal(TPE))
    events, ended = await _run(feed)
    assert ended
    assert [type(e) for e in events] == [Marker]
    assert feed.feed_state == "closed"
    assert feed.next_open_ts == _at(TPE, MON, 9)


async def test_a_calendar_method_that_raises_marketerror_is_closed() -> None:
    feed = _feed("XTAI", FakeClock(_at(TPE, THU, 12)), BrokenCalendar(TPE))
    assert feed.is_closed_now()
    assert feed.live_tier is LiveTier.LAST
    events, ended = await _run(feed)
    assert ended
    markers = [e for e in events if isinstance(e, Marker)]
    assert [m.kind for m in markers] == ["session_break"]
    assert feed.feed_state == "closed"
    assert feed.next_open_ts is None


# --- warmup ---------------------------------------------------------------------


async def test_a_synth_warmup_yields_a_book_and_a_bar_per_bar() -> None:
    clock = FakeClock(_at(IST, THU, 20))  # a closed evening
    stamps = [_at(IST, THU, 10, m) for m in range(3)]
    bars = [_bar(ts, 100.0, 101.0, 99.0, 100.0 + i, 10.0 + i) for i, ts in enumerate(stamps)]
    feed = _feed("XIST", clock, _cal(IST), bars=bars)
    events, ended = await _run(feed)
    assert ended
    assert [type(e) for e in events] == [BookState, BarSample] * 3 + [Marker]
    samples = [e for e in events if isinstance(e, BarSample)]
    assert [s.ts_ns for s in samples] == stamps
    closing = events[-1]
    assert isinstance(closing, Marker) and closing.kind == "session_break"
    assert "SYNTH profile" in closing.text


async def test_a_book_tier_warmup_yields_only_bar_samples_and_no_depth() -> None:
    clock = FakeClock(_at(TPE, THU, 9))
    bars = [_bar(_at(TPE, THU, 8, m), 100.0, 101.0, 99.0, 100.5, 10.0) for m in range(3)]
    feed = _feed("XTAI", clock, _cal(TPE, close=datetime.time(9, 0, 3)), bars=bars)
    events, ended = await _run(feed)
    assert ended
    assert [type(e) for e in events] == [BarSample, BarSample, BarSample, Marker]
    assert not [e for e in events if isinstance(e, BookState)]


async def test_warmup_groups_bars_by_the_exchange_local_date() -> None:
    # Tokyo is nine hours ahead of UTC: these stamps straddle the UTC midnight of Thu/Fri.
    thu_2300_jst = _utc(2026, 11, 12, 14, 0)
    fri_0130_jst = _utc(2026, 11, 12, 16, 30)
    fri_1100_jst = _utc(2026, 11, 13, 2, 0)
    bars = [
        _bar(thu_2300_jst, 100.0, 101.0, 99.0, 100.0, 1.0),
        _bar(fri_0130_jst, 100.0, 101.0, 99.0, 100.0, 2.0),
        _bar(fri_1100_jst, 100.0, 101.0, 99.0, 100.0, 3.0),
    ]
    clock = FakeClock(_at(TYO, SAT, 12))  # Saturday: closed, so only the warmup is emitted
    feed = _feed("XJPX", clock, _cal(TYO), bars=bars)
    events, ended = await _run(feed)
    assert ended
    samples = [e for e in events if isinstance(e, BarSample)]
    assert [s.ts_ns for s in samples] == [fri_0130_jst, fri_1100_jst]
    assert [s.volume for s in samples] == [2.0, 3.0]


async def test_a_session_bar_is_built_from_the_publisher_session_figures() -> None:
    now = _at(IST, THU, 20)
    snap = _snap(
        mic="XIST", captured_ns=now, last=101.0, high=103.0, low=99.0, open_=100.0, volume=5000.0
    )
    feed = _feed("XIST", FakeClock(now), _cal(IST), poll=Script(then=snap))
    events, ended = await _run(feed)
    assert ended
    samples = [e for e in events if isinstance(e, BarSample)]
    assert len(samples) == 1
    bar = samples[0]
    assert (bar.ts_ns, bar.o, bar.h, bar.l, bar.c, bar.volume) == (now, 100.0, 103.0, 99.0, 101.0, 5000.0)


async def test_a_session_bar_needs_a_stated_volume() -> None:
    now = _at(IST, THU, 20)
    snap = _snap(mic="XIST", captured_ns=now, last=101.0, high=103.0, low=99.0)
    feed = _feed("XIST", FakeClock(now), _cal(IST), poll=Script(then=snap))
    events, ended = await _run(feed)
    assert ended
    assert not [e for e in events if isinstance(e, BarSample)]
    assert not [e for e in events if isinstance(e, BookState)]
    closing = events[-1]
    assert isinstance(closing, Marker) and "no cached history" in closing.text


# --- live loop: book tier -------------------------------------------------------


async def test_a_book_tier_reasserts_the_publisher_ladder_every_grid_tick() -> None:
    start = _at(TPE, THU, 9)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 12)),
        poll=Script(then=_book(start)),
    )
    events, ended = await _run(feed)
    assert ended
    books = [e for e in events if isinstance(e, BookState)]
    assert len(books) >= 5
    for book in books:
        assert np.array_equal(book.bid_px, BID_PX)
        assert np.array_equal(book.bid_sz, BID_SZ)
        assert np.array_equal(book.ask_px, ASK_PX)
        assert np.array_equal(book.ask_sz, ASK_SZ)
        assert book.source == "twse_mis"
        assert book.provenance == "native"
    stamps = [b.ts_ns for b in books]
    assert all(later - earlier == SEC for earlier, later in zip(stamps, stamps[1:], strict=False))


async def test_the_book_tier_emits_a_bbo_from_the_top_of_the_ladder() -> None:
    start = _at(TPE, THU, 9)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 5)),
        poll=Script(then=_book(start)),
    )
    events, _ = await _run(feed)
    bbos = [e for e in events if isinstance(e, BBO)]
    assert bbos
    top = bbos[0]
    assert (top.bid_px, top.bid_sz, top.ask_px, top.ask_sz) == (100.0, 50.0, 100.5, 40.0)


async def test_a_ladder_older_than_the_stale_bound_is_withheld_and_degraded() -> None:
    start = _at(TPE, THU, 9)
    clock = FakeClock(start)
    feed = _feed(
        "XTAI",
        clock,
        _cal(TPE, close=datetime.time(9, 1)),
        bars=_warm(TPE),
        poll=Script(_book(start), then=None),  # one good answer, then the publisher goes silent
    )
    gen = cast(AsyncGenerator[FeedEvent, None], feed.events())
    withheld: Marker | None = None
    state_at_marker = ""
    books_after: list[BookState] = []
    async for event in gen:
        if isinstance(event, Marker) and "withheld" in event.text:
            withheld = event
            state_at_marker = feed.feed_state
        elif isinstance(event, BookState) and withheld is not None:
            books_after.append(event)
    assert withheld is not None
    assert withheld.kind == "gap"
    assert withheld.ts_ns - start > 45 * SEC
    assert state_at_marker == "degraded"
    assert not books_after


async def test_the_market_closing_mid_loop_yields_session_break_and_ends() -> None:
    start = _at(TPE, THU, 9)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 3)),
        poll=Script(then=_book(start)),
    )
    events, ended = await _run(feed)
    assert ended
    closing = events[-1]
    assert isinstance(closing, Marker) and closing.kind == "session_break"
    assert feed.feed_state == "closed"
    assert feed.next_open_ts == _at(TPE, FRI, 9)


# --- live loop: SYNTH tier ------------------------------------------------------


async def test_the_synth_loop_reasserts_the_split_at_the_polled_last_price() -> None:
    start = _at(IST, THU, 9)
    bars = [
        _bar(_at(IST, THU, 8, 0), 100.0, 100.0, 100.0, 100.0, 1000.0),
        _bar(_at(IST, THU, 8, 1), 200.0, 200.0, 200.0, 200.0, 1000.0),
    ]
    poll = Script(then=_snap(mic="XIST", source="tradingview", captured_ns=start, last=150.0))
    feed = _feed(
        "XIST",
        FakeClock(start),
        _cal(IST, close=datetime.time(9, 0, 15)),
        bars=bars,
        poll=poll,
    )
    events, ended = await _run(feed)
    assert ended
    books = [e for e in events if isinstance(e, BookState)]
    assert books[0].ask_px.size == 0  # warmup: the last close (200) sits on the bid side
    last = books[-1]
    assert last.ask_px.size > 0
    assert np.all(last.bid_px <= 150.0)
    assert np.all(last.ask_px > 150.0)


async def test_three_failed_polls_yield_exactly_one_gap_marker() -> None:
    start = _at(IST, THU, 9)
    feed = _feed(
        "XIST",
        FakeClock(start),
        _cal(IST, close=datetime.time(9, 0, 35)),
        bars=_warm(IST),
        poll=Script(None, None, None, then=None),
    )
    events, ended = await _run(feed)
    assert ended
    gaps = [e for e in events if isinstance(e, Marker) and e.kind == "gap"]
    assert len(gaps) == 1
    assert "no live answer after 3 polls" in gaps[0].text
    assert not _trades(events)


# --- trades ---------------------------------------------------------------------


async def test_the_first_poll_opens_the_tape_with_the_publisher_last_print() -> None:
    start = _at(TPE, THU, 9)
    prints = (
        LivePrint(price=99.9, size=1.0, ts_ns=start - 5 * SEC),
        LivePrint(price=100.0, size=2.0, ts_ns=start - 4 * SEC),
        LivePrint(price=100.5, size=3.0, ts_ns=start - 3 * SEC),
    )
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 3)),
        bars=_warm(TPE),
        poll=Script(then=_book(start, prints=prints)),
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert [(t.price, t.size) for t in trades] == [(100.5, 3.0)]
    assert trades[0].side == SIDE_BUY
    assert trades[0].side_src == SIDE_SRC_INFERRED
    assert trades[0].venue == "twse_mis"


async def test_a_repeated_identical_print_is_not_emitted_again() -> None:
    start = _at(TPE, THU, 9)
    one = (LivePrint(price=100.5, size=3.0, ts_ns=start - 3 * SEC),)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 12)),
        bars=_warm(TPE),
        poll=Script(then=_book(start, prints=one)),  # three polls, the same tape each time
    )
    events, _ = await _run(feed)
    assert len(_trades(events)) == 1


async def test_a_changed_last_print_is_emitted_again() -> None:
    start = _at(IST, THU, 9)
    stamp = start - 60 * SEC
    poll = Script(
        _snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0, last_size=5.0,
              source_ts_ns=stamp),
        _snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0, last_size=5.0,
              source_ts_ns=stamp),
        then=_snap(mic="XIST", source="tradingview", captured_ns=start, last=101.0, last_size=5.0,
                   source_ts_ns=stamp),
    )
    feed = _feed(
        "XIST", FakeClock(start), _cal(IST, close=datetime.time(9, 0, 25)), bars=_warm(IST), poll=poll
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert [t.price for t in trades] == [100.0, 101.0]
    assert all(t.size == 5.0 and t.side_src == SIDE_SRC_NA for t in trades)


async def test_a_tape_of_prints_is_deduplicated_across_polls() -> None:
    start = _at(TPE, THU, 9)
    a = LivePrint(price=99.9, size=1.0, ts_ns=start - 40 * SEC)
    b = LivePrint(price=100.0, size=2.0, ts_ns=start - 30 * SEC)
    c = LivePrint(price=100.5, size=3.0, ts_ns=start - 20 * SEC)
    d = LivePrint(price=100.5, size=4.0, ts_ns=start - 10 * SEC)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 8)),
        bars=_warm(TPE),
        poll=Script(_book(start, prints=(a, b, c)), then=_book(start, prints=(b, c, d))),
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert [(t.price, t.size) for t in trades] == [(100.5, 3.0), (100.5, 4.0)]


async def test_the_quote_rule_infers_the_side_at_or_beyond_the_quotes_and_not_between() -> None:
    start = _at(TPE, THU, 9)
    at_ask = LivePrint(price=100.5, size=1.0, ts_ns=start - 30 * SEC)
    at_bid = LivePrint(price=100.0, size=2.0, ts_ns=start - 20 * SEC)
    between = LivePrint(price=100.25, size=3.0, ts_ns=start - 10 * SEC)
    feed = _feed(
        "XTAI",
        FakeClock(start),
        _cal(TPE, close=datetime.time(9, 0, 25)),
        bars=_warm(TPE),
        poll=Script(
            _book(start, prints=(at_ask,)),
            _book(start, prints=(at_ask, at_bid)),
            then=_book(start, prints=(at_ask, at_bid, between)),
        ),
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert [t.price for t in trades] == [100.5, 100.0, 100.25]
    assert [t.side for t in trades] == [SIDE_BUY, SIDE_SELL, SIDE_UNKNOWN]
    assert [t.side_src for t in trades] == [SIDE_SRC_INFERRED, SIDE_SRC_INFERRED, SIDE_SRC_NA]


async def test_a_publisher_with_only_a_cumulative_volume_yields_one_print_sized_by_growth() -> None:
    start = _at(IST, THU, 9)
    poll = Script(
        _snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0, volume=1000.0),
        then=_snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0, volume=1500.0),
    )
    feed = _feed(
        "XIST", FakeClock(start), _cal(IST, close=datetime.time(9, 0, 15)), bars=_warm(IST), poll=poll
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert len(trades) == 2
    assert trades[0].venue == "synthetic" and trades[0].size == 1.0  # the first last price
    assert trades[1].venue == "tradingview"
    assert trades[1].price == 100.0
    assert trades[1].size == 500.0


async def test_a_publisher_with_neither_size_nor_volume_ticks_only_when_the_price_changes() -> None:
    start = _at(IST, THU, 9)
    poll = Script(
        _snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0),
        _snap(mic="XIST", source="tradingview", captured_ns=start, last=100.0),
        then=_snap(mic="XIST", source="tradingview", captured_ns=start, last=101.0),
    )
    feed = _feed(
        "XIST", FakeClock(start), _cal(IST, close=datetime.time(9, 0, 25)), bars=_warm(IST), poll=poll
    )
    events, _ = await _run(feed)
    trades = _trades(events)
    assert [t.price for t in trades] == [100.0, 101.0]
    assert all(t.size == 1.0 for t in trades)
    assert all(t.venue == "synthetic" for t in trades)
    assert all(t.side_src == SIDE_SRC_NA for t in trades)


async def test_the_chart_delay_is_bridged_with_the_profile_as_last_known() -> None:
    # The chart is twelve minutes behind: its last minute is 09:48, the market is at 10:00.
    # One book stated at 09:49, the end of that minute, lets the grid carry the profile over
    # the minutes the chart has not caught up with. It is the profile of the bars, unchanged.
    clock = FakeClock(_at(IST, THU, 10, 0))
    bars = [
        _bar(_at(IST, THU, 9, 47), 100.0, 100.0, 100.0, 100.0, 10.0),
        _bar(_at(IST, THU, 9, 48), 101.0, 101.0, 101.0, 101.0, 30.0),
    ]
    feed = _feed("XIST", clock, _cal(IST), symbol="THYAO", bars=bars)
    events, _ended = await _run(feed, cap=6)
    books = [e for e in events if isinstance(e, BookState)]
    assert [b.ts_ns for b in books[:3]] == [
        _at(IST, THU, 9, 47),
        _at(IST, THU, 9, 48),
        _at(IST, THU, 9, 49),
    ]
    bridge, last_warm = books[2], books[1]
    np.testing.assert_array_equal(bridge.bid_px, last_warm.bid_px)
    np.testing.assert_array_equal(bridge.bid_sz, last_warm.bid_sz)
    np.testing.assert_array_equal(bridge.ask_px, last_warm.ask_px)
    # The first live column follows at the present.
    assert books[3].ts_ns == _at(IST, THU, 10, 0)


async def test_a_chart_that_is_current_needs_no_bridge() -> None:
    clock = FakeClock(_at(IST, THU, 10, 0, 30))
    bars = [_bar(_at(IST, THU, 10, 0), 100.0, 100.0, 100.0, 100.0, 10.0)]
    feed = _feed("XIST", clock, _cal(IST), symbol="THYAO", bars=bars)
    events, _ended = await _run(feed, cap=4)
    books = [e for e in events if isinstance(e, BookState)]
    assert [b.ts_ns for b in books[:2]] == [_at(IST, THU, 10, 0), _at(IST, THU, 10, 0, 30)]


async def test_a_silence_longer_than_a_delay_is_not_bridged() -> None:
    # Forty minutes without a bar is not the chart running late. Nothing is drawn over it.
    clock = FakeClock(_at(IST, THU, 10, 0))
    bars = [_bar(_at(IST, THU, 9, 20), 100.0, 100.0, 100.0, 100.0, 10.0)]
    feed = _feed("XIST", clock, _cal(IST), symbol="THYAO", bars=bars)
    events, _ended = await _run(feed, cap=4)
    books = [e for e in events if isinstance(e, BookState)]
    assert [b.ts_ns for b in books[:2]] == [_at(IST, THU, 9, 20), _at(IST, THU, 10, 0)]


async def test_a_book_tier_draws_no_bridge() -> None:
    # A ladder market shows the publisher's orders, never a profile: there is nothing to carry.
    clock = FakeClock(_at(TPE, THU, 10, 0))
    bars = [_bar(_at(TPE, THU, 9, 48), 100.0, 100.0, 100.0, 100.0, 10.0)]
    feed = _feed("XTAI", clock, _cal(TPE), bars=bars, poll=Script(then=None))
    events, _ended = await _run(feed, cap=6)
    assert not [e for e in events if isinstance(e, BookState)]


async def test_a_session_fallback_bar_is_not_added_again_on_each_refresh() -> None:
    """With no minute bars the session figures stand in for one bar. The live refresh must not
    add that bar again every minute: its volume is the cumulative session total, so each re-add
    would count the session's volume once more."""
    start = _at(IST, THU, 9)
    clock = FakeClock(start)

    async def live_session() -> LiveSnapshot | None:
        # A fresh stamp on every poll, as a publisher that omits its own trade time would give.
        return _snap(
            mic="XIST", source="tradingview", captured_ns=clock.now_ns,
            last=101.0, high=103.0, low=99.0, volume=5000.0,
        )

    feed = _feed("XIST", clock, _cal(IST, close=datetime.time(9, 1, 30)), poll=live_session)
    events, ended = await _run(feed)
    assert ended
    assert len([e for e in events if isinstance(e, BarSample)]) == 1


async def test_world_backfill_reads_minute_bars_and_leaves_other_markets_alone(monkeypatch) -> None:
    from crocodile.equity.universal.live.sources.yahoo_chart import MinuteBar

    from flowmap_server.feeds import global_equity

    asked: list[tuple[str, str]] = []

    class _Bars:
        async def minute_bars(self, listing):
            asked.append((listing.mic, listing.local_symbol))
            return [
                MinuteBar(ts_ns=1_000, open=1.0, high=2.0, low=0.5, close=1.5, volume=10.0),
                MinuteBar(ts_ns=2_000, open=1.5, high=2.5, low=1.0, close=2.0, volume=20.0),
                MinuteBar(ts_ns=3_000, open=2.0, high=3.0, low=1.5, close=2.5, volume=30.0),
            ]

    delegated: list[str] = []

    async def _default(market, symbol, *, max_cols, now_ns):
        delegated.append(market)
        return []

    monkeypatch.setattr(global_equity, "live_feed", lambda: _Bars())
    monkeypatch.setattr(global_equity, "default_backfill_fn", _default)

    candles = await global_equity.world_backfill_fn("world-xist", "THYAO", max_cols=2, now_ns=0)
    # The newest max_cols bars, oldest first, with the bar's own prices and volume.
    assert [(c.t0_ns, c.o, c.h, c.l, c.c, c.volume) for c in candles] == [
        (2_000, 1.5, 2.5, 1.0, 2.0, 20.0),
        (3_000, 2.0, 3.0, 1.5, 2.5, 30.0),
    ]
    assert asked == [("XIST", "THYAO")]
    assert await global_equity.world_backfill_fn("world-xist", "THYAO", max_cols=0, now_ns=0) == []
    # Every other market keeps the existing seam.
    assert await global_equity.world_backfill_fn("binance-spot", "BTCUSDT", max_cols=5, now_ns=0) == []
    assert delegated == ["binance-spot"]


async def test_world_backfill_is_a_cold_start_when_the_chart_cannot_be_read(monkeypatch) -> None:
    from flowmap_server.feeds import global_equity

    class _Broken:
        async def minute_bars(self, listing):
            raise RuntimeError("chart unreachable")

    monkeypatch.setattr(global_equity, "live_feed", lambda: _Broken())
    assert await global_equity.world_backfill_fn("world-xist", "THYAO", max_cols=5, now_ns=0) == []


def test_a_symbol_the_listing_grammar_refuses_is_a_refused_subscribe() -> None:
    from flowmap_server.config import Config
    from flowmap_server.feeds.global_equity import GlobalEquityFeed

    for bad in ("TH YAO", "THYAO@XIST", "sim:THYAO", "A\x00B"):
        with pytest.raises(ValueError):
            GlobalEquityFeed(bad, "XIST", Config())
    # Separators that real local symbols use are fine, and the case is kept.
    assert GlobalEquityFeed("JKH.N0000", "XCOL", Config()).symbol == "JKH.N0000"
    assert GlobalEquityFeed("NOVO-B", "XCSE", Config()).symbol == "NOVO-B"
    # The empty symbol is the directory's capability probe.
    assert GlobalEquityFeed("", "XIST", Config()).symbol == ""
