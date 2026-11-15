"""Asset-market feed tests: hand-built quotes and bars, injected seams, NO network.

Futures, currency pairs, indices and bond yields. Every clock, bar, poll and asset-feed answer is
injected (``now_ns_fn``, ``sleep_fn``, ``bars_fn``, ``snapshot_fn``, a fake asset feed), so pytest
never touches a publisher. The fake clock advances only when the feed sleeps, and every live loop
is stopped by an event cap, so each ``events()`` run terminates without real time.
"""

from __future__ import annotations

import asyncio
import datetime
import math
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Sequence
from typing import cast

import numpy as np
import pytest
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV as EqBar
from crocodile.equity.universal.live.assets import AssetKind, AssetQuote
from crocodile.equity.universal.live.model import LiveLevel, LiveListing, LiveSnapshot
from crocodile.equity.universal.live.sources.yahoo_chart import MinuteBar

from flowmap_server.config import Config
from flowmap_server.feeds import asset_markets
from flowmap_server.feeds.asset_markets import (
    AssetMarketFeed,
    _listing_order,
    _TimeProfileBuilder,
    asset_backfill_fn,
    asset_board,
    asset_market,
    asset_market_labels,
    asset_market_strings,
    asset_symbol,
    asset_ticker,
    is_asset_market,
    reset_asset_state,
    snapshot_of,
)
from flowmap_server.feeds.base import BarSample, BookState, FeedEvent
from flowmap_server.feeds.equity_markets import is_equity_market
from flowmap_server.feeds.equity_profile import _ProfileBuilder
from flowmap_server.feeds.router import build_feed
from flowmap_server.proto import events
from flowmap_server.proto.events import Marker, Trade

SEC = 10**9
UTC = datetime.timezone.utc
WED = datetime.date(2026, 11, 11)
FRI = datetime.date(2026, 11, 13)
SAT = datetime.date(2026, 11, 14)
SUN = datetime.date(2026, 11, 15)


@pytest.fixture(autouse=True)
def _asset_state():
    reset_asset_state()
    yield
    reset_asset_state()


# --- seams ----------------------------------------------------------------------


def _utc(day: datetime.date, hh: int, mm: int = 0, ss: int = 0) -> int:
    """UTC ns of a wall-clock time, computed exactly as the feed computes its own stamps."""
    dt = datetime.datetime.combine(day, datetime.time(hh, mm, ss), tzinfo=UTC)
    return int(dt.timestamp() * 1e9)


class FakeClock:
    """A UTC-ns clock that advances only when the feed sleeps."""

    def __init__(self, start_ns: int) -> None:
        self.now_ns = start_ns

    def __call__(self) -> int:
        return self.now_ns

    async def sleep(self, seconds: float) -> None:
        self.now_ns += round(seconds * SEC)
        await asyncio.sleep(0)  # let a pending poll task run, as a real sleep would


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


def _feed(
    market: str,
    symbol: str,
    clock: FakeClock,
    *,
    bars: Sequence[EqBar] = (),
    snapshots: Callable[[], Awaitable[LiveSnapshot | None]] | None = None,
) -> AssetMarketFeed:
    async def bars_fn() -> list[EqBar]:
        return list(bars)

    return AssetMarketFeed(
        symbol,
        market,
        Config(),
        now_ns_fn=clock,
        bars_fn=bars_fn,
        snapshot_fn=snapshots if snapshots is not None else Script(),
        sleep_fn=clock.sleep,
    )


async def _take(gen: AsyncIterator[FeedEvent], cap: int) -> list[FeedEvent]:
    """Consume a feed generator up to ``cap`` events, then close it."""
    out: list[FeedEvent] = []
    typed = cast(AsyncGenerator[FeedEvent, None], gen)
    try:
        async for event in typed:
            out.append(event)
            if len(out) >= cap:
                break
    finally:
        await typed.aclose()
    return out


async def _drain(gen: AsyncIterator[FeedEvent]) -> list[FeedEvent]:
    """Consume a generator that ends by itself."""
    out: list[FeedEvent] = []
    typed = cast(AsyncGenerator[FeedEvent, None], gen)
    try:
        async for event in typed:
            out.append(event)
    finally:
        await typed.aclose()
    return out


# --- records --------------------------------------------------------------------


