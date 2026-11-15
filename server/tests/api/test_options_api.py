"""The ``GET /api/options`` route, end to end through the FastAPI app. NO network.

An :class:`OptionChains` is built with fake ``series_fn`` and ``chain_fn`` (the two reads the
feed makes), and installed through ``create_app(..., option_chains=...)``. The route, its
validators, the error envelope and the feed's own answer shape all run for real. Contract
records are built by the real ``parse_option_chain`` from a small scanner body, so the fakes
return what the scanner really would.

Expected values are written by hand from the fake listings and bodies, never by calling the
code under test.
"""

from __future__ import annotations

import json
from datetime import date

import httpx
import pytest
from crocodile.core.schema.records import OptionsChain
from crocodile.equity.universal.live.assets import OptionSeries, parse_option_chain
from crocodile.equity.universal.live.chains import (
    BYBIT_SOURCE,
    DERIBIT_SOURCE,
    PublishedChain,
    parse_bybit_chain,
)
from fastapi import FastAPI

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.feeds import option_chains as option_feed
from flowmap_server.feeds.option_chains import OptionChains

CAPTURED_MS = 1_700_000_000_123
CAPTURED_NS = CAPTURED_MS * 1_000_000
UNDERLYING = "NASDAQ:AAPL"
AAPL_CANDIDATES = ("NASDAQ:AAPL", "NYSE:AAPL", "AMEX:AAPL")


def _contract(symbol: str, strike: float, right: str, expiry: int = 20261218) -> list[object]:
    """One scanner row, cells in ``OPTION_COLUMNS`` order."""
    return [symbol, 1.0, 1.2, strike, expiry, right, 1.1, 0.25, 0.5, 0.01, -0.02, 0.1, 0.05,
            "USD", "AAPL"]


def _records(*cells: list[object]) -> list[OptionsChain]:
    rows = [{"s": f"OPRA:{cell[0]}", "d": cell} for cell in cells]
    body = json.dumps({"totalCount": len(rows), "data": rows}).encode()
    return parse_option_chain(body, UNDERLYING, captured_ns=CAPTURED_NS)


class FakeChains:
    """Stands in for the two provider reads: the series listing and one series' contracts."""

    def __init__(self) -> None:
        self.listed: list[OptionSeries] = [
            OptionSeries(underlying=UNDERLYING, root="AAPL", expiry=date(2026, 11, 20), contracts=40),
            OptionSeries(underlying=UNDERLYING, root="AAPL", expiry=date(2026, 12, 18), contracts=60),
            OptionSeries(underlying=UNDERLYING, root="AAPLW", expiry=date(2026, 12, 18), contracts=10),
        ]
        self.records: list[OptionsChain] = _records(
            _contract("AAPL261218C300.0", 300.0, "call"),
            _contract("AAPL261218P300.0", 300.0, "put"),
            _contract("AAPL261218C310.0", 310.0, "call"),
        )
        self.series_error: Exception | None = None
        self.chain_error: Exception | None = None
        self.series_calls: list[tuple[str, ...]] = []
        self.chain_calls: list[tuple[str, date, str]] = []

    async def series(self, underlyings):
        self.series_calls.append(tuple(underlyings))
        if self.series_error is not None:
            raise self.series_error
        return list(self.listed)

    async def chain(self, underlying, expiry, root):
        self.chain_calls.append((underlying, expiry, root))
        if self.chain_error is not None:
            raise self.chain_error
        return list(self.records)


async def _no_publisher(publisher: str, underlying: str) -> PublishedChain:
    """A publisher that lists nothing for the instrument, so the scanner is asked: these
    tests are about the route and the scanner path. The publishers have their own tests."""
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


def _feed(fake: FakeChains) -> OptionChains:
    return OptionChains(
        series_fn=fake.series,
        chain_fn=fake.chain,
        board_fn=_no_publisher,
        wall_ms_fn=lambda: CAPTURED_MS,
    )


def _app(option_chains: OptionChains | None = None) -> FastAPI:
    return create_app(Config(), option_chains=option_chains)


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720"
    )


# --- a good request ----------------------------------------------------------------


