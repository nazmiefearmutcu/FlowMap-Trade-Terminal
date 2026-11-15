"""Option chain feed tests: hand-built scanner rows, injected seams, NO network.

The series listing, the chain read, the clocks and the wall clock are all injected, so pytest
never touches a scanner. The fake clock moves only when a test advances it, which makes the
cache lifetimes exact: a reading is served for ``CHAIN_TTL_S`` (chains) or ``SERIES_TTL_S``
(listings) and read again after that.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Callable, Sequence
from datetime import date

import msgspec
import pytest
from crocodile.core.schema.records import OptionsChain
from crocodile.equity.universal.live.assets import SOURCE, OptionSeries, parse_option_chain
from crocodile.equity.universal.live.chains import (
    BYBIT_SOURCE,
    CBOE_SOURCE,
    DERIBIT_SOURCE,
    PublishedChain,
    parse_bybit_chain,
    parse_cboe_chain,
    parse_deribit_chain,
)

from flowmap_server.feeds.option_chains import (
    BOARD_TTL_S,
    CBOE_BOARD_TTL_S,
    CHAIN_TTL_S,
    SERIES_TTL_S,
    US_OPTION_VENUES,
    OptionChains,
    crypto_base,
    option_sources,
    option_underlyings,
)

NOV_13 = date(2026, 11, 13)
NOV_20 = date(2026, 11, 20)
DEC_18 = date(2026, 12, 18)
DEC_01 = date(2026, 12, 1)


# --- seams ----------------------------------------------------------------------


class _Clock:
    """A monotonic clock that moves only when a test advances it."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _Scanner:
    """Stands in for the option scanner: answers what it was given and counts every request."""

    def __init__(
        self,
        series: Sequence[OptionSeries] = (),
        chain: Sequence[OptionsChain] = (),
    ) -> None:
        self.series_value = list(series)
        self.chain_value = list(chain)
        self.series_error: Exception | None = None
        self.chain_error: Exception | None = None
        self.gate: asyncio.Event | None = None
        self.series_calls: list[tuple[str, ...]] = []
        self.chain_calls: list[tuple[str, date, str]] = []

    async def series_fn(self, underlyings: Sequence[str]) -> list[OptionSeries]:
        self.series_calls.append(tuple(underlyings))
        if self.series_error is not None:
            raise self.series_error
        return list(self.series_value)

    async def chain_fn(self, underlying: str, expiry: date, root: str) -> list[OptionsChain]:
        self.chain_calls.append((underlying, expiry, root))
        if self.gate is not None:
            await self.gate.wait()
        if self.chain_error is not None:
            raise self.chain_error
        return list(self.chain_value)


async def _no_publisher(publisher: str, underlying: str) -> PublishedChain:
    """A publisher that lists nothing for the instrument, so the scanner is asked: these
    tests are about the scanner path. The publishers have their own tests."""
    return PublishedChain(
        source=publisher,
        underlying=underlying,
        captured_ns=0,
        stamped_ns=None,
        underlying_price=None,
        premium_unit=None,
        delay_s=None,
        contracts=(),
    )


def _chains(scanner: _Scanner, clock: _Clock, wall: list[int]) -> OptionChains:
    """An option cache over the fakes. ``wall`` is a one-slot box holding the wall-clock ms."""
    return OptionChains(
        series_fn=scanner.series_fn,
        chain_fn=scanner.chain_fn,
        board_fn=_no_publisher,
        now_fn=clock,
        wall_ms_fn=lambda: wall[0],
    )


async def _until(predicate: Callable[[], bool]) -> None:
    """Let spawned tasks run until ``predicate`` holds; fail rather than hang."""
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("the condition never held")


# --- records --------------------------------------------------------------------


def _series(root: str, day: date, contracts: int, underlying: str = "SP:SPX") -> OptionSeries:
    return OptionSeries(underlying=underlying, root=root, expiry=day, contracts=contracts)


def _listing() -> list[OptionSeries]:
    """Four series of SP:SPX, deliberately out of order."""
    return [
        _series("SPX", DEC_18, 300),
        _series("SPXW", NOV_20, 900),
        _series("SPX", NOV_13, 500),
        _series("SPXW", NOV_13, 800),
    ]


def _row(
    name: str,
    strike: float,
    right: str,
    *,
    bid: float | None = None,
    ask: float | None = None,
    theo: float | None = None,
    iv: float | None = None,
    delta: float | None = None,
    gamma: float | None = None,
    theta: float | None = None,
    vega: float | None = None,
    rho: float | None = None,
    expiry: int = 20261113,
    root: str = "SPXW",
) -> dict[str, object]:
    """One scanner row, cells in the order of the scanner's option columns."""
    cells = [name, bid, ask, strike, expiry, right, theo, iv, delta, gamma, theta, vega, rho]
    return {"s": f"OPRA:{name}", "d": [*cells, "USD", root]}


def _records(rows: Sequence[dict[str, object]], underlying: str = "SP:SPX") -> list[OptionsChain]:
    """The scanner's answer for ``rows``, parsed by the real parser."""
    body = json.dumps({"totalCount": len(rows), "data": list(rows)}).encode()
    return parse_option_chain(body, underlying, captured_ns=1)


def _one_call() -> list[OptionsChain]:
    return _records(
        [
            _row(
                "SPXW261113C300",
                300.0,
                "call",
                bid=1.0,
                ask=1.2,
                theo=1.1,
                iv=0.25,
                delta=0.5,
                gamma=0.01,
                theta=-0.02,
                vega=0.3,
                rho=0.1,
            )
        ]
    )