def _minute(
    ts_ns: int, o: float, h: float, low: float, c: float, v: float, *, symbol: str = "EURUSD"
) -> EqBar:
    return EqBar(
        source="yahoo_chart",
        symbol=symbol,
        symbol_raw=symbol,
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


def _daily(ts_ns: int, o: float, h: float, low: float, c: float, v: float) -> EqBar:
    return EqBar(
        source="yahoo_chart",
        symbol="EURUSD",
        symbol_raw="EURUSD",
        asset_class=AssetClass.EQUITY,
        local_ts=ts_ns,
        source_ts=ts_ns,
        interval="1d",
        open=o,
        high=h,
        low=low,
        close=c,
        volume=v,
    )


def _levels(pairs: tuple[tuple[float, float | None], ...]) -> tuple[LiveLevel, ...]:
    return tuple(LiveLevel(price=p, size=s) for p, s in pairs)


def _quote_snap(
    *,
    captured_ns: int,
    last: float | None = None,
    high: float | None = None,
    low: float | None = None,
    volume: float | None = None,
) -> LiveSnapshot:
    return LiveSnapshot(
        source="tradingview",
        listing=LiveListing(mic="", local_symbol="X"),
        symbol_raw="X",
        captured_ns=captured_ns,
        last=last,
        high=high,
        low=low,
        volume=volume,
    )


def _row(kind: AssetKind, venue: str, symbol: str) -> AssetQuote:
    return AssetQuote(
        kind=kind, ticker=f"{venue}:{symbol}", venue=venue, symbol=symbol, captured_ns=0
    )


# --- 1. market grammar -----------------------------------------------------------


def test_a_futures_market_names_its_venue_case_insensitively() -> None:
    assert asset_market("futures-eurex") == (AssetKind.FUTURE, "EUREX")
    assert asset_market("FUTURES-EUREX") == (AssetKind.FUTURE, "EUREX")


def test_an_unknown_futures_venue_and_a_bare_futures_prefix_are_not_markets() -> None:
    assert asset_market("futures-nope") is None
    assert asset_market("futures") is None
    assert asset_market("futures-") is None


def test_the_currency_bond_and_index_markets_carry_their_venue() -> None:
    assert asset_market("forex") == (AssetKind.FOREX, "FX_IDC")
    assert asset_market("bonds") == (AssetKind.BOND, "TVC")
    assert asset_market("indices") == (AssetKind.INDEX, None)


@pytest.mark.parametrize("market", ["equity", "world-xist", "binance"])
def test_other_markets_are_not_asset_markets(market: str) -> None:
    assert asset_market(market) is None
    assert not is_asset_market(market)


@pytest.mark.parametrize(
    "market", ["futures-eurex", "forex", "indices", "bonds", "futures", "equity"]
)
def test_is_asset_market_agrees_with_asset_market(market: str) -> None:
    assert is_asset_market(market) == (asset_market(market) is not None)


def test_the_market_strings_end_with_the_three_kinds_and_each_is_an_asset_market() -> None:
    strings = asset_market_strings()
    assert strings[-3:] == ["forex", "indices", "bonds"]
    futures = strings[:-3]
    assert "futures-eurex" in futures
    assert all(s.startswith("futures-") and s == s.lower() for s in futures)
    assert all(is_asset_market(s) for s in strings)


def test_every_market_string_has_a_readable_label() -> None:
    assert set(asset_market_strings()) <= set(asset_market_labels())


# --- 2. tickers -----------------------------------------------------------------


def test_a_futures_ticker_is_venue_colon_symbol() -> None:
    assert asset_ticker(AssetKind.FUTURE, "EUREX", "FDAX1!") == "EUREX:FDAX1!"


def test_an_index_symbol_that_is_a_full_ticker_passes_through() -> None:
    assert asset_ticker(AssetKind.INDEX, None, "SP:SPX") == "SP:SPX"


def test_a_bare_index_symbol_is_refused_with_the_full_ticker_hint() -> None:
    with pytest.raises(ValueError, match="SP:SPX"):
        asset_ticker(AssetKind.INDEX, None, "SPX")


def test_the_symbol_is_stripped_before_the_ticker_is_built() -> None:
    assert asset_ticker(AssetKind.FUTURE, "EUREX", "  FDAX1!  ") == "EUREX:FDAX1!"


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ("futures-eurex", True),
        ("forex", True),
        ("indices", True),
        ("bonds", True),
        ("world-xist", True),
        ("equity", True),
        ("binance", False),
        ("sim", False),
    ],
)
def test_the_equity_market_test_covers_the_asset_markets(market: str, expected: bool) -> None:
    assert is_equity_market(market) is expected


# --- 4. router ------------------------------------------------------------------


def test_the_router_sends_a_future_to_an_asset_market_feed() -> None:
    feed = build_feed(
        events.Subscribe(market="futures-cme_mini", symbol="ES1!", mode="live"),
        Config(),
        realtime_sim=False,
    )
    assert isinstance(feed, AssetMarketFeed)
    assert feed.ticker == "CME_MINI:ES1!"


def test_the_router_sends_a_currency_pair_to_an_asset_market_feed() -> None:
    feed = build_feed(
        events.Subscribe(market="forex", symbol="EURUSD", mode="live"),
        Config(),
        realtime_sim=False,
    )
    assert isinstance(feed, AssetMarketFeed)
    assert feed.ticker == "FX_IDC:EURUSD"


