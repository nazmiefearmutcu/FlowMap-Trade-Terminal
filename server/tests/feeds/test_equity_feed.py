"""EquityFeed tests: fixture-driven, NO live network.

All bars/books/prices/clocks are hand-built and injected (``bars_fn`` /
``book_fn`` / ``price_fn`` / ``now_ns_fn`` / ``sleep_fn``), so pytest never
touches Yahoo, Cboe or google_finance. The frozen contract:

1. Warmup is price history on empty anchored books: no depth is invented.
2. The live book is the merged Cboe levels, in shares, in a real L2 Grid.
3. New prints become trades with the venue clock and tag, side unknown.
4. A quiet symbol falls back to a display-only last price.
5. Closed market and the 04:00-20:00 keyless window.
6. Tier auto-select + capability shapes; keyed sink side inference + real L1
   depth column; re-callable events(); Feed protocol conformance.
"""

from __future__ import annotations

import asyncio
import datetime

import msgspec
import numpy as np
import pytest

from crocodile.core.schema.enums import AssetClass, Side
from crocodile.core.schema.records import OHLCV as StkBar
from crocodile.core.schema.records import Quote as StkQuote
from crocodile.core.schema.records import Trade as StkTrade
from crocodile.core.scheduler.calendar import MARKET_TZ

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.feeds.base import BarSample, BookState, Feed, FeedEvent
from flowmap_server.feeds.equity import (
    EQUITY_MARKET,
    EquityFeed,
    _bar_ts,
    _EquitySink,
)
from flowmap_server.feeds.equity_book import VenueBook, VenuePrint
from flowmap_server.proto.events import (
    BBO,
    MODE_L2,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

# --- fixtures / helpers --------------------------------------------------------

DT_KEYLESS_GRID_NS = 10**9  # matches Config.dt_equity_keyless_grid_ns (column)


def _et_ns(y: int, mo: int, d: int, h: int, mi: int = 0, s: int = 0) -> int:
    dt = datetime.datetime(y, mo, d, h, mi, s, tzinfo=MARKET_TZ)
    return int(dt.timestamp() * 1e9)


def _bar(ts_ns: int, o: float, h: float, low: float, c: float, v: float) -> StkBar:
    return StkBar(
        source="yahoo",
        symbol="AAPL",
        symbol_raw="AAPL",
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


def _flat_bar(ts_ns: int, price: float, v: float) -> StkBar:
    """A bar whose whole OHLC sits at one price (typical price == price)."""
    return _bar(ts_ns, price, price, price, price, v)


# A single-session (Friday 2026-07-17) fixture where volume concentrates at
# 100.00: three 1 m bars of 1000 there, plus small bars at 95.00 / 105.00.
def _concentrated_session() -> list[StkBar]:
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    return [
        _flat_bar(base + 0 * m, 100.00, 1000.0),
        _flat_bar(base + 1 * m, 95.00, 50.0),
        _flat_bar(base + 2 * m, 100.00, 1000.0),
        _flat_bar(base + 3 * m, 105.00, 50.0),
        _flat_bar(base + 4 * m, 100.00, 1000.0),
    ]


class _StepClock:
    """UTC-ns clock advancing a fixed step per call (one call per feed cycle)."""

    def __init__(self, start_ns: int, step_ns: int) -> None:
        self._t = start_ns
        self._step = step_ns

    def __call__(self) -> int:
        v = self._t
        self._t += self._step
        return v


async def _nosleep(_s: float) -> None:
    # Yield to the loop as a real sleep would, so the price-poll task can complete.
    await asyncio.sleep(0)


async def _collect(feed: EquityFeed, n: int, cap: int = 10_000) -> list[FeedEvent]:
    out: list[FeedEvent] = []
    async for ev in feed.events():
        out.append(ev)
        if len(out) >= n or len(out) >= cap:
            break
    return out


# --- 1. warmup: price history on empty anchored books ---------------------------


def _book(
    venue: str,
    bids: list[tuple[float, float]],
    asks: list[tuple[float, float]],
    prints: list[VenuePrint] | None = None,
) -> VenueBook:
    return VenueBook(venue=venue, bids=tuple(bids), asks=tuple(asks), prints=tuple(prints or ()))


def _books_fn(reads: list[list[VenueBook]], calls: dict[str, int] | None = None):
    """A ``book_fn`` that returns ``reads`` in order, then repeats the last one."""
    state = {"i": 0}

    async def book_fn() -> list[VenueBook]:
        i = min(state["i"], len(reads) - 1)
        state["i"] += 1
        if calls is not None:
            calls["n"] = calls.get("n", 0) + 1
        return list(reads[i])

    return book_fn


async def _no_books() -> list[VenueBook]:
    return []


RTH = _et_ns(2026, 7, 15, 11, 0)  # Wednesday, regular session
SATURDAY = _et_ns(2026, 7, 18, 12, 0)


async def test_warmup_draws_no_depth_and_anchors_on_each_close():
    friday = _et_ns(2026, 7, 17, 15, 57)
    bars = [
        _bar(friday, 100.0, 102.0, 99.0, 101.0, 50.0),
        _bar(friday + 60 * 10**9, 101.0, 104.0, 100.0, 103.0, 75.0),
    ]
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: SATURDAY, bars_fn=_make_bars_fn(bars))
    events = await _collect(feed, 100)
    assert [type(ev) for ev in events] == [BookState, BarSample, BookState, BarSample, Marker]
    books = [ev for ev in events if isinstance(ev, BookState)]
    # No depth is known for the time before the feed read a book: none is invented.
    for book in books:
        assert book.bid_px.size == 0 and book.bid_sz.size == 0
        assert book.ask_px.size == 0 and book.ask_sz.size == 0
    assert [book.anchor_px for book in books] == [101.0, 103.0]
    assert [book.ts_ns for book in books] == [friday, friday + 60 * 10**9]
    samples = [ev for ev in events if isinstance(ev, BarSample)]
    assert [(ev.o, ev.h, ev.l, ev.c, ev.volume) for ev in samples] == [
        (100.0, 102.0, 99.0, 101.0, 50.0),
        (101.0, 104.0, 100.0, 103.0, 75.0),
    ]
    assert not any(isinstance(ev, Trade) for ev in events)


async def test_warmup_skips_nonfinite_and_negative_volume_bars():
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    bars = [
        _flat_bar(base + 0 * m, 100.0, 500.0),
        _bar(base + 1 * m, 101.0, float("nan"), 100.0, 100.5, 999.0),  # NaN high
        _flat_bar(base + 2 * m, 100.0, -7.0),  # negative volume
        _flat_bar(base + 3 * m, 100.0, 500.0),
    ]
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: SATURDAY, bars_fn=_make_bars_fn(bars))
    events = await _collect(feed, 100)
    samples = [ev for ev in events if isinstance(ev, BarSample)]
    assert [ev.ts_ns for ev in samples] == [base, base + 3 * m]