# --- 1. option underlyings --------------------------------------------------------


def test_an_equity_is_looked_for_on_the_three_us_venues_in_order_upper_cased() -> None:
    assert option_underlyings("equity", "ibm") == ("NASDAQ:IBM", "NYSE:IBM", "AMEX:IBM")
    assert US_OPTION_VENUES == ("NASDAQ", "NYSE", "AMEX")


def test_a_world_listing_takes_the_scanners_spelling_of_its_ticker() -> None:
    assert option_underlyings("world-xist", "THYAO") == ("BIST:THYAO",)


@pytest.mark.parametrize(
    ("market", "symbol", "expected"),
    [
        ("indices", "SP:SPX", ("SP:SPX",)),
        ("forex", "EURUSD", ("FX_IDC:EURUSD",)),
        ("futures-cme_mini", "ES1!", ("CME_MINI:ES1!",)),
        ("bonds", "US10Y", ("TVC:US10Y",)),
    ],
)
def test_an_asset_market_is_its_scanner_ticker(market: str, symbol: str, expected: tuple) -> None:
    assert option_underlyings(market, symbol) == expected


@pytest.mark.parametrize(("market", "symbol"), [("binance", "BTCUSDT"), ("sim", "SIM-DEMO")])
def test_a_crypto_venue_and_the_sim_feed_have_no_ticker_the_source_spells(
    market: str, symbol: str
) -> None:
    assert option_underlyings(market, symbol) == ()


@pytest.mark.parametrize(
    ("market", "symbol"),
    [("equity", ""), ("equity", "   "), ("forex", " "), ("world-xist", "")],
)
def test_an_empty_or_blank_symbol_has_no_underlying(market: str, symbol: str) -> None:
    assert option_underlyings(market, symbol) == ()


def test_an_index_named_without_its_venue_has_no_underlying() -> None:
    # An index is named by its full ticker (SP:SPX); a bare SPX cannot be placed on a venue.
    assert option_underlyings("indices", "SPX") == ()


# --- 2. unsupported markets --------------------------------------------------------


@pytest.mark.parametrize(("market", "symbol"), [("sim", "SIM-DEMO"), ("binance", "///")])
async def test_an_unsupported_market_answers_without_asking_the_scanner(
    market: str, symbol: str
) -> None:
    # Only the sim feed and a symbol with no coin in it are unsupported. A crypto venue has its
    # own publishers now, and the scanner is never asked for a crypto symbol.
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view(market, symbol)
    assert answer["status"] == "unsupported"
    assert answer["underlying"] is None
    assert answer["series"] == []
    assert answer["selected"] is None
    assert answer["strikes"] == []
    assert answer["capturedMs"] is None
    assert scanner.series_calls == []
    assert scanner.chain_calls == []


async def test_the_answer_echoes_the_market_and_symbol_it_was_asked_for() -> None:
    chains = _chains(_Scanner(), _Clock(), [1])
    answer = await chains.view("sim", "SIM-DEMO")
    assert answer["market"] == "sim"
    assert answer["symbol"] == "SIM-DEMO"


# --- 3. faults are statuses, never exceptions --------------------------------------


async def test_a_failing_series_listing_is_unreachable_and_raises_nothing() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    scanner.series_error = RuntimeError("scanner down")
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    assert answer["status"] == "unreachable"
    assert answer["strikes"] == []
    assert scanner.chain_calls == []


async def test_a_failing_chain_with_no_earlier_reading_is_unreachable_but_keeps_the_series() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    scanner.chain_error = RuntimeError("contracts unavailable")
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    assert answer["status"] == "unreachable"
    assert answer["strikes"] == []
    # The series were read fine, so the screen can still show which expiries exist.
    assert len(answer["series"]) == 4
    assert answer["selected"] == {"root": "SPXW", "expiry": "2026-11-13"}


async def test_no_series_for_any_candidate_is_none() -> None:
    chains = _chains(_Scanner(series=[]), _Clock(), [1])
    answer = await chains.view("equity", "IBM")
    assert answer["status"] == "none"
    assert answer["underlying"] is None
    assert answer["series"] == []
    assert answer["strikes"] == []


async def test_series_of_another_underlying_are_none_for_this_one() -> None:
    other = [_series("IBM", NOV_13, 50, underlying="NASDAQ:AAPL")]
    chains = _chains(_Scanner(series=other), _Clock(), [1])
    answer = await chains.view("equity", "IBM")
    assert answer["status"] == "none"
    assert answer["underlying"] is None


# --- 4. US resolution ------------------------------------------------------------------


async def test_a_share_is_looked_for_on_all_three_venues_in_one_series_request() -> None:
    scanner = _Scanner(series=[_series("IBM", NOV_13, 40, underlying="NYSE:IBM")])
    chains = _chains(scanner, _Clock(), [1])
    await chains.view("equity", "ibm")
    assert scanner.series_calls == [("NASDAQ:IBM", "NYSE:IBM", "AMEX:IBM")]


async def test_a_share_listed_on_nyse_answers_under_nyse_and_reads_that_chain() -> None:
    scanner = _Scanner(
        series=[_series("IBM", NOV_13, 40, underlying="NYSE:IBM")], chain=_one_call()
    )
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("equity", "ibm")
    assert answer["status"] == "ok"
    assert answer["underlying"] == "NYSE:IBM"
    assert scanner.chain_calls == [("NYSE:IBM", NOV_13, "IBM")]


# --- 5. selection ----------------------------------------------------------------------


async def test_the_nearest_expiry_is_served_by_default() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    assert answer["selected"] == {"root": "SPXW", "expiry": "2026-11-13"}
    assert scanner.chain_calls == [("SP:SPX", NOV_13, "SPXW")]