def test_the_router_refuses_a_bare_index_symbol() -> None:
    with pytest.raises(ValueError):
        build_feed(
            events.Subscribe(market="indices", symbol="SPX", mode="live"),
            Config(),
            realtime_sim=False,
        )


# --- 5. constructor and capability -----------------------------------------------


def test_a_future_states_synth_depth_in_utc_on_a_volume_basis() -> None:
    feed = _feed("futures-cme_mini", "ES1!", FakeClock(_utc(WED, 12)))
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["exchange_tz"] == "UTC"
    assert feed.capability["instrument_kind"] == "future"
    assert feed.capability["profile_basis"] == "volume"


@pytest.mark.parametrize(
    ("market", "symbol", "kind"),
    [("forex", "EURUSD", "forex"), ("indices", "SP:SPX", "index"), ("bonds", "US10Y", "bond")],
)
def test_a_forex_index_or_bond_profile_is_time_at_price(
    market: str, symbol: str, kind: str
) -> None:
    feed = _feed(market, symbol, FakeClock(_utc(WED, 12)))
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["exchange_tz"] == "UTC"
    assert feed.capability["instrument_kind"] == kind
    assert feed.capability["profile_basis"] == "time"


def test_the_feed_is_keyless_with_an_adaptive_tick() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(WED, 12)))
    assert feed.tier == "keyless"
    assert feed.price_adaptive_tick is True


def test_the_empty_symbol_is_the_capability_probe() -> None:
    feed = AssetMarketFeed("", "forex", Config())
    assert feed.ticker == ""


def test_a_non_asset_market_is_refused() -> None:
    with pytest.raises(NotImplementedError):
        AssetMarketFeed("EURUSD", "binance", Config())


# --- 6. session rule -------------------------------------------------------------


def test_a_weekday_midday_is_open() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(WED, 12)))
    assert feed._session_state(_utc(WED, 12)) == ("open", None)
    assert not feed.is_closed_now()


def test_a_saturday_is_closed_with_the_coming_sunday_reopening() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(SAT, 12)))
    assert feed._session_state(_utc(SAT, 12)) == ("closed", _utc(SUN, 22))
    assert feed.is_closed_now()


def test_friday_2230_utc_is_closed_and_friday_2130_utc_is_open() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(FRI, 22, 30)))
    assert feed._session_state(_utc(FRI, 22, 30)) == ("closed", _utc(SUN, 22))
    assert feed._session_state(_utc(FRI, 21, 30)) == ("open", None)


def test_sunday_2100_utc_is_closed_and_sunday_2230_utc_is_open() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(SUN, 21)))
    assert feed._session_state(_utc(SUN, 21)) == ("closed", _utc(SUN, 22))
    assert feed._session_state(_utc(SUN, 22, 30)) == ("open", None)


def test_the_weekend_reopening_is_the_sunday_2200_utc_stamp_in_ns() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(SAT, 9)))
    _, next_open = feed._session_state(_utc(SAT, 9))
    assert next_open == _utc(SUN, 22)


def test_a_chart_whose_newest_minute_is_over_90_minutes_old_is_closed() -> None:
    feed = _feed("futures-cme_mini", "ES1!", FakeClock(_utc(WED, 12, 1)))
    asset_markets._note_bars(feed.ticker, [_utc(WED, 10, 0)])  # 121 minutes before now
    assert feed._session_state(_utc(WED, 12, 1)) == ("closed", None)


def test_a_chart_with_a_bar_30_minutes_old_is_open() -> None:
    feed = _feed("futures-cme_mini", "ES1!", FakeClock(_utc(WED, 12)))
    asset_markets._note_bars(feed.ticker, [_utc(WED, 11, 30)])
    assert feed._session_state(_utc(WED, 12)) == ("open", None)


def test_a_chart_with_nothing_noted_is_open() -> None:
    feed = _feed("futures-cme_mini", "ES1!", FakeClock(_utc(WED, 12)))
    assert feed._session_state(_utc(WED, 12)) == ("open", None)


# --- 7. trading day and stale profile -------------------------------------------


def test_the_trading_day_rolls_at_2200_utc() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(WED, 12)))
    before = feed._et_date(_utc(WED, 21, 59))
    after = feed._et_date(_utc(WED, 22, 1))
    assert before == WED
    assert after == WED + datetime.timedelta(days=1)


def test_a_profile_is_never_stale() -> None:
    feed = _feed("forex", "EURUSD", FakeClock(_utc(WED, 12)))
    assert feed._stale_profile_date(0, _utc(WED, 12)) is None
    assert feed._stale_profile_date(_utc(SAT, 1), _utc(WED, 12)) is None


# --- 8. snapshot_of --------------------------------------------------------------