async def test_history_older_than_the_grid_can_hold_is_not_replayed():
    # Live on Wednesday with only Monday's bars: the empty columns between them
    # and now would push that history out of the ring, so it is not drawn.
    monday = _et_ns(2026, 7, 13, 15, 59)
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([_flat_bar(monday, 100.0, 10.0)]),
        book_fn=_no_books,
        price_fn=_const_price(101.0),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 4)
    assert not any(isinstance(ev, BarSample) for ev in events)
    books = [ev for ev in events if isinstance(ev, BookState)]
    assert books and all(book.ts_ns >= RTH for book in books)
    assert books[0].anchor_px == 100.0  # the last known close still centres the grid


# --- 2. live: the merged Cboe book -------------------------------------------------


async def test_live_book_is_the_merged_cboe_levels_in_shares():
    reads = [
        [
            _book("edgx", [(100.00, 300.0), (99.99, 100.0)], [(100.01, 200.0)]),
            _book("bzx", [(100.00, 50.0)], [(100.01, 25.0), (100.02, 400.0)]),
        ]
    ]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 6)
    live = [ev for ev in events if isinstance(ev, BookState) and ev.bid_px.size]
    assert live, "the merged book never reached the grid"
    book = live[-1]
    assert book.source == "cboe"
    assert dict(zip(book.bid_px.tolist(), book.bid_sz.tolist(), strict=True)) == {
        99.99: 100.0,
        100.00: 350.0,
    }
    assert dict(zip(book.ask_px.tolist(), book.ask_sz.tolist(), strict=True)) == {
        100.01: 225.0,
        100.02: 400.0,
    }
    assert feed.feed_state == "live"


async def test_live_book_lands_in_an_l2_grid_at_its_price_rows():
    reads = [[_book("edgx", [(100.00, 300.0)], [(100.02, 120.0)])]]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 8)
    books = [ev for ev in events if isinstance(ev, BookState)]
    rows, tick = 512, 0.01
    p0 = round((100.00 - rows * tick / 2.0) / tick) * tick
    grid = Grid(
        GridCfg(
            tick=tick, tick_multiple=1, dt_ns=DT_KEYLESS_GRID_NS, p0=p0, rows=rows,
            ring_columns=4096, mode=MODE_L2,
        )
    )
    cols = []
    for b in books:
        cols.extend(grid.on_book(b.ts_ns, b.bid_px, b.bid_sz, b.ask_px, b.ask_sz))
    last = cols[-1]
    assert int(np.argmax(last.bid)) == round((100.00 - p0) / tick)
    assert int(np.argmax(last.ask)) == round((100.02 - p0) / tick)
    # A full column of an unchanged book reads the displayed size, in shares.
    assert float(last.bid.max()) == pytest.approx(300.0)
    assert float(last.ask.max()) == pytest.approx(120.0)
    assert grid.to_depth(last).ask is not None