async def test_on_the_nearest_day_the_family_with_more_contracts_is_chosen() -> None:
    # SPX lists 500 contracts on 13 November and SPXW 800: SPXW is the chain a screen shows.
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    assert answer["selected"]["root"] == "SPXW"


@pytest.mark.parametrize(
    ("expiry", "root", "selected_root", "selected_expiry"),
    [
        # Both named: that series, when the listing has it.
        (NOV_13, "SPX", "SPX", "2026-11-13"),
        # Expiry named but not that family on that day: the day's other family.
        (NOV_20, "SPX", "SPXW", "2026-11-20"),
        # Expiry not listed: the named family's expiry closest to that day (Dec 18 is 17 days
        # from Dec 1, Nov 13 is 18).
        (DEC_01, "SPX", "SPX", "2026-12-18"),
        # Expiry not listed and no family named: the listed expiry closest to that day.
        (DEC_01, None, "SPXW", "2026-11-20"),
        # Only a family named: its nearest expiry.
        (None, "SPX", "SPX", "2026-11-13"),
        (None, "SPXW", "SPXW", "2026-11-13"),
        # A family the listing does not have: the nearest default.
        (None, "NOPE", "SPXW", "2026-11-13"),
    ],
)
async def test_the_requested_series_is_served_or_the_fallback_says_what_it_served(
    expiry: date | None, root: str | None, selected_root: str, selected_expiry: str
) -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX", expiry=expiry, root=root)
    assert answer["selected"] == {"root": selected_root, "expiry": selected_expiry}
    assert scanner.chain_calls == [
        ("SP:SPX", date.fromisoformat(selected_expiry), selected_root)
    ]


# --- 6. series listing -----------------------------------------------------------------