def test_a_quote_carries_its_figures_into_the_snapshot() -> None:
    quote = AssetQuote(
        kind=AssetKind.FUTURE,
        ticker="CME_MINI:ES1!",
        venue="CME_MINI",
        symbol="ES1!",
        captured_ns=123,
        name="E-mini S&P",
        currency="USD",
        last=5000.0,
        open=4990.0,
        high=5010.0,
        low=4980.0,
        prev_close=4995.0,
        volume=7.0,
        bid=4999.75,
        ask=5000.25,
    )
    snap = snapshot_of(quote)
    assert snap.last == 5000.0
    assert snap.prev_close == 4995.0
    assert snap.open == 4990.0
    assert snap.high == 5010.0
    assert snap.low == 4980.0
    assert snap.volume == 7.0
    assert snap.currency == "USD"
    assert snap.name == "E-mini S&P"
    assert snap.symbol_raw == "CME_MINI:ES1!"
    assert snap.listing.local_symbol == "ES1!"


def test_a_bid_and_an_ask_become_single_levels_without_a_size() -> None:
    quote = AssetQuote(
        kind=AssetKind.FOREX,
        ticker="FX_IDC:EURUSD",
        venue="FX_IDC",
        symbol="EURUSD",
        captured_ns=1,
        bid=1.09,
        ask=1.11,
    )
    snap = snapshot_of(quote)
    assert len(snap.bids) == 1 and len(snap.asks) == 1
    assert snap.bids[0].price == 1.09 and snap.bids[0].size is None
    assert snap.asks[0].price == 1.11 and snap.asks[0].size is None


def test_a_missing_bid_gives_an_empty_bid_side() -> None:
    quote = AssetQuote(
        kind=AssetKind.FOREX,
        ticker="FX_IDC:EURUSD",
        venue="FX_IDC",
        symbol="EURUSD",
        captured_ns=1,
        ask=1.11,
    )
    snap = snapshot_of(quote)
    assert snap.bids == ()
    assert len(snap.asks) == 1


# --- 9. profile builders ---------------------------------------------------------


def test_two_zero_volume_minutes_at_different_prices_weigh_one_each() -> None:
    builder = _TimeProfileBuilder(0.01)
    assert builder.add_bar(_minute(_utc(WED, 10, 0), 100.0, 101.0, 99.0, 100.0, 0.0))
    assert builder.add_bar(_minute(_utc(WED, 10, 1), 200.0, 201.0, 199.0, 200.0, 0.0))
    assert builder.total_volume() == 2.0
    book = builder.book_state(_utc(WED, 10, 1), None)
    assert len(book.bid_px) == 2
    assert np.all(book.bid_sz == book.bid_sz[0])


def test_a_daily_bar_counts_at_its_close_not_its_typical_price() -> None:
    builder = _TimeProfileBuilder(0.01)
    # Typical price (110 + 90 + 105) / 3 is about 101.67; the close is 105.
    assert builder.add_bar(_daily(_utc(WED, 22), 100.0, 110.0, 90.0, 105.0, 0.0))
    book = builder.book_state(_utc(WED, 22), None)
    assert len(book.bid_px) == 1
    assert book.bid_px[0] == pytest.approx(105.0)


def test_a_non_finite_bar_is_skipped() -> None:
    builder = _TimeProfileBuilder(0.01)
    assert not builder.add_bar(_minute(_utc(WED, 10), 100.0, 101.0, 99.0, math.nan, 0.0))
    assert builder.total_volume() == 0.0
    assert not builder.has_profile()


def test_add_volume_rejects_non_finite_and_non_positive_input() -> None:
    builder = _ProfileBuilder(0.01)
    assert not builder.add_volume(math.nan, 1.0)
    assert not builder.add_volume(math.inf, 1.0)
    assert not builder.add_volume(0.0, 1.0)
    assert not builder.add_volume(-5.0, 1.0)
    assert not builder.add_volume(100.0, math.inf)
    assert not builder.add_volume(100.0, 0.0)
    assert not builder.add_volume(100.0, -1.0)
    assert builder.total_volume() == 0.0
    assert not builder.has_profile()


def test_add_volume_accumulates_at_the_bucket_of_its_price() -> None:
    builder = _ProfileBuilder(0.01)
    assert builder.add_volume(100.0, 2.5)
    assert builder.add_volume(100.0, 1.5)
    assert builder.total_volume() == 4.0
    assert len(builder.book_state(0, None).bid_px) == 1


# --- 10. warmup from chart bars, live path ----------------------------------------


async def test_a_forex_warmup_of_zero_volume_bars_still_draws_a_time_profile() -> None:
    clock = FakeClock(_utc(WED, 10, 5))
    bars = [_minute(_utc(WED, 10, m), 1.10, 1.11, 1.09, 1.10 + m / 1000, 0.0) for m in range(5)]
    feed = _feed("forex", "EURUSD", clock, bars=bars)
    out = await _take(feed.events(), cap=10)
    assert [type(e) for e in out] == [BookState, BarSample] * 5
    books = [e for e in out if isinstance(e, BookState)]
    assert all(len(b.bid_px) + len(b.ask_px) > 0 for b in books)
    samples = [e for e in out if isinstance(e, BarSample)]
    assert [s.ts_ns for s in samples] == [_utc(WED, 10, m) for m in range(5)]