async def test_books_are_read_once_per_cycle_and_the_grid_advances_every_column():
    calls: dict[str, int] = {}
    reads = [[_book("edgx", [(100.00, 300.0)], [(100.01, 200.0)])]]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),  # 1 s steps
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads, calls),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 26)
    books = [ev for ev in events if isinstance(ev, BookState)]
    assert len(books) == 26
    ts = [b.ts_ns for b in books]
    assert all(b - a == 10**9 for a, b in zip(ts, ts[1:], strict=False)), "column cadence != 1 s"
    # 26 one-second columns span five 5 s cycles: a read per cycle, not per column.
    assert 5 <= calls["n"] <= 6


async def test_a_slow_book_read_does_not_stall_the_column_cadence():
    release = asyncio.Event()
    started = asyncio.Event()

    async def slow_books() -> list[VenueBook]:
        started.set()
        await release.wait()
        return []

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=slow_books,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 8)
    assert started.is_set() and not release.is_set()
    assert len([e for e in events if isinstance(e, BookState)]) == 8
    release.set()
    await asyncio.sleep(0)


async def test_a_book_that_misses_a_cycle_is_held_then_dropped():
    edgx = _book("edgx", [(100.00, 300.0)], [(100.01, 200.0)])
    bzx = _book("bzx", [(99.99, 50.0)], [(100.02, 75.0)])
    # bzx answers the first read only.
    reads = [[edgx, bzx], [edgx]]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 40)
    books = [ev for ev in events if isinstance(ev, BookState) and ev.bid_px.size]
    has_bzx = [99.99 in b.bid_px.tolist() for b in books]
    assert has_bzx[0], "the first merged book carries both venues"
    # Held across the next reads (3 cycles of 5 s), gone after that.
    held_columns = sum(has_bzx)
    assert 11 <= held_columns <= 21
    assert not has_bzx[-1], "a book that stopped answering must not rest forever"
    assert all(100.00 in b.bid_px.tolist() for b in books), "the answering book stays"


async def test_no_book_for_three_cycles_withholds_depth_and_says_so():
    good = [_book("edgx", [(100.00, 300.0)], [(100.01, 200.0)])]
    reads: list[list[VenueBook]] = [good, [], [], [], [], [], good]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        price_fn=_const_price(100.0),
        sleep_fn=_nosleep,
    )
    events: list[FeedEvent] = []
    states: list[str] = []
    async for ev in feed.events():
        events.append(ev)
        states.append(feed.feed_state)
        # The retries after the notice are thirty seconds apart, so the book
        # returns about a minute after it was lost.
        if len(events) >= 200:
            break
    gaps = [e for e in events if isinstance(e, Marker) and e.kind == "gap"]
    assert len([g for g in gaps if "order book unavailable" in g.text]) == 1
    assert "degraded" in states
    gap_at = next(i for i, e in enumerate(events) if isinstance(e, Marker) and e.kind == "gap")
    after = [e for e in events[gap_at:] if isinstance(e, BookState)]
    # The last good book is dropped once it is older than the hold: nothing stale is drawn.
    assert any(b.bid_px.size == 0 and b.ask_px.size == 0 for b in after)
    # The book returns and the feed says live again.
    assert states[-1] == "live"
    assert after[-1].bid_px.size == 1


# --- 3. live: prints become the tape -------------------------------------------------


async def test_new_prints_become_trades_with_the_venue_clock_and_tag():
    old = VenuePrint(ts_ns=RTH - 60 * 10**9, price=99.50, size=10.0)
    recent = VenuePrint(ts_ns=RTH + 1 * 10**9, price=100.00, size=200.0)
    later = VenuePrint(ts_ns=RTH + 6 * 10**9, price=100.01, size=35.0)
    reads = [
        [_book("edgx", [(99.99, 1.0)], [(100.02, 1.0)], [old, recent])],
        [_book("edgx", [(99.99, 1.0)], [(100.02, 1.0)], [old, recent, later])],
    ]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 14)
    trades = [e for e in events if isinstance(e, Trade)]
    # The first read contributes only the prints of the last cycle; the print from
    # a minute ago happened before the feed was watching.
    assert [(t.price, t.size, t.ts_ns) for t in trades] == [
        (100.00, 200.0, RTH + 1 * 10**9),
        (100.01, 35.0, RTH + 6 * 10**9),
    ]
    for trade in trades:
        assert trade.venue == "EDGX"
        assert trade.side == SIDE_UNKNOWN and trade.side_src == SIDE_SRC_NA


async def test_prints_from_several_books_are_emitted_in_time_order():
    a = VenuePrint(ts_ns=RTH + 2 * 10**9, price=100.02, size=5.0)
    b = VenuePrint(ts_ns=RTH + 1 * 10**9, price=100.01, size=7.0)
    reads = [[_book("edgx", [], [], [a]), _book("byx", [], [], [b])]]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 6)
    trades = [e for e in events if isinstance(e, Trade)]
    assert [(t.venue, t.price) for t in trades] == [("BYX", 100.01), ("EDGX", 100.02)]


async def test_the_last_print_is_the_anchor_while_the_book_is_empty():
    p = VenuePrint(ts_ns=RTH + 1 * 10**9, price=123.45, size=5.0)
    reads = [[_book("edgx", [], [], [p])]]
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn(reads),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 6)
    books = [e for e in events if isinstance(e, BookState)]
    assert books[-1].anchor_px == 123.45