async def test_the_series_are_ordered_by_expiry_then_root_with_iso_dates_and_counts() -> None:
    chains = _chains(_Scanner(series=_listing(), chain=_one_call()), _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    assert answer["series"] == [
        {"root": "SPX", "expiry": "2026-11-13", "contracts": 500},
        {"root": "SPXW", "expiry": "2026-11-13", "contracts": 800},
        {"root": "SPXW", "expiry": "2026-11-20", "contracts": 900},
        {"root": "SPX", "expiry": "2026-12-18", "contracts": 300},
    ]


# --- 7. strike rows --------------------------------------------------------------------


async def test_strikes_ascend_and_a_side_the_strike_does_not_list_is_none() -> None:
    rows = [
        _row("SPXW261113C310", 310.0, "call", bid=0.5, ask=0.6),
        _row("SPXW261113P300", 300.0, "put", bid=2.0, ask=2.2),
        _row("SPXW261113C300", 300.0, "call", bid=1.0, ask=1.2),
        _row("SPXW261113P290", 290.0, "put", bid=0.1, ask=0.2),
    ]
    scanner = _Scanner(series=_listing(), chain=_records(rows))
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    strikes = answer["strikes"]
    assert [row["strike"] for row in strikes] == [290.0, 300.0, 310.0]
    # 290 is listed as a put only, 310 as a call only: the other side is None, not missing.
    assert strikes[0]["call"] is None and strikes[0]["put"] is not None
    assert strikes[2]["put"] is None and strikes[2]["call"] is not None
    assert strikes[1]["call"] is not None and strikes[1]["put"] is not None


async def test_each_side_carries_its_quote_greeks_and_symbol() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    call = answer["strikes"][0]["call"]
    # The scanner states no size, last trade, volume or open interest: those keys are present
    # with a None value, so every side has the same shape.
    assert call == {
        "symbol": "OPRA:SPXW261113C300",
        "bid": 1.0,
        "bidSize": None,
        "ask": 1.2,
        "askSize": None,
        "last": None,
        "theo": 1.1,
        "iv": 0.25,
        "volume": None,
        "openInterest": None,
        "delta": 0.5,
        "gamma": 0.01,
        "theta": -0.02,
        "vega": 0.3,
        "rho": 0.1,
    }


async def test_a_non_finite_figure_is_none_and_the_whole_answer_is_strict_json() -> None:
    record = _one_call()[0]
    poisoned = msgspec.structs.replace(
        record, mark_price=math.nan, mark_iv=math.inf, delta=-math.inf
    )
    scanner = _Scanner(series=_listing(), chain=[poisoned])
    chains = _chains(scanner, _Clock(), [1])
    answer = await chains.view("indices", "SP:SPX")
    call = answer["strikes"][0]["call"]
    assert call["theo"] is None
    assert call["iv"] is None
    assert call["delta"] is None
    assert call["gamma"] == 0.01
    # allow_nan=False: a NaN or Infinity anywhere would make the body invalid JSON.
    json.dumps(answer, allow_nan=False)


# --- 8. caching ------------------------------------------------------------------------


async def test_within_the_ttl_a_second_view_reads_nothing_from_the_scanner() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    chains = _chains(scanner, _Clock(), [1])
    await chains.view("indices", "SP:SPX")
    await chains.view("indices", "SP:SPX")
    assert len(scanner.series_calls) == 1
    assert len(scanner.chain_calls) == 1


async def test_after_the_chain_ttl_only_the_chain_is_read_again() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    clock = _Clock()
    chains = _chains(scanner, clock, [1])
    await chains.view("indices", "SP:SPX")
    clock.advance(CHAIN_TTL_S + 1)
    await chains.view("indices", "SP:SPX")
    assert len(scanner.series_calls) == 1
    assert len(scanner.chain_calls) == 2


async def test_the_listing_is_read_again_only_after_its_own_longer_ttl() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    clock = _Clock()
    chains = _chains(scanner, clock, [1])
    await chains.view("indices", "SP:SPX")
    clock.advance(CHAIN_TTL_S + 1)
    await chains.view("indices", "SP:SPX")
    assert len(scanner.series_calls) == 1
    # The listing was read at t=0 and is now 321 s old: past its 300 s TTL.
    clock.advance(SERIES_TTL_S)
    await chains.view("indices", "SP:SPX")
    assert len(scanner.series_calls) == 2
    assert len(scanner.chain_calls) == 3


async def test_captured_ms_is_the_wall_clock_at_the_load_not_at_the_answer() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    clock = _Clock()
    wall = [111]
    chains = _chains(scanner, clock, wall)
    first = await chains.view("indices", "SP:SPX")
    assert first["capturedMs"] == 111
    # Still cached: the reading keeps the time it was taken, whatever the wall clock says now.
    wall[0] = 222
    cached = await chains.view("indices", "SP:SPX")
    assert cached["capturedMs"] == 111
    clock.advance(CHAIN_TTL_S + 1)
    reloaded = await chains.view("indices", "SP:SPX")
    assert reloaded["capturedMs"] == 222


# --- 9. stale serving ------------------------------------------------------------------


async def test_a_failing_chain_refresh_serves_the_last_good_reading_as_stale() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    clock = _Clock()
    wall = [111]
    chains = _chains(scanner, clock, wall)
    good = await chains.view("indices", "SP:SPX")
    scanner.chain_error = RuntimeError("contracts unavailable")
    clock.advance(CHAIN_TTL_S + 1)
    wall[0] = 999
    stale = await chains.view("indices", "SP:SPX")
    assert stale["status"] == "ok"
    assert stale["stale"] is True
    assert stale["strikes"] == good["strikes"]
    assert stale["capturedMs"] == 111


async def test_a_failing_listing_refresh_serves_the_chain_it_still_holds_as_stale() -> None:
    scanner = _Scanner(series=_listing(), chain=_records([_row("SPXW261113C300", 300.0, "call", bid=1.0)]))
    clock = _Clock()
    wall = [111]
    chains = _chains(scanner, clock, wall)
    await chains.view("indices", "SP:SPX")
    # Reload the chain at t=290 with new strikes; the listing is still fresh.
    clock.advance(SERIES_TTL_S - 10)
    scanner.chain_value = _records([_row("SPXW261113C320", 320.0, "call", bid=3.0)])
    wall[0] = 222
    await chains.view("indices", "SP:SPX")
    assert len(scanner.chain_calls) == 2
    # At t=301 the listing has expired and its refresh fails; the chain (loaded at 290) is fresh.
    clock.advance(11)
    scanner.series_error = RuntimeError("listing unavailable")
    answer = await chains.view("indices", "SP:SPX")
    assert len(scanner.series_calls) == 2
    assert len(scanner.chain_calls) == 2
    assert answer["status"] == "ok"
    assert answer["stale"] is True
    assert [row["strike"] for row in answer["strikes"]] == [320.0]
    assert answer["capturedMs"] == 222


# --- 10. concurrency -------------------------------------------------------------------


async def test_concurrent_misses_share_one_listing_read_and_one_chain_read() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    scanner.gate = asyncio.Event()
    chains = _chains(scanner, _Clock(), [1])
    pending = asyncio.gather(
        chains.view("indices", "SP:SPX"), chains.view("indices", "SP:SPX")
    )
    # The chain read is blocked until the test opens the gate, so both callers are waiting on it.
    await _until(lambda: len(scanner.chain_calls) == 1)
    scanner.gate.set()
    first, second = await pending
    assert len(scanner.series_calls) == 1
    assert len(scanner.chain_calls) == 1
    assert first == second
    assert first["status"] == "ok"


async def test_a_cancelled_caller_does_not_cancel_the_load_the_next_caller_waits_for() -> None:
    scanner = _Scanner(series=_listing(), chain=_one_call())
    scanner.gate = asyncio.Event()
    chains = _chains(scanner, _Clock(), [1])
    waiter = asyncio.create_task(chains.view("indices", "SP:SPX"))
    await _until(lambda: len(scanner.chain_calls) == 1)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    scanner.gate.set()
    answer = await chains.view("indices", "SP:SPX")
    assert answer["status"] == "ok"
    assert answer["strikes"][0]["strike"] == 300.0
    # The reading the cancelled caller started is the one served: no second read was made.
    assert len(scanner.chain_calls) == 1


async def test_an_unlisted_expiry_between_two_listed_ones_takes_the_earlier_on_a_tie() -> None:
    listing = [_series("SPXW", date(2026, 11, 10), 10), _series("SPXW", date(2026, 11, 20), 10)]
    scanner = _Scanner(series=listing, chain=_one_call())
    answer = await _chains(scanner, _Clock(), [1]).view(
        "indices", "SP:SPX", expiry=date(2026, 11, 15), root="SPXW"
    )
    assert answer["selected"] == {"root": "SPXW", "expiry": "2026-11-10"}


def test_a_us_share_symbol_that_is_a_full_ticker_names_no_underlying() -> None:
    # "NYSE:IBM" typed as an equity symbol must not become the ticker "NASDAQ:NYSE:IBM".
    assert option_underlyings("equity", "NYSE:IBM") == ()


async def test_a_request_waits_only_so_long_and_the_load_still_lands_for_the_next_one() -> None:
    release = asyncio.Event()
    calls = 0

    async def slow_chain(underlying: str, expiry: date, root: str) -> list[OptionsChain]:
        nonlocal calls
        calls += 1
        await release.wait()
        return _one_call()

    async def series_fn(underlyings: object) -> list[OptionSeries]:
        return [_series("SPXW", NOV_13, 2)]

    chains = OptionChains(
        series_fn=series_fn, chain_fn=slow_chain, board_fn=_no_publisher, load_wait_s=0.05
    )
    first = await chains.view("indices", "SP:SPX")
    # No reading yet and the load is not back in time: unreachable, not a hung request.
    assert first["status"] == "unreachable"
    assert first["selected"] == {"root": "SPXW", "expiry": "2026-11-13"}
    release.set()
    await asyncio.sleep(0.05)
    second = await chains.view("indices", "SP:SPX")
    assert second["status"] == "ok" and second["stale"] is False
    # The slow load was not started again: it finished and its reading is what was served.
    assert calls == 1


async def test_a_listed_series_without_contracts_makes_the_next_request_read_the_listing_anew() -> None:
    listings = [[_series("SPXW", NOV_13, 2)], [_series("SPXW", NOV_20, 4)]]
    series_calls = 0

    async def series_fn(underlyings: object) -> list[OptionSeries]:
        nonlocal series_calls
        series_calls += 1
        return listings[min(series_calls, len(listings)) - 1]

    async def chain_fn(underlying: str, expiry: date, root: str) -> list[OptionsChain]:
        return [] if expiry == NOV_13 else _one_call()

    chains = OptionChains(series_fn=series_fn, chain_fn=chain_fn, board_fn=_no_publisher)
    first = await chains.view("indices", "SP:SPX")
    # The cached listing named an expiry that has no contracts any more.
    assert first["status"] == "ok" and first["strikes"] == []
    second = await chains.view("indices", "SP:SPX")
    assert series_calls == 2
    assert second["selected"] == {"root": "SPXW", "expiry": "2026-11-20"}
    assert len(second["strikes"]) == 1


async def test_a_contract_listed_twice_at_a_strike_is_named_in_the_log_not_dropped_silently(
    caplog: pytest.LogCaptureFixture,
) -> None:
    twice = _one_call() + _one_call()
    scanner = _Scanner(series=[_series("SPXW", NOV_13, 2)], chain=twice)
    with caplog.at_level("WARNING", logger="flowmap_server.feeds.option_chains"):
        answer = await _chains(scanner, _Clock(), [1]).view("indices", "SP:SPX")
    assert len(answer["strikes"]) == 1
    assert "twice at a strike" in caplog.text
    assert twice[0].symbol in caplog.text


# --- seams and records for the whole-chain publishers ----------------------------------


class _Publishers:
    """Stands in for the whole-chain publishers: answers each with what it was given, or raises
    it, and counts every request. A publisher not given lists nothing, as ``_no_publisher``."""

    def __init__(self, answers: dict[str, PublishedChain | Exception] | None = None) -> None:
        self.answers: dict[str, PublishedChain | Exception] = dict(answers or {})
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, publisher: str, underlying: str) -> PublishedChain:
        self.calls.append((publisher, underlying))
        answer = self.answers.get(publisher)
        if answer is None:
            return await _no_publisher(publisher, underlying)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _boarded(
    publishers: _Publishers,
    *,
    scanner: _Scanner | None = None,
    clock: _Clock | None = None,
    wall: list[int] | None = None,
) -> OptionChains:
    """An option cache over the publisher fake and the scanner fake."""
    fake_scanner = scanner if scanner is not None else _Scanner()
    fake_clock = clock if clock is not None else _Clock()
    box = wall if wall is not None else [1]
    return OptionChains(
        series_fn=fake_scanner.series_fn,
        chain_fn=fake_scanner.chain_fn,
        board_fn=publishers,
        now_fn=fake_clock,
        wall_ms_fn=lambda: box[0],
    )