async def test_a_futures_warmup_with_volume_bars_draws_a_normalised_volume_profile() -> None:
    clock = FakeClock(_utc(WED, 10, 5))
    bars = [
        _minute(
            _utc(WED, 10, m), 5000.0, 5001.0, 4999.0, 5000.0 + m, 100.0 * (m + 1), symbol="ES1!"
        )
        for m in range(5)
    ]
    feed = _feed("futures-cme_mini", "ES1!", clock, bars=bars)
    out = await _take(feed.events(), cap=10)
    assert [type(e) for e in out] == [BookState, BarSample] * 5
    last = [e for e in out if isinstance(e, BookState)][-1]
    assert last.bid_px.size + last.ask_px.size > 0
    peak = max(float(np.max(last.bid_sz, initial=0.0)), float(np.max(last.ask_sz, initial=0.0)))
    assert peak == pytest.approx(1000.0)


# --- 11. no chart bars: the profile grows from the polls --------------------------


async def test_a_bond_without_chart_bars_draws_its_session_bar_at_the_last_price() -> None:
    clock = FakeClock(_utc(WED, 12))
    session = _quote_snap(captured_ns=clock.now_ns, last=4.2, high=4.3, low=4.1, volume=None)
    feed = _feed("bonds", "US10Y", clock, snapshots=Script(session, then=session))
    out = await _take(feed.events(), cap=2)
    assert [type(e) for e in out] == [BookState, BarSample]
    book = out[0]
    assert isinstance(book, BookState)
    assert len(book.bid_px) + len(book.ask_px) == 1
    level = float(np.concatenate([book.bid_px, book.ask_px])[0])
    assert level == pytest.approx(4.2, abs=1e-3)
    sample = out[1]
    assert isinstance(sample, BarSample)
    assert (sample.o, sample.h, sample.l, sample.c) == (4.2, 4.3, 4.1, 4.2)


async def test_successive_bond_polls_at_different_prices_add_levels_to_the_book() -> None:
    clock = FakeClock(_utc(WED, 12))
    session = _quote_snap(captured_ns=clock.now_ns, last=4.2, high=4.3, low=4.1)
    polls = [
        _quote_snap(captured_ns=clock.now_ns, last=4.25),
        _quote_snap(captured_ns=clock.now_ns, last=4.30),
        _quote_snap(captured_ns=clock.now_ns, last=4.35),
    ]
    feed = _feed("bonds", "US10Y", clock, snapshots=Script(session, *polls, then=polls[-1]))
    out = await _take(feed.events(), cap=80)
    books = [e for e in out if isinstance(e, BookState)]
    counts = [len(b.bid_px) + len(b.ask_px) for b in books]
    assert counts[0] == 1
    assert counts == sorted(counts)
    # The session bar is the baseline: the first poll adds the time since it at 4.25, so every
    # polled price becomes a level beside the session's own.
    assert counts[-1] == 4
    final = np.sort(np.concatenate([books[-1].bid_px, books[-1].ask_px]))
    assert final == pytest.approx([4.2, 4.25, 4.30, 4.35], abs=1e-3)


async def test_a_future_without_chart_bars_prints_and_adds_its_volume_growth() -> None:
    clock = FakeClock(_utc(WED, 12))
    session = _quote_snap(
        captured_ns=clock.now_ns, last=5000.0, high=5010.0, low=4990.0, volume=1000.0
    )
    live1 = _quote_snap(captured_ns=clock.now_ns, last=5000.0, volume=1000.0)
    live2 = _quote_snap(captured_ns=clock.now_ns, last=5001.0, volume=1007.0)
    feed = _feed(
        "futures-cme_mini", "ES1!", clock, snapshots=Script(session, live1, live2, then=live2)
    )
    out = await _take(feed.events(), cap=40)
    trades = [e for e in out if isinstance(e, Trade)]
    assert trades[0].venue == "synthetic" and trades[0].size == 1.0
    assert (trades[1].price, trades[1].size, trades[1].venue) == (5001.0, 7.0, "tradingview")


def test_a_future_profile_grows_by_volume_growth_only_between_polls() -> None:
    feed = _feed("futures-cme_mini", "ES1!", FakeClock(_utc(WED, 12)))
    builder = feed._make_builder()
    now = _utc(WED, 12)
    feed._on_snapshot(builder, _quote_snap(captured_ns=now, last=5000.0, volume=1000.0), now)
    assert builder.total_volume() == 0.0
    feed._on_snapshot(
        builder, _quote_snap(captured_ns=now, last=5001.0, volume=1007.0), now + 10 * SEC
    )
    assert builder.total_volume() == 7.0
    feed._on_snapshot(
        builder, _quote_snap(captured_ns=now, last=5002.0, volume=1007.0), now + 20 * SEC
    )
    assert builder.total_volume() == 7.0