# --- 4. live: the last-price fallback ------------------------------------------------


async def test_a_quiet_symbol_falls_back_to_a_last_price_without_inventing_a_print():
    calls = {"n": 0}

    async def price_fn() -> float:
        calls["n"] += 1
        return 150.25

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn([[_book("edgx", [(150.2, 10.0)], [(150.3, 10.0)])]]),
        price_fn=price_fn,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 40)
    trades = [e for e in events if isinstance(e, Trade)]
    assert trades, "a symbol with no Cboe print must still move"
    # Nothing in the first 10 s, then one poll per 10 s, never one per column.
    assert 2 <= calls["n"] <= 4
    for trade in trades:
        assert trade.venue == "last-price"
        assert trade.size == 0.0  # a scraped price is not a print: no size
        assert trade.price == 150.25
        assert trade.side == SIDE_UNKNOWN and trade.side_src == SIDE_SRC_NA
    books = [e for e in events if isinstance(e, BookState)]
    first_trade_at = events.index(trades[0])
    columns_before = len([e for e in events[:first_trade_at] if isinstance(e, BookState)])
    assert columns_before >= 10
    assert len(books) > columns_before


async def test_fresh_cboe_prints_keep_the_fallback_silent():
    calls = {"n": 0}

    async def price_fn() -> float:
        calls["n"] += 1
        return 1.0

    prints: list[VenuePrint] = []
    state = {"i": 0}

    async def book_fn() -> list[VenueBook]:
        # A new print on every read: the symbol is never quiet.
        state["i"] += 1
        prints.append(VenuePrint(ts_ns=RTH + state["i"] * 5 * 10**9, price=100.0, size=1.0))
        return [_book("edgx", [], [], prints[-10:])]

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=book_fn,
        price_fn=price_fn,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 40)
    assert calls["n"] == 0
    assert all(t.venue == "EDGX" for t in events if isinstance(t, Trade))


# --- 5. market closed and the trading window ----------------------------------------


async def test_market_closed_shows_history_no_trades_and_exposes_state():
    calls = {"price": 0, "book": 0}

    async def price_fn() -> float:
        calls["price"] += 1  # must never be called when closed
        return 123.0

    async def book_fn() -> list[VenueBook]:
        calls["book"] += 1
        return []

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: SATURDAY,
        bars_fn=_make_bars_fn(_concentrated_session()),
        book_fn=book_fn,
        price_fn=price_fn,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 10_000)  # generator ends on its own when closed

    samples = [e for e in events if isinstance(e, BarSample)]
    markers = [e for e in events if isinstance(e, Marker)]
    assert len(samples) == len(_concentrated_session())
    assert not [e for e in events if isinstance(e, Trade)], "closed market emits no live trades"
    assert calls == {"price": 0, "book": 0}, "nothing is polled when closed"
    assert len(markers) == 1 and markers[0].kind == "session_break"
    assert "closed" in markers[0].text and "price history" in markers[0].text

    assert feed.feed_state == "closed"
    # The keyless tier opens with the pre-market: Monday 2026-07-20 04:00 ET.
    assert feed.next_open_ts == _et_ns(2026, 7, 20, 4, 0)


async def test_closed_with_no_bars_still_marks_session_break():
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: SATURDAY, bars_fn=_make_bars_fn([]))
    events = await _collect(feed, 100)
    markers = [e for e in events if isinstance(e, Marker)]
    assert len(markers) == 1 and markers[0].kind == "session_break"
    assert markers[0].ts_ns == SATURDAY
    assert "no cached history" in markers[0].text
    assert feed.feed_state == "closed"


@pytest.mark.parametrize(
    ("hour", "minute", "is_open"),
    [(3, 59, False), (4, 0, True), (9, 0, True), (12, 0, True), (19, 59, True), (20, 0, False)],
)
def test_the_keyless_window_covers_pre_market_to_after_hours(hour, minute, is_open):
    wednesday = _et_ns(2026, 7, 15, hour, minute)
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: wednesday)
    assert feed.is_closed_now() is (not is_open)


def test_the_keyless_window_is_closed_on_a_market_holiday():
    july_3rd = _et_ns(2026, 7, 3, 12, 0)  # Independence Day observed, a Friday
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: july_3rd)
    assert feed.is_closed_now()


async def test_the_live_loop_ends_with_a_session_break_at_the_after_hours_close():
    clock = _StepClock(_et_ns(2026, 7, 15, 19, 59, 55), 10**9)
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=clock,
        bars_fn=_make_bars_fn([]),
        book_fn=_no_books,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 10_000)
    assert isinstance(events[-1], Marker) and events[-1].kind == "session_break"
    assert feed.feed_state == "closed"
    assert feed.next_open_ts == _et_ns(2026, 7, 16, 4, 0)