def _occ(
    symbol: str,
    *,
    bid: float | None = None,
    bid_size: float | None = None,
    ask: float | None = None,
    ask_size: float | None = None,
    last: float | None = None,
    volume: float | None = None,
    open_interest: float | None = None,
    iv: float | None = None,
) -> dict[str, object]:
    """One Cboe delayed-quote row: an OCC symbol and the figures Cboe states for it."""
    row: dict[str, object] = {
        "option": symbol,
        "bid": bid,
        "bid_size": bid_size,
        "ask": ask,
        "ask_size": ask_size,
        "volume": volume,
        "open_interest": open_interest,
        "iv": iv,
        "theo": None,
        "delta": 0.5,
        "gamma": 0.01,
        "theta": -0.02,
        "vega": 0.3,
        "rho": 0.1,
    }
    if last is not None:
        # A last trade counts only with the time it traded.
        row["last_trade_price"] = last
        row["last_trade_time"] = "2026-11-12 19:00:00"
    return row


def _cboe_chain(
    symbol: str, rows: Sequence[dict[str, object]], spot: float = 201.5
) -> PublishedChain:
    """Cboe's answer for one underlying, parsed by the real parser."""
    body = {"timestamp": "2026-11-12 20:33:17", "data": {"current_price": spot, "options": list(rows)}}
    return parse_cboe_chain(json.dumps(body).encode(), symbol, captured_ns=1)


def _bybit_row(symbol: str) -> dict[str, object]:
    """One Bybit option ticker, with the sizes, greeks and volume Bybit states."""
    return {
        "symbol": symbol,
        "bid1Price": "1000",
        "bid1Size": "0.5",
        "ask1Price": "1100",
        "ask1Size": "0.4",
        "markPrice": "1050",
        "markIv": "0.6",
        "bid1Iv": "0.55",
        "ask1Iv": "0.65",
        "lastPrice": "1040",
        "volume24h": "12",
        "openInterest": "30",
        "underlyingPrice": "98000",
        "indexPrice": "97500",
        "delta": "0.5",
        "gamma": "0.0001",
        "vega": "10",
        "theta": "-5",
    }