async def test_a_share_answers_its_chain_with_every_field_of_the_contract() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {
        "market", "symbol", "status", "underlying", "underlyingPrice", "premiumUnit", "delayS",
        "series", "selected", "strikes", "capturedMs", "stale", "source",
    }
    assert body["market"] == "equity"
    assert body["symbol"] == "AAPL"
    assert body["status"] == "ok"
    assert body["source"] == "tradingview"
    assert body["underlying"] == UNDERLYING
    # The scanner states no price, unit or delay for the chain: they are null, not guessed.
    assert body["underlyingPrice"] is None
    assert body["premiumUnit"] is None
    assert body["delayS"] is None
    assert body["capturedMs"] == CAPTURED_MS
    assert body["stale"] is False
    # Every side has the same keys, whichever publisher answered; the scanner's are null here.
    assert set(body["strikes"][0]["call"]) == {
        "symbol", "bid", "bidSize", "ask", "askSize", "last", "theo", "iv", "volume",
        "openInterest", "delta", "gamma", "theta", "vega", "rho",
    }


async def test_a_share_lists_its_series_and_strikes_one_row_per_strike_ascending() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        body = (await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})).json()
    # Series ordered by expiry, then contract family.
    assert [(s["root"], s["expiry"], s["contracts"]) for s in body["series"]] == [
        ("AAPL", "2026-11-20", 40),
        ("AAPL", "2026-12-18", 60),
        ("AAPLW", "2026-12-18", 10),
    ]
    # Strike 300 lists both sides; strike 310 lists a call only, so its put is null.
    assert [row["strike"] for row in body["strikes"]] == [300.0, 310.0]
    strike_300, strike_310 = body["strikes"]
    assert strike_300["call"]["symbol"] == "OPRA:AAPL261218C300.0"
    assert strike_300["put"]["symbol"] == "OPRA:AAPL261218P300.0"
    assert strike_310["call"] is not None
    assert strike_310["put"] is None
    assert strike_300["call"]["bid"] == 1.0
    assert strike_300["call"]["ask"] == 1.2
    assert strike_300["call"]["iv"] == 0.25


async def test_a_share_is_looked_up_on_all_three_us_venues_in_one_request() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    # The venue is not part of a share's symbol: every candidate is named in one series call.
    assert fake.series_calls == [AAPL_CANDIDATES]


# --- expiry and root reach the service -----------------------------------------------


async def test_an_expiry_and_a_root_select_that_series_and_nothing_else() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        body = (
            await c.get(
                "/api/options",
                params={"market": "equity", "symbol": "AAPL", "expiry": "2026-12-18", "root": "AAPLW"},
            )
        ).json()
    # The weekly family shares the expiry day with AAPL; the root is what tells them apart.
    assert fake.chain_calls == [(UNDERLYING, date(2026, 12, 18), "AAPLW")]
    assert body["selected"] == {"root": "AAPLW", "expiry": "2026-12-18"}
    assert body["status"] == "ok"


async def test_without_an_expiry_or_root_the_nearest_series_is_served_and_named() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        body = (await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})).json()
    assert fake.chain_calls == [(UNDERLYING, date(2026, 11, 20), "AAPL")]
    assert body["selected"] == {"root": "AAPL", "expiry": "2026-11-20"}


async def test_empty_expiry_and_root_strings_behave_as_absent() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        r = await c.get(
            "/api/options",
            params={"market": "equity", "symbol": "AAPL", "expiry": "", "root": ""},
        )
    assert r.status_code == 200
    assert fake.chain_calls == [(UNDERLYING, date(2026, 11, 20), "AAPL")]


# --- validation -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"market": "nope", "symbol": "AAPL"}, "unknown_market"),
        ({"market": "equity", "symbol": "AA PL"}, "invalid_symbol"),
        ({"market": "equity", "symbol": "A" * 65}, "invalid_symbol"),
        ({"market": "equity", "symbol": "AAPL", "expiry": "2026-13-40"}, "invalid_params"),
        ({"market": "equity", "symbol": "AAPL", "expiry": "20261113"}, "invalid_params"),
        ({"market": "equity", "symbol": "AAPL", "expiry": "tomorrow"}, "invalid_params"),
        ({"market": "equity", "symbol": "AAPL", "root": "AA PL"}, "invalid_params"),
        ({"market": "equity", "symbol": "AAPL", "root": "R" * 33}, "invalid_params"),
    ],
)
async def test_a_bad_parameter_is_a_422_in_the_error_envelope_and_fetches_nothing(
    params: dict[str, str], code: str
) -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params=params)
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == code
    assert isinstance(error["message"], str) and error["message"]
    # Refused before any provider read: a bad request must not reach the source.
    assert fake.series_calls == []
    assert fake.chain_calls == []