async def test_closed_history_preparation_remains_finite_if_market_opens_during_fetch():
    clock = {"now": _et_ns(2026, 7, 20, 3, 59)}

    async def delayed_history():
        clock["now"] = _et_ns(2026, 7, 20, 4, 1)
        return [_bar(_et_ns(2026, 7, 17, 15, 59), 100, 101, 99, 100, 10)]

    async def forbidden_poll():
        raise AssertionError("preparation entered unbounded live poll")

    feed = EquityFeed(
        "AAPL", Config(), now_ns_fn=lambda: clock["now"], bars_fn=delayed_history,
        book_fn=forbidden_poll, price_fn=forbidden_poll,
    )
    assert feed.is_closed_now()
    events = [event async for event in feed.closed_history_events()]
    assert [type(event) for event in events] == [BookState, BarSample, Marker]


async def test_keyless_bar_fetch_failure_closed_still_marks_session_break():
    """A Yahoo 429 storm must degrade, not kill the feed: when the initial bar
    fetch raises, a CLOSED market still emits the session_break marker + closed
    state (no crash -> no session restart/backoff loop)."""

    async def broken_bars_fn():
        raise RuntimeError("Yahoo Finance provider request failed after 5 attempts.")

    feed = EquityFeed(
        "AAPL", Config(), now_ns_fn=lambda: SATURDAY, bars_fn=broken_bars_fn, sleep_fn=_nosleep
    )
    events = await _collect(feed, 10_000)  # generator ends on its own
    markers = [e for e in events if isinstance(e, Marker)]
    assert len(markers) == 1 and markers[0].kind == "session_break"
    assert not [e for e in events if isinstance(e, Trade)]
    assert feed.feed_state == "closed"


async def test_keyless_bar_fetch_failure_open_still_lives():
    """Same 429 storm, but while trading: the feed goes live on the book alone
    instead of crashing into the session's restart cycle."""

    async def broken_bars_fn():
        raise RuntimeError("Yahoo Finance provider request failed after 5 attempts.")

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=broken_bars_fn,
        book_fn=_books_fn([[_book("edgx", [(150.2, 10.0)], [(150.3, 10.0)])]]),
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 12)
    books = [e for e in events if isinstance(e, BookState)]
    assert books and books[-1].bid_px.size == 1
    assert feed.feed_state == "live"


# --- 6a. tier auto-select + capability -----------------------------------------


def test_tier_keyless_when_no_keys():
    feed = EquityFeed("AAPL", Config())
    assert feed.tier == "keyless"
    assert feed.capability == {
        # Real displayed depth, re-read whole each cycle, from Cboe's books only.
        "depth": "L2-snapshot",
        "depth_scope": "cboe-top5",
        "tape": "poll",
        "trade_side": "na",
        "cvd": "na",  # SIDE_UNKNOWN is never counted -> cvd is meaningless
        "vwap": "approx",
        "markers": ["gap", "session_break"],
    }
    assert feed.market == EQUITY_MARKET
    assert feed.symbol == "AAPL"


def test_tier_alpaca_when_both_keys():
    feed = EquityFeed("AAPL", Config(alpaca_key="k", alpaca_secret="s"))
    assert feed.tier == "alpaca"
    assert feed.capability["depth"] == "L1"
    assert feed.capability["trade_side"] == "inferred"
    assert feed.capability["tape"] == "tick"
    assert feed.capability["cvd"] == "inferred"  # inferred side -> inferred cvd


def test_tier_finnhub_when_finnhub_key_only():
    feed = EquityFeed("AAPL", Config(finnhub_key="tok"))
    assert feed.tier == "finnhub"
    assert feed.capability["depth"] == "N/A"
    assert feed.capability["trade_side"] == "inferred"
    assert feed.capability["cvd"] == "inferred"


def test_symbol_uppercased():
    assert EquityFeed("aapl", Config()).symbol == "AAPL"


# --- 6b. keyed sink side inference (translation seam) --------------------------


def _stk_trade(ts: int, price: float) -> StkTrade:
    # Anchored on a plausible 2023 UTC-ns stamp: the keyed sink now gates live
    # records with implausible (e.g. 1970-era) stamps at ingestion, and the old
    # 1 ns-ordinal stamps would be dropped before the rule under test.
    return StkTrade(
        source="finnhub",
        symbol="AAPL",
        symbol_raw="AAPL",
        asset_class=AssetClass.EQUITY,
        local_ts=_EQ_VENUE_NS + ts,
        source_ts=_EQ_VENUE_NS + ts,
        id="",
        price=price,
        amount=10.0,
        # US equity providers do not publish the aggressor; the feed infers it.
        side=Side.UNKNOWN,
    )


async def test_keyed_sink_tick_rule_finnhub():
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=False)
    await sink.put(_stk_trade(1, 100.0))  # first -> BUY default
    await sink.put(_stk_trade(2, 101.0))  # up -> BUY
    await sink.put(_stk_trade(3, 100.5))  # down -> SELL
    await sink.put(_stk_trade(4, 100.5))  # flat -> carries SELL
    sides = [t.side for t in out]
    assert sides == [SIDE_BUY, SIDE_BUY, SIDE_SELL, SIDE_SELL]
    assert all(isinstance(t, Trade) and t.side_src == SIDE_SRC_INFERRED for t in out)
    assert all(t.venue == "finnhub" for t in out)