def _bybit_chain(rows: Sequence[dict[str, object]]) -> PublishedChain:
    body = {"retCode": 0, "retMsg": "OK", "result": {"list": list(rows)}, "time": 1700000000000}
    return parse_bybit_chain(json.dumps(body).encode(), "BTC", captured_ns=1)


def _bybit_empty() -> PublishedChain:
    """Bybit's answer for a base coin it lists no options for."""
    body = {"retCode": 10001, "retMsg": "base coin not found", "result": {}, "time": 1700000000000}
    return parse_bybit_chain(json.dumps(body).encode(), "BTC", captured_ns=1)


def _deribit_row(name: str) -> dict[str, object]:
    return {
        "instrument_name": name,
        "mark_iv": 60.0,
        "mark_price": 0.05,
        "bid_price": 0.04,
        "ask_price": 0.06,
        "last": 0.05,
        "volume": 3.0,
        "open_interest": 10.0,
        "underlying_price": 98000.0,
        "estimated_delivery_price": 97600.0,
        "creation_timestamp": 1700000000000,
    }


def _deribit_chain(rows: Sequence[dict[str, object]]) -> PublishedChain:
    body = {"jsonrpc": "2.0", "result": list(rows)}
    return parse_deribit_chain(json.dumps(body).encode(), "BTC", captured_ns=1)


def _aapl_listing() -> list[OptionSeries]:
    """The scanner lists AAPL on NASDAQ only."""
    return [_series("AAPL", NOV_13, 5, underlying="NASDAQ:AAPL")]


def _spx_cboe_chain() -> PublishedChain:
    """Cboe's SPX chain: two families expire on 13 November, with one contract each."""
    rows = [
        _occ("SPX261113C05000000", bid=1.0, ask=1.2),
        _occ("SPXW261113C05010000", bid=2.0, ask=2.2),
        _occ("SPXW261120C05020000", bid=3.0, ask=3.2),
        _occ("SPX261218P04900000", bid=4.0, ask=4.2),
    ]
    return _cboe_chain("_SPX", rows, spot=5005.0)


# --- 11. the base coin of a crypto symbol ---------------------------------------------


@pytest.mark.parametrize(
    ("symbol", "base"),
    [
        ("BTCUSDT", "BTC"),
        ("BTC/USDT", "BTC"),
        ("BTC-PERPETUAL", "BTC"),
        ("BTC-USDT-SWAP", "BTC"),
        ("btc_usdt", "BTC"),
        ("ETHUSD", "ETH"),
        # A price multiplier is part of the coin's name, not a prefix to strip.
        ("1000PEPEUSDT", "1000PEPE"),
        # Stripping the quote would leave nothing, so the symbol stands as the coin it names.
        ("USDT", "USDT"),
        ("", None),
        ("///", None),
    ],
)
def test_the_base_coin_is_read_off_a_crypto_symbol(symbol: str, base: str | None) -> None:
    assert crypto_base(symbol) == base


# --- 12. which publishers are asked, in order --------------------------------------------


def test_a_us_share_is_asked_of_cboe_by_its_symbol_then_of_the_scanner_on_three_venues() -> None:
    assert option_sources("equity", "AAPL") == (
        (CBOE_SOURCE, ("AAPL",)),
        (SOURCE, ("NASDAQ:AAPL", "NYSE:AAPL", "AMEX:AAPL")),
    )


def test_a_share_class_keeps_its_dot_when_cboe_is_asked() -> None:
    # Cboe names a class share with its dot (BRK.B); the scanner is asked too, after Cboe.
    assert option_sources("equity", "brk.b")[0] == (CBOE_SOURCE, ("BRK.B",))


def test_an_index_with_a_cboe_spelling_is_asked_of_cboe_then_of_the_scanner() -> None:
    assert option_sources("indices", "SP:SPX") == (
        (CBOE_SOURCE, ("_SPX",)),
        (SOURCE, ("SP:SPX",)),
    )


def test_an_index_without_a_cboe_file_is_asked_of_the_scanner_only() -> None:
    # Cboe's Dow options are written on a hundredth of the index, so Cboe is not asked for it.
    assert option_sources("indices", "DJ:DJI") == ((SOURCE, ("DJ:DJI",)),)


def test_a_world_listing_is_asked_of_the_scanner_only() -> None:
    assert option_sources("world-xist", "THYAO") == ((SOURCE, ("BIST:THYAO",)),)


def test_a_binance_spot_symbol_is_asked_of_bybit_then_deribit_for_its_base_coin() -> None:
    assert option_sources("binance-spot", "BTCUSDT") == (
        (BYBIT_SOURCE, ("BTC",)),
        (DERIBIT_SOURCE, ("BTC",)),
    )


def test_a_deribit_symbol_is_asked_of_deribit_then_bybit() -> None:
    assert option_sources("deribit", "BTC-PERPETUAL") == (
        (DERIBIT_SOURCE, ("BTC",)),
        (BYBIT_SOURCE, ("BTC",)),
    )


@pytest.mark.parametrize(
    ("market", "symbol"),
    [("sim", "SIM-DEMO"), ("equity", "   "), ("binance-spot", ""), ("binance-spot", "///")],
)
def test_the_sim_feed_and_a_blank_symbol_are_asked_of_no_publisher(
    market: str, symbol: str
) -> None:
    assert option_sources(market, symbol) == ()