@pytest.mark.parametrize(("market", "symbol"), [("futures-cme_mini", "ES1!"), ("bonds", "US10Y")])
def test_with_chart_bars_a_poll_adds_nothing_to_the_profile(market: str, symbol: str) -> None:
    feed = _feed(market, symbol, FakeClock(_utc(WED, 12)))
    feed._chart_bars = True
    builder = feed._make_builder()
    builder.add_volume(5000.0, 10.0)
    before = builder.total_volume()
    now = _utc(WED, 12)
    feed._on_snapshot(builder, _quote_snap(captured_ns=now, last=5001.0, volume=1000.0), now)
    feed._on_snapshot(
        builder, _quote_snap(captured_ns=now, last=5002.0, volume=1500.0), now + 10 * SEC
    )
    assert builder.total_volume() == before


# --- 13. closing print -----------------------------------------------------------


def test_the_closing_print_is_the_last_minute_with_volume() -> None:
    bars = [
        _minute(_utc(WED, 14, 0), 100.0, 101.0, 99.0, 100.0, 30.0),
        _minute(_utc(WED, 14, 1), 100.0, 102.0, 99.0, 101.0, 50.0),
    ]
    trade = AssetMarketFeed._closing_print(bars)
    assert trade is not None
    assert (trade.price, trade.size, trade.venue, trade.ts_ns) == (
        101.0,
        50.0,
        "bar",
        _utc(WED, 14, 1),
    )


def test_the_closing_print_of_zero_volume_minutes_is_a_display_tick() -> None:
    bars = [
        _minute(_utc(WED, 14, 0), 100.0, 101.0, 99.0, 100.0, 0.0),
        _minute(_utc(WED, 14, 1), 100.0, 102.0, 99.0, 101.0, 0.0),
    ]
    trade = AssetMarketFeed._closing_print(bars)
    assert trade is not None
    assert (trade.price, trade.size, trade.venue, trade.ts_ns) == (
        101.0,
        1.0,
        "synthetic",
        _utc(WED, 14, 1),
    )


def test_the_closing_print_of_a_daily_bar_alone_is_none() -> None:
    daily = _daily(_utc(WED, 22), 100.0, 110.0, 90.0, 105.0, 5.0)
    assert AssetMarketFeed._closing_print([daily]) is None


# --- 14. closed path -------------------------------------------------------------


async def test_a_closed_saturday_draws_the_last_session_then_a_display_tick_and_a_break() -> None:
    bars = [_minute(_utc(FRI, 20, m), 1.10, 1.11, 1.09, 1.10, 0.0) for m in range(3)]
    feed = _feed("forex", "EURUSD", FakeClock(_utc(SAT, 12)), bars=bars)
    out = await _drain(feed.closed_history_events())
    assert [type(e) for e in out] == [BookState, BarSample] * 3 + [Trade, Marker]
    tick = out[-2]
    assert isinstance(tick, Trade) and tick.venue == "synthetic" and tick.size == 1.0
    closing = out[-1]
    assert isinstance(closing, Marker) and closing.kind == "session_break"
    assert feed.feed_state == "closed"
    assert feed.next_open_ts == _utc(SUN, 22)


# --- 15. backfill ----------------------------------------------------------------


class _Chart:
    """Stands in for the asset feed's chart: answers with the minute bars it was given."""

    def __init__(self, bars: list[MinuteBar] | None = None, *, error: Exception | None = None):
        self._bars = bars or []
        self._error = error
        self.asked: list[tuple[AssetKind, str]] = []

    async def minute_bars(self, kind: AssetKind, ticker: str) -> list[MinuteBar]:
        self.asked.append((kind, ticker))
        if self._error is not None:
            raise self._error
        return list(self._bars)


def _minute_bars(volume: float) -> list[MinuteBar]:
    return [
        MinuteBar(ts_ns=1_000, open=1.0, high=2.0, low=0.5, close=1.5, volume=volume),
        MinuteBar(ts_ns=2_000, open=1.5, high=2.5, low=1.0, close=2.0, volume=volume * 2),
        MinuteBar(ts_ns=3_000, open=2.0, high=3.0, low=1.5, close=2.5, volume=volume * 3),
    ]


async def test_a_forex_backfill_gives_each_candle_the_same_weight_on_the_live_scale(monkeypatch) -> None:
    chart = _Chart(_minute_bars(volume=10.0))
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: chart)
    candles = await asset_backfill_fn("forex", "EURUSD", max_cols=5, now_ns=_utc(WED, 12))
    # Time at price has no unit: every minute weighs the peak the live profile is drawn at
    # (equity_profile.PROFILE_PEAK_TARGET), whatever volume the chart put on the bar.
    assert [c.volume for c in candles] == [1000.0, 1000.0, 1000.0]
    assert chart.asked == [(AssetKind.FOREX, "FX_IDC:EURUSD")]