async def test_keyed_sink_quote_rule_alpaca_emits_bbo_and_infers_side():
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=True)
    # streamed L1 quote sets the midpoint (100.5) and surfaces as a BBO.
    await sink.put(
        StkQuote(
            source="alpaca",
            symbol="AAPL",
            symbol_raw="AAPL",
            asset_class=AssetClass.EQUITY,
            local_ts=_EQ_VENUE_NS,
            source_ts=_EQ_VENUE_NS,
            bid_px=100.0,
            bid_sz=5.0,
            ask_px=101.0,
            ask_sz=7.0,
        )
    )
    await sink.put(_stk_trade(2, 100.9))  # above mid -> BUY
    await sink.put(_stk_trade(3, 100.1))  # below mid -> SELL
    bbos = [e for e in out if isinstance(e, BBO)]
    trades = [e for e in out if isinstance(e, Trade)]
    assert len(bbos) == 1 and bbos[0].bid_px == 100.0 and bbos[0].ask_px == 101.0
    assert [t.side for t in trades] == [SIDE_BUY, SIDE_SELL]
    assert all(t.side_src == SIDE_SRC_INFERRED for t in trades)
    # the streamed L1 quote also lands as a real two-sided depth column (fills
    # the keyed depth channel; sizes emitted raw so the imbalance survives).
    books = [e for e in out if isinstance(e, BookState)]
    assert len(books) == 1
    b = books[0]
    assert b.bid_px.tolist() == [100.0] and b.bid_sz.tolist() == [5.0]
    assert b.ask_px.tolist() == [101.0] and b.ask_sz.tolist() == [7.0]


async def test_keyed_sink_alpaca_skips_zero_price_quote_for_depth():
    """Alpaca sends a 0 price to mean "no quote on this side" (at the open, on
    illiquid names, during a halt). Such a quote must NOT become a depth level:
    a 0-priced bid/ask would snap the grid's reanchor midpoint to ~half the real
    price. The same frame must not surface as a BBO either: the Market Strip would
    otherwise show a zero bid, a full-ask spread and a fresh quote clock."""
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=True)
    await sink.put(
        StkQuote(
            source="alpaca",
            symbol="AAPL",
            symbol_raw="AAPL",
            asset_class=AssetClass.EQUITY,
            local_ts=_EQ_VENUE_NS,
            source_ts=_EQ_VENUE_NS,
            bid_px=0.0,  # "no bid" sentinel
            bid_sz=0.0,
            ask_px=101.0,
            ask_sz=7.0,
        )
    )
    assert not [e for e in out if isinstance(e, BBO)], "0-priced quote must not become a BBO"
    assert not [e for e in out if isinstance(e, BookState)], "0-priced quote must not become depth"
    assert sink.dropped_quotes == 1
    # a healthy two-sided quote afterwards DOES produce a depth column.
    await sink.put(
        StkQuote(
            source="alpaca", symbol="AAPL", symbol_raw="AAPL",
            asset_class=AssetClass.EQUITY,
            local_ts=_EQ_VENUE_NS + 1, source_ts=_EQ_VENUE_NS + 1,
            bid_px=100.0, bid_sz=5.0, ask_px=101.0, ask_sz=7.0,
        )
    )
    assert len([e for e in out if isinstance(e, BookState)]) == 1


async def test_keyed_sink_zero_price_quote_keeps_the_last_usable_midpoint():
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=True)
    await sink.put(
        StkQuote(
            source="alpaca", symbol="AAPL", symbol_raw="AAPL",
            asset_class=AssetClass.EQUITY,
            local_ts=_EQ_VENUE_NS, source_ts=_EQ_VENUE_NS,
            bid_px=100.0, bid_sz=5.0, ask_px=101.0, ask_sz=7.0,
        )
    )
    await sink.put(
        StkQuote(
            source="alpaca", symbol="AAPL", symbol_raw="AAPL",
            asset_class=AssetClass.EQUITY,
            local_ts=_EQ_VENUE_NS + 1, source_ts=_EQ_VENUE_NS + 1,
            bid_px=0.0, bid_sz=0.0, ask_px=101.0, ask_sz=7.0,
        )
    )
    await sink.put(_stk_trade(2, 100.9))  # above the surviving 100.5 midpoint -> BUY
    trades = [e for e in out if isinstance(e, Trade)]
    assert [t.side for t in trades] == [SIDE_BUY]
    assert len([e for e in out if isinstance(e, BBO)]) == 1


# --- 6c. re-callable events() + protocol ---------------------------------------