# --- 13. US shares answered by Cboe --------------------------------------------------------


async def test_a_share_listed_by_cboe_is_answered_by_cboe_and_the_scanner_is_not_asked() -> None:
    call = _occ("AAPL261113C00200000", bid=1.0, bid_size=10, ask=1.2, ask_size=12, last=1.1,
                volume=50, open_interest=300, iv=0.3)
    put = _occ("AAPL261113P00200000", bid=0.8, bid_size=5, ask=1.0, ask_size=6)
    publishers = _Publishers({CBOE_SOURCE: _cboe_chain("AAPL", [call, put])})
    scanner = _Scanner(series=_aapl_listing(), chain=_one_call())
    answer = await _boarded(publishers, scanner=scanner).view("equity", "AAPL")
    assert answer["status"] == "ok"
    assert answer["source"] == "cboe"
    assert answer["underlying"] == "AAPL"
    assert answer["underlyingPrice"] == 201.5
    assert answer["premiumUnit"] == "USD"
    # Cboe's file is fifteen minutes behind the market.
    assert answer["delayS"] == 900
    side = answer["strikes"][0]["call"]
    assert side["bidSize"] == 10.0
    assert side["askSize"] == 12.0
    assert side["last"] == 1.1
    assert side["volume"] == 50.0
    assert side["openInterest"] == 300.0
    assert publishers.calls == [(CBOE_SOURCE, "AAPL")]
    assert scanner.series_calls == []
    assert scanner.chain_calls == []


async def test_an_empty_cboe_chain_falls_to_the_scanner_which_answers() -> None:
    publishers = _Publishers({CBOE_SOURCE: _cboe_chain("AAPL", [])})
    scanner = _Scanner(series=_aapl_listing(), chain=_one_call())
    answer = await _boarded(publishers, scanner=scanner).view("equity", "AAPL")
    assert answer["status"] == "ok"
    assert answer["source"] == "tradingview"
    assert answer["underlying"] == "NASDAQ:AAPL"
    assert publishers.calls == [(CBOE_SOURCE, "AAPL")]


async def test_a_cboe_fault_falls_to_the_scanner_which_still_answers() -> None:
    publishers = _Publishers({CBOE_SOURCE: RuntimeError("cboe down")})
    scanner = _Scanner(series=_aapl_listing(), chain=_one_call())
    answer = await _boarded(publishers, scanner=scanner).view("equity", "AAPL")
    assert answer["status"] == "ok"
    assert answer["source"] == "tradingview"


async def test_a_publisher_fault_with_no_scanner_listing_is_unreachable() -> None:
    publishers = _Publishers({CBOE_SOURCE: RuntimeError("cboe down")})
    answer = await _boarded(publishers).view("equity", "AAPL")
    assert answer["status"] == "unreachable"
    assert answer["strikes"] == []


async def test_neither_cboe_nor_the_scanner_listing_anything_is_none() -> None:
    publishers = _Publishers({CBOE_SOURCE: _cboe_chain("AAPL", [])})
    answer = await _boarded(publishers).view("equity", "AAPL")
    assert answer["status"] == "none"
    assert answer["source"] == "tradingview"


# --- 14. crypto venues and the two-publisher rule ----------------------------------------


async def test_binance_spot_asks_bybit_first_and_deribit_when_bybit_lists_no_contract() -> None:
    publishers = _Publishers(
        {BYBIT_SOURCE: _bybit_empty(), DERIBIT_SOURCE: _deribit_chain([_deribit_row("BTC-13NOV26-98000-C")])}
    )
    answer = await _boarded(publishers).view("binance-spot", "BTCUSDT")
    assert publishers.calls == [(BYBIT_SOURCE, "BTC"), (DERIBIT_SOURCE, "BTC")]
    assert answer["status"] == "ok"
    assert answer["source"] == "deribit"
    # Deribit quotes its premiums in the base coin, and its book is live.
    assert answer["premiumUnit"] == "BTC"
    assert answer["delayS"] == 0
    assert answer["underlyingPrice"] == 97600.0


async def test_the_deribit_market_asks_deribit_first_and_bybit_when_deribit_lists_no_contract() -> None:
    publishers = _Publishers(
        {DERIBIT_SOURCE: _deribit_chain([]), BYBIT_SOURCE: _bybit_chain([_bybit_row("BTC-13NOV26-98000-C-USDT")])}
    )
    answer = await _boarded(publishers).view("deribit", "BTC-PERPETUAL")
    assert publishers.calls == [(DERIBIT_SOURCE, "BTC"), (BYBIT_SOURCE, "BTC")]
    assert answer["status"] == "ok"
    assert answer["source"] == "bybit"
    assert answer["premiumUnit"] == "USDT"
    assert answer["delayS"] == 0


async def test_a_bybit_answer_never_takes_strikes_from_deribit() -> None:
    publishers = _Publishers(
        {
            BYBIT_SOURCE: _bybit_chain([_bybit_row("BTC-13NOV26-98000-C-USDT")]),
            DERIBIT_SOURCE: _deribit_chain([_deribit_row("BTC-13NOV26-99000-C")]),
        }
    )
    answer = await _boarded(publishers).view("binance-spot", "BTCUSDT")
    assert answer["source"] == "bybit"
    assert [row["strike"] for row in answer["strikes"]] == [98000.0]
    # Deribit lists 99000 as well, but a chain is one publisher's answer: it is not read.
    assert publishers.calls == [(BYBIT_SOURCE, "BTC")]