async def test_a_symbol_and_a_root_of_the_longest_allowed_length_are_accepted() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        symbol_ok = await c.get("/api/options", params={"market": "equity", "symbol": "A" * 64})
        root_ok = await c.get(
            "/api/options",
            params={"market": "equity", "symbol": "AAPL", "root": "R" * 32},
        )
    assert symbol_ok.status_code == 200
    assert root_ok.status_code == 200


# --- markets that have no ticker the source spells ----------------------------------


@pytest.mark.parametrize(
    ("market", "symbol", "status"),
    [("sim", "BTCUSDT", "unsupported"), ("binance", "BTCUSDT", "none")],
)
async def test_a_crypto_venue_or_the_sim_feed_is_unsupported_and_never_reads_the_source(
    market: str, symbol: str, status: str
) -> None:
    # A crypto venue reads its own publishers now; with none listing the coin it is "none".
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": market, "symbol": symbol})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == status
    assert body["underlying"] is None
    assert body["strikes"] == []
    assert body["series"] == []
    # The scanner has no ticker for a crypto symbol or the sim feed: the fakes are never called.
    assert fake.series_calls == []
    assert fake.chain_calls == []


# --- crypto venues, answered by their own publishers ----------------------------------


class FakePublishers:
    """Stands in for the whole-chain publishers: each answers what it was given, or raises it."""

    def __init__(self, answers: dict[str, PublishedChain | Exception]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, publisher: str, underlying: str) -> PublishedChain:
        self.calls.append((publisher, underlying))
        answer = self.answers.get(publisher)
        if answer is None:
            return await _no_publisher(publisher, underlying)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _bybit_chain() -> PublishedChain:
    """Bybit's answer for one BTC call, parsed by the real parser."""
    row = {
        "symbol": "BTC-13NOV26-98000-C-USDT",
        "bid1Price": "1000",
        "bid1Size": "0.5",
        "ask1Price": "1100",
        "ask1Size": "0.4",
        "markPrice": "1050",
        "markIv": "0.6",
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
    body = {"retCode": 0, "retMsg": "OK", "result": {"list": [row]}, "time": 1700000000000}
    return parse_bybit_chain(json.dumps(body).encode(), "BTC", captured_ns=CAPTURED_NS)


def _boarded_feed(fake: FakeChains, publishers: FakePublishers) -> OptionChains:
    return OptionChains(
        series_fn=fake.series,
        chain_fn=fake.chain,
        board_fn=publishers,
        wall_ms_fn=lambda: CAPTURED_MS,
    )


async def test_a_crypto_venue_is_answered_by_bybit_over_the_api() -> None:
    fake = FakeChains()
    publishers = FakePublishers({BYBIT_SOURCE: _bybit_chain()})
    async with _client(_app(_boarded_feed(fake, publishers))) as c:
        r = await c.get("/api/options", params={"market": "binance-spot", "symbol": "BTCUSDT"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["source"] == "bybit"
    assert body["underlying"] == "BTC"
    # Bybit's index price is the underlying's price; its premiums are in USDT, and it is live.
    assert body["underlyingPrice"] == 97500.0
    assert body["premiumUnit"] == "USDT"
    assert body["delayS"] == 0
    assert body["selected"] == {"root": "BTC-USDT", "expiry": "2026-11-13"}
    assert [row["strike"] for row in body["strikes"]] == [98000.0]
    assert publishers.calls == [(BYBIT_SOURCE, "BTC")]
    assert fake.series_calls == []
    assert fake.chain_calls == []


@pytest.mark.parametrize(
    ("market", "symbol", "answers", "status"),
    [
        ("sim", "SIM-DEMO", {}, "unsupported"),
        ("binance-spot", "BTCUSDT", {}, "none"),
        ("binance-spot", "BTCUSDT", {BYBIT_SOURCE: _bybit_chain()}, "ok"),
        (
            "binance-spot",
            "BTCUSDT",
            {BYBIT_SOURCE: RuntimeError("bybit down"), DERIBIT_SOURCE: RuntimeError("deribit down")},
            "unreachable",
        ),
    ],
)
async def test_every_answer_states_its_price_unit_and_delay_keys(
    market: str, symbol: str, answers: dict[str, PublishedChain | Exception], status: str
) -> None:
    # The keys are part of every answer, whatever the status, so the screen reads one shape.
    fake = FakeChains()
    async with _client(_app(_boarded_feed(fake, FakePublishers(answers)))) as c:
        r = await c.get("/api/options", params={"market": market, "symbol": symbol})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == status
    for key in ("underlyingPrice", "premiumUnit", "delayS"):
        assert key in body


# --- provider faults ----------------------------------------------------------------------


async def test_a_failing_series_listing_answers_unreachable_not_a_500() -> None:
    fake = FakeChains()
    fake.series_error = RuntimeError("scanner down")
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unreachable"
    assert body["strikes"] == []
    assert fake.chain_calls == []


async def test_a_failing_chain_read_with_series_known_answers_unreachable() -> None:
    fake = FakeChains()
    fake.chain_error = RuntimeError("contracts unreadable")
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unreachable"
    # The series were read fine, so the answer still says which series it could not read.
    assert body["selected"] == {"root": "AAPL", "expiry": "2026-11-20"}
    assert body["strikes"] == []


async def test_a_listing_without_the_instrument_answers_none() -> None:
    fake = FakeChains()
    fake.listed = []
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "none"
    assert body["underlying"] is None
    assert fake.chain_calls == []


# --- symbols that carry a colon or a bang ------------------------------------------


async def test_an_index_ticker_with_a_colon_is_accepted_and_read_as_its_own_underlying() -> None:
    fake = FakeChains()
    fake.listed = [
        OptionSeries(underlying="SP:SPX", root="SPX", expiry=date(2026, 12, 18), contracts=900),
    ]
    async with _client(_app(_feed(fake))) as c:
        r = await c.get("/api/options", params={"market": "indices", "symbol": "SP:SPX"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["underlying"] == "SP:SPX"
    assert fake.series_calls == [("SP:SPX",)]


async def test_a_futures_symbol_with_a_bang_is_accepted_and_read_as_its_own_underlying() -> None:
    fake = FakeChains()
    fake.listed = [
        OptionSeries(underlying="CME_MINI:ES1!", root="EW", expiry=date(2026, 12, 18), contracts=50),
    ]
    async with _client(_app(_feed(fake))) as c:
        r = await c.get(
            "/api/options", params={"market": "futures-cme_mini", "symbol": "ES1!"}
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["underlying"] == "CME_MINI:ES1!"
    assert fake.series_calls == [("CME_MINI:ES1!",)]


# --- the feed the route creates when none is wired ----------------------------------


@pytest.mark.parametrize("replace_with_wrong_type", [False, True])
async def test_a_missing_or_wrong_typed_feed_is_replaced_by_a_real_one_and_answers_200(
    monkeypatch: pytest.MonkeyPatch, replace_with_wrong_type: bool
) -> None:
    fake = FakeChains()
    # Keep the route's default feed off the network: its reads are the fakes. AAPL is asked of
    # Cboe first, so Cboe's publisher read is replaced too.
    monkeypatch.setattr(option_feed, "_default_series", fake.series)
    monkeypatch.setattr(option_feed, "_default_chain", fake.chain)
    monkeypatch.setattr(option_feed, "_default_board", _no_publisher)
    app = _app()
    if replace_with_wrong_type:
        app.state.option_chains = object()
    else:
        del app.state.option_chains
    async with _client(app) as c:
        r = await c.get("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert isinstance(app.state.option_chains, OptionChains)


# --- the method ----------------------------------------------------------------------


async def test_the_route_is_get_only_so_a_post_is_a_405() -> None:
    fake = FakeChains()
    async with _client(_app(_feed(fake))) as c:
        r = await c.post("/api/options", params={"market": "equity", "symbol": "AAPL"})
    assert r.status_code == 405
    assert r.json()["error"]["code"] == "method_not_allowed"
    assert fake.series_calls == []