async def test_events_recallable_fresh_state():
    sat = _et_ns(2026, 7, 18, 12, 0)
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: sat,
        bars_fn=_make_bars_fn(_concentrated_session()),
    )
    first = await _collect(feed, 10_000)
    second = await _collect(feed, 10_000)
    n_books_1 = sum(isinstance(e, BookState) for e in first)
    n_books_2 = sum(isinstance(e, BookState) for e in second)
    assert n_books_1 == n_books_2 > 0
    assert feed.feed_state == "closed"  # honest after each run


def test_equityfeed_satisfies_feed_protocol():
    feed = EquityFeed("AAPL", Config())
    assert isinstance(feed, Feed)
    assert isinstance(feed.capability, dict)


# --- shared injectable seams ---------------------------------------------------


def _make_bars_fn(bars: list[StkBar]):
    async def bars_fn() -> list[StkBar]:
        return list(bars)

    return bars_fn


async def test_keyed_provider_error_is_forwarded_to_the_session():
    from flowmap_server.feeds.base import BoundedFeedQueue
    from flowmap_server.feeds.equity import _FeedEnd

    class Rejected:
        name = "alpaca"

        async def run(self, *, max_reconnects: int) -> None:
            raise ConnectionError("invalid API key")

    queue = BoundedFeedQueue()
    await EquityFeed._drive_keyed(Rejected(), _EquitySink(queue.put_nowait, use_quote_rule=True), queue)
    end = await queue.get()
    assert isinstance(end, _FeedEnd) and isinstance(end.exc, ConnectionError)


async def test_keyed_provider_clean_return_is_not_a_clean_end():
    from flowmap_server.feeds.base import BoundedFeedQueue
    from flowmap_server.feeds.equity import _FeedEnd

    class Returned:
        name = "finnhub"

        async def run(self, *, max_reconnects: int) -> None:
            return None

    queue = BoundedFeedQueue()
    await EquityFeed._drive_keyed(Returned(), _EquitySink(queue.put_nowait, use_quote_rule=False), queue)
    end = await queue.get()
    assert isinstance(end, _FeedEnd) and isinstance(end.exc, RuntimeError)


async def test_silent_keyed_provider_fails_the_feed_for_restart(monkeypatch):
    from flowmap_server.feeds import equity as equity_module

    monkeypatch.setattr(equity_module, "_KEYED_CHECK_S", 0.01)
    monkeypatch.setattr(equity_module, "_KEYED_EVENT_TIMEOUT_S", 0.05)

    class Silent:
        name = "alpaca"

        async def run(self, *, max_reconnects: int) -> None:
            await asyncio.Event().wait()

    feed = EquityFeed(
        "AAPL",
        Config(alpaca_key="k", alpaca_secret="s"),
        now_ns_fn=lambda: _et_ns(2026, 7, 15, 11, 0),
        provider_factory=lambda sink: Silent(),
    )
    with pytest.raises(RuntimeError, match="no alpaca equity events"):
        await _collect(feed, 10)


async def test_keyed_feed_closes_at_rth_end_even_while_trades_keep_flowing(monkeypatch):
    """Liquid names keep printing after the close. The keyed loop must see the closed
    calendar on its own cadence, not only when the stream goes quiet."""
    from flowmap_server.feeds import equity as equity_module

    monkeypatch.setattr(equity_module, "_KEYED_CHECK_S", 0.001)
    reads = {"n": 0}

    def clock() -> int:
        reads["n"] += 1
        # RTH for the first few clock reads, then after the close. Kept small so the
        # close is reached long before the event cap even where loop.time() ticks
        # coarsely (about 15.6 ms on some Windows builds).
        return _et_ns(2026, 7, 15, 11, 0) if reads["n"] <= 20 else _et_ns(2026, 7, 15, 17, 0)

    class Chatty:
        name = "alpaca"

        def __init__(self, sink) -> None:
            self.sink = sink

        async def run(self, *, max_reconnects: int) -> None:
            i = 0
            while True:
                i += 1
                await self.sink.put(_stk_trade(i, 100.0 + (i % 5) * 0.01))
                await asyncio.sleep(0)

    feed = EquityFeed(
        "AAPL",
        Config(alpaca_key="k", alpaca_secret="s"),
        now_ns_fn=clock,
        provider_factory=lambda sink: Chatty(sink),
    )
    events = await asyncio.wait_for(_collect(feed, 50_000), timeout=20)
    markers = [e for e in events if isinstance(e, Marker)]
    assert markers and markers[-1].kind == "session_break"
    assert feed.feed_state == "closed" and feed.next_open_ts is not None


async def test_keyed_tier_outside_rth_marks_closed_without_connecting():
    def refuse(sink):
        raise AssertionError("a closed market must not open a keyed stream")

    feed = EquityFeed(
        "AAPL",
        Config(alpaca_key="k", alpaca_secret="s"),
        now_ns_fn=lambda: _et_ns(2026, 7, 18, 12, 0),  # Saturday
        provider_factory=refuse,
    )
    events = await _collect(feed, 10)
    assert [e.kind for e in events if isinstance(e, Marker)] == ["session_break"]
    assert feed.feed_state == "closed" and feed.next_open_ts is not None