async def test_a_futures_backfill_keeps_the_bar_volume(monkeypatch) -> None:
    chart = _Chart(_minute_bars(volume=10.0))
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: chart)
    candles = await asset_backfill_fn("futures-cme_mini", "ES1!", max_cols=5, now_ns=_utc(WED, 12))
    assert [c.volume for c in candles] == [10.0, 20.0, 30.0]
    first = candles[0]
    assert (first.t0_ns, first.o, first.h, first.l, first.c) == (1_000, 1.0, 2.0, 0.5, 1.5)


async def test_a_backfill_keeps_the_newest_bars_up_to_max_cols(monkeypatch) -> None:
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Chart(_minute_bars(volume=10.0)))
    candles = await asset_backfill_fn("futures-cme_mini", "ES1!", max_cols=2, now_ns=_utc(WED, 12))
    assert [c.t0_ns for c in candles] == [2_000, 3_000]
    zero = await asset_backfill_fn("futures-cme_mini", "ES1!", max_cols=0, now_ns=_utc(WED, 12))
    assert zero == []


async def test_a_chart_that_raises_is_a_cold_start(monkeypatch) -> None:
    monkeypatch.setattr(
        asset_markets, "asset_feed", lambda: _Chart(error=RuntimeError("chart down"))
    )
    assert await asset_backfill_fn("forex", "EURUSD", max_cols=5, now_ns=_utc(WED, 12)) == []


async def test_a_backfill_records_the_newest_bar_so_a_later_feed_sees_a_closed_market(
    monkeypatch,
) -> None:
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Chart(_minute_bars(volume=10.0)))
    await asset_backfill_fn("forex", "EURUSD", max_cols=5, now_ns=_utc(WED, 3))
    later = _feed("forex", "EURUSD", FakeClock(3_000 + 3 * 3600 * SEC))
    assert later.is_closed_now() is True


async def test_a_backfill_of_a_non_asset_market_is_the_world_seam(monkeypatch) -> None:
    calls: list[tuple[str, str, int, int]] = []

    async def fake_world(market: str, symbol: str, *, max_cols: int, now_ns: int) -> list[object]:
        calls.append((market, symbol, max_cols, now_ns))
        return ["world-candle"]

    monkeypatch.setattr(asset_markets, "world_backfill_fn", fake_world)
    out = await asset_backfill_fn("world-xist", "THYAO", max_cols=5, now_ns=123)
    assert out == ["world-candle"]
    assert calls == [("world-xist", "THYAO", 5, 123)]


# --- 16. boards and listing order ------------------------------------------------


class _Board:
    """Stands in for the asset feed's board: returns the rows it was given."""

    def __init__(self, rows: list[AssetQuote]) -> None:
        self.rows = rows
        self.calls: list[tuple[AssetKind, str | None, int]] = []

    async def board(
        self, kind: AssetKind, venue: str | None = None, *, limit: int = 200
    ) -> list[AssetQuote]:
        self.calls.append((kind, venue, limit))
        return list(self.rows)


async def test_a_board_returns_each_ticker_once(monkeypatch) -> None:
    rows = [
        _row(AssetKind.FOREX, "FX_IDC", "EURUSD"),
        _row(AssetKind.FOREX, "FX_IDC", "AUDNZD"),
        _row(AssetKind.FOREX, "FX_IDC", "EURUSD"),
    ]
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Board(rows))
    out = await asset_board("forex")
    assert [r.ticker for r in out] == ["FX_IDC:EURUSD", "FX_IDC:AUDNZD"]


async def test_forex_rows_open_with_the_major_pairs_then_go_alphabetical(monkeypatch) -> None:
    rows = [
        _row(AssetKind.FOREX, "FX_IDC", s) for s in ["ZARJPY", "AUDNZD", "USDJPY", "EURNOK", "EURUSD"]
    ]
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Board(rows))
    out = await asset_board("forex")
    assert [r.symbol for r in out] == ["EURUSD", "USDJPY", "AUDNZD", "EURNOK", "ZARJPY"]


async def test_bond_rows_open_with_the_ten_year_benchmarks(monkeypatch) -> None:
    rows = [_row(AssetKind.BOND, "TVC", s) for s in ["US2Y", "US30Y", "US10Y", "DE10Y"]]
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Board(rows))
    out = await asset_board("bonds")
    assert [r.symbol for r in out] == ["DE10Y", "US10Y", "US2Y", "US30Y"]


async def test_index_rows_put_charted_first_and_the_crypto_market_cap_last(monkeypatch) -> None:
    rows = [
        _row(AssetKind.INDEX, "CRYPTOCAP", "TOTAL"),
        _row(AssetKind.INDEX, "TVC", "SOMETHING"),
        _row(AssetKind.INDEX, "SP", "SPX"),
    ]
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Board(rows))
    out = await asset_board("indices")
    assert [r.ticker for r in out] == ["SP:SPX", "TVC:SOMETHING", "CRYPTOCAP:TOTAL"]