async def test_a_cboe_answer_never_carries_a_strike_of_the_scanner() -> None:
    rows = [
        _occ("AAPL261113C00200000", bid=1.0, ask=1.2),
        _occ("AAPL261113C00205000", bid=0.5, ask=0.6),
    ]
    publishers = _Publishers({CBOE_SOURCE: _cboe_chain("AAPL", rows)})
    scanner = _Scanner(series=_aapl_listing(), chain=_one_call())
    answer = await _boarded(publishers, scanner=scanner).view("equity", "AAPL")
    assert [row["strike"] for row in answer["strikes"]] == [200.0, 205.0]
    # The scanner's contract (strike 300) is not read in; every side is Cboe's own symbol.
    for row in answer["strikes"]:
        assert row["call"]["symbol"].startswith("AAPL")
    assert scanner.chain_calls == []


# --- 15. caching of whole chains ------------------------------------------------------------


async def test_a_whole_chain_is_read_once_within_its_ttl() -> None:
    publishers = _Publishers({BYBIT_SOURCE: _bybit_chain([_bybit_row("BTC-13NOV26-98000-C-USDT")])})
    clock = _Clock()
    chains = _boarded(publishers, clock=clock)
    await chains.view("binance-spot", "BTCUSDT")
    clock.advance(BOARD_TTL_S - 1)
    await chains.view("binance-spot", "BTCUSDT")
    assert publishers.calls == [(BYBIT_SOURCE, "BTC")]


async def test_cboe_keeps_its_longer_ttl_while_a_bybit_reading_is_read_again() -> None:
    publishers = _Publishers(
        {
            CBOE_SOURCE: _cboe_chain("AAPL", [_occ("AAPL261113C00200000", bid=1.0, ask=1.2)]),
            BYBIT_SOURCE: _bybit_chain([_bybit_row("BTC-13NOV26-98000-C-USDT")]),
        }
    )
    clock = _Clock()
    chains = _boarded(publishers, clock=clock)
    await chains.view("equity", "AAPL")
    await chains.view("binance-spot", "BTCUSDT")
    clock.advance(BOARD_TTL_S + 1)
    await chains.view("equity", "AAPL")
    await chains.view("binance-spot", "BTCUSDT")
    # After twenty-one seconds Cboe's reading (a minute's TTL) is still served; bybit's is not.
    assert publishers.calls == [
        (CBOE_SOURCE, "AAPL"),
        (BYBIT_SOURCE, "BTC"),
        (BYBIT_SOURCE, "BTC"),
    ]


async def test_cboe_is_read_again_once_its_own_minute_has_passed() -> None:
    publishers = _Publishers(
        {CBOE_SOURCE: _cboe_chain("AAPL", [_occ("AAPL261113C00200000", bid=1.0, ask=1.2)])}
    )
    clock = _Clock()
    chains = _boarded(publishers, clock=clock)
    await chains.view("equity", "AAPL")
    clock.advance(CBOE_BOARD_TTL_S + 1)
    await chains.view("equity", "AAPL")
    assert publishers.calls == [(CBOE_SOURCE, "AAPL"), (CBOE_SOURCE, "AAPL")]


async def test_a_failed_refresh_serves_the_last_chain_as_stale() -> None:
    publishers = _Publishers({BYBIT_SOURCE: _bybit_chain([_bybit_row("BTC-13NOV26-98000-C-USDT")])})
    clock = _Clock()
    wall = [111]
    chains = _boarded(publishers, clock=clock, wall=wall)
    good = await chains.view("binance-spot", "BTCUSDT")
    publishers.answers[BYBIT_SOURCE] = RuntimeError("bybit unavailable")
    clock.advance(BOARD_TTL_S + 1)
    wall[0] = 999
    stale = await chains.view("binance-spot", "BTCUSDT")
    assert stale["status"] == "ok"
    assert stale["stale"] is True
    assert stale["strikes"] == good["strikes"]
    # The stale reading keeps the time it was taken, not the time of the failed refresh.
    assert stale["capturedMs"] == 111


# --- 16. series of a published chain ----------------------------------------------------------


async def test_a_published_series_is_selected_by_expiry_and_root() -> None:
    chains = _boarded(_Publishers({CBOE_SOURCE: _spx_cboe_chain()}))
    answer = await chains.view("indices", "SP:SPX", expiry=NOV_13, root="SPX")
    assert answer["source"] == "cboe"
    assert answer["selected"] == {"root": "SPX", "expiry": "2026-11-13"}
    assert [row["strike"] for row in answer["strikes"]] == [5000.0]
    assert answer["series"] == [
        {"root": "SPX", "expiry": "2026-11-13", "contracts": 1},
        {"root": "SPXW", "expiry": "2026-11-13", "contracts": 1},
        {"root": "SPXW", "expiry": "2026-11-20", "contracts": 1},
        {"root": "SPX", "expiry": "2026-12-18", "contracts": 1},
    ]


async def test_a_family_on_the_same_day_is_never_merged_into_another() -> None:
    chains = _boarded(_Publishers({CBOE_SOURCE: _spx_cboe_chain()}))
    spxw = await chains.view("indices", "SP:SPX", expiry=NOV_13, root="SPXW")
    spx = await chains.view("indices", "SP:SPX", expiry=NOV_13, root="SPX")
    assert spxw["selected"] == {"root": "SPXW", "expiry": "2026-11-13"}
    assert [row["strike"] for row in spxw["strikes"]] == [5010.0]
    assert spx["selected"] == {"root": "SPX", "expiry": "2026-11-13"}
    assert [row["strike"] for row in spx["strikes"]] == [5000.0]