async def test_repeated_price_poll_failures_surface_a_gap_marker():
    async def no_price() -> None:
        return None

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(_et_ns(2026, 7, 15, 11, 0), 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=_books_fn([[_book("edgx", [(150.2, 10.0)], [(150.3, 10.0)])]]),
        price_fn=no_price,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 60)
    gaps = [e for e in events if isinstance(e, Marker) and e.kind == "gap"]
    assert len(gaps) == 1 and "live price unavailable" in gaps[0].text
    assert not [e for e in events if isinstance(e, Trade)]


def _const_price(px: float):
    async def price_fn() -> float:
        return px

    return price_fn


# --- keyless book retries back off after the notice ---------------------------


async def test_failing_book_reads_back_off_to_thirty_seconds_then_return_to_the_cycle():
    clock = {"t": RTH}
    reads: list[int] = []
    good = [_book("edgx", [(100.00, 300.0)], [(100.01, 200.0)])]

    async def book_fn() -> list[VenueBook]:
        reads.append(clock["t"])
        return [] if len(reads) <= 3 else list(good)

    async def sleep_fn(seconds: float) -> None:
        clock["t"] += round(seconds * 10**9)
        await asyncio.sleep(0)

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: clock["t"],
        bars_fn=_make_bars_fn([]),
        book_fn=book_fn,
        price_fn=_const_price(100.0),
        sleep_fn=sleep_fn,
    )
    await _collect(feed, 120)
    assert len(reads) >= 5
    # Before the notice the reads keep their five-second cycle.
    assert reads[2] - reads[1] == 5 * 10**9
    # From the notice on, a failed read is retried thirty seconds later.
    assert reads[3] - reads[2] >= 30 * 10**9
    # A read that succeeds returns to the normal cycle.
    assert reads[4] - reads[3] == 5 * 10**9


# --- a cancelled book read is finished before the stream closes -----------------


async def test_a_cancelled_book_read_has_finished_when_the_stream_is_closed():
    started: list[bool] = []
    finished: list[bool] = []

    async def slow_books() -> list[VenueBook]:
        started.append(True)
        try:
            await asyncio.Event().wait()
        finally:
            finished.append(True)
        return []

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(RTH, 10**9),
        bars_fn=_make_bars_fn([]),
        book_fn=slow_books,
        price_fn=_const_price(100.0),
        sleep_fn=_nosleep,
    )
    # The live loop is closed directly, so its finally has run when aclose returns.
    live = feed._keyless_live(100.0, has_history=False)
    for _ in range(5):
        await live.__anext__()
    assert started == [True]
    assert finished == []
    await live.aclose()
    assert finished == [True]


# --- the record header's clock + field names, pinned --------------------------
# Replacing `record.source_ts` with `record.local_ts` in `_rec_ts`/`_bar_ts` must
# fail a test. Every equity fixture above sets `local_ts == source_ts`, so the
# venue clock and the field names (`source`, `amount`, `OHLCV`) get assertions
# that can actually fail.

_EQ_VENUE_NS = 1_700_000_000_000_000_000
_EQ_LOCAL_NS = _EQ_VENUE_NS + 555_000_000  # receive clock, 555 ms later


def _skewed_trade() -> StkTrade:
    return StkTrade(
        source="finnhub",
        symbol="AAPL",
        symbol_raw="AAPL",
        asset_class=AssetClass.EQUITY,
        local_ts=_EQ_LOCAL_NS,
        source_ts=_EQ_VENUE_NS,
        id="",
        price=100.0,
        amount=42.0,
        side=Side.UNKNOWN,
    )


async def test_keyed_trade_carries_the_provider_clock_and_the_field_names() -> None:
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=False)
    await sink.put(_skewed_trade())
    (trade,) = out
    assert isinstance(trade, Trade)
    assert trade.ts_ns == _EQ_VENUE_NS  # source_ts, NOT local_ts
    assert trade.ts_ns != _EQ_LOCAL_NS
    assert trade.size == 42.0  # record `amount` surfaces as the event `size`
    assert trade.venue == "finnhub"  # record `source` surfaces as the event `venue`
    # No US equity provider publishes the aggressor, so the side is inferred and
    # says so — never laundered into an exchange-true claim.
    assert trade.side_src == SIDE_SRC_INFERRED


async def test_keyed_trade_falls_back_to_the_receive_clock_only_when_unstamped() -> None:
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=False)
    await sink.put(msgspec.structs.replace(_skewed_trade(), source_ts=None))
    (trade,) = out
    assert trade.ts_ns == _EQ_LOCAL_NS


async def test_warmup_bars_use_the_provider_clock() -> None:
    """The price-history column timestamps come from the bar's own clock."""
    bar = msgspec.structs.replace(
        _bar(_EQ_LOCAL_NS, 10.0, 10.0, 10.0, 10.0, 5.0), source_ts=_EQ_VENUE_NS
    )
    assert _bar_ts(bar) == _EQ_VENUE_NS
    assert _bar_ts(msgspec.structs.replace(bar, source_ts=None)) == _EQ_LOCAL_NS