async def test_futures_rows_keep_the_scanner_order(monkeypatch) -> None:
    rows = [_row(AssetKind.FUTURE, "EUREX", s) for s in ["FGBL1!", "FDAX1!", "FESX1!"]]
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Board(rows))
    out = await asset_board("futures-eurex")
    assert [r.symbol for r in out] == ["FGBL1!", "FDAX1!", "FESX1!"]


async def test_a_non_asset_market_gives_an_empty_board_without_asking_the_feed(monkeypatch) -> None:
    board = _Board([_row(AssetKind.FOREX, "FX_IDC", "EURUSD")])
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: board)
    assert await asset_board("world-xist") == []
    assert board.calls == []


def test_the_symbol_of_an_index_row_is_its_full_ticker() -> None:
    assert asset_symbol(_row(AssetKind.INDEX, "SP", "SPX")) == "SP:SPX"
    assert asset_symbol(_row(AssetKind.FOREX, "FX_IDC", "EURUSD")) == "EURUSD"


def test_listing_order_of_an_empty_list_is_empty() -> None:
    assert _listing_order(AssetKind.INDEX, []) == []


def test_a_reopened_stream_forgets_the_last_poll() -> None:
    # events() is re-callable. The poll state of the previous stream must not survive into the
    # next one, or its first poll would add the whole interval as one lump at one price.
    feed = AssetMarketFeed("FDAX1!", "futures-eurex", Config())
    feed._last_poll_ns = 123
    feed._last_profile_volume = 1_000.0
    feed._reset_tape_state()
    assert feed._last_poll_ns is None
    assert feed._last_profile_volume is None


async def test_minutes_that_first_arrive_on_a_refresh_stop_the_poll_driven_growth() -> None:
    # The warmup chart was empty, so the polls grow the profile. When a refresh then brings
    # minutes, the minutes take over: a poll must add nothing more, or each minute would be
    # counted once by its bar and once by the session-volume change.
    clock = FakeClock(_utc(WED, 12))
    answers: list[list[EqBar]] = [
        [],
        [_minute(_utc(WED, 12, 1), 5000.0, 5000.0, 5000.0, 5000.0, 50.0, symbol="ES1!")],
    ]

    async def bars_fn() -> list[EqBar]:
        return answers.pop(0) if len(answers) > 1 else answers[0]

    feed = AssetMarketFeed(
        "ES1!",
        "futures-cme_mini",
        Config(),
        now_ns_fn=clock,
        bars_fn=bars_fn,
        snapshot_fn=Script(),
        sleep_fn=clock.sleep,
    )
    await feed._fetch_bars()
    assert feed._chart_bars is False
    await feed._refresh_bars()
    assert feed._chart_bars is True
    builder = feed._make_builder()
    now = _utc(WED, 12, 2)
    feed._on_snapshot(builder, _quote_snap(captured_ns=now, last=5000.0, volume=1000.0), now)
    feed._on_snapshot(
        builder, _quote_snap(captured_ns=now, last=5001.0, volume=1050.0), now + 10 * SEC
    )
    assert builder.total_volume() == 0.0


async def test_the_session_bar_is_the_baseline_of_the_first_live_poll() -> None:
    # The session bar counted the session's volume up to its snapshot (1000). The first live
    # poll states 1040: the 40 traded since then belong in the profile, at the polled price.
    clock = FakeClock(_utc(WED, 12))
    session = _quote_snap(
        captured_ns=clock.now_ns, last=5000.0, high=5010.0, low=4990.0, volume=1000.0
    )
    feed = _feed("futures-eurex", "FDAX1!", clock, snapshots=Script(session))
    bar = await feed._session_bar()
    assert bar is not None and bar.volume == 1000.0
    builder = feed._make_builder()
    now = clock.now_ns + 10 * SEC
    feed._on_snapshot(builder, _quote_snap(captured_ns=now, last=5002.0, volume=1040.0), now)
    assert builder.total_volume() == 40.0


async def test_an_index_board_asks_for_the_cap_and_a_venue_board_for_its_measured_count(
    monkeypatch,
) -> None:
    asked: list[tuple[AssetKind, str | None, int]] = []

    class _Recorder:
        async def board(self, kind: AssetKind, venue: str | None = None, *, limit: int = 200):
            asked.append((kind, venue, limit))
            return []

    monkeypatch.setattr(asset_markets, "asset_feed", lambda: _Recorder())
    await asset_markets.asset_board("indices")
    await asset_markets.asset_board("futures-bist")
    # Indices are scanned across their whole market and filtered afterwards.
    assert asked[0] == (AssetKind.INDEX, None, asset_markets.ASSET_BOARD_LIMIT)
    # BIST lists 257 contracts in the measured venue table.
    assert asked[1] == (AssetKind.FUTURE, "BIST", 257)

