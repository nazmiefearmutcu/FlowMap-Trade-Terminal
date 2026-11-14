"""Option GEX and put/call ratio: symbols, expiry rules, max pain and both sources. No network."""

from __future__ import annotations

from datetime import UTC, date, datetime
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
from multidict import CIMultiDict, CIMultiDictProxy
import pytest
from yarl import URL

from flowmap_server.core.gex import OptionContract, bs_gamma, calculate_gex
from flowmap_server.research.options import (
    CBOE_VENUE,
    CBOE_URL,
    DERIBIT_URL,
    OptionsSource,
    _nearest_monthly,
    _Row,
    days_to_expiry,
    last_friday,
    max_pain,
    parse_deribit_name,
    parse_occ_symbol,
    put_call_oi_ratio,
    third_friday,
)

FIXTURES = Path(__file__).parent / "fixtures"
NEW_YORK = ZoneInfo("America/New_York")
NOW_NS = int(datetime(2026, 11, 15, 12, tzinfo=UTC).timestamp() * 1_000_000_000)


class FakeHttp:
    """Stands in for ``Http``: answers each URL from a map, or raises the mapped error."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, dict[str, str] | None]] = []

    async def get_json(
        self,
        url: str,
        *,
        limit: int,
        headers: Any = None,
        params: dict[str, str] | None = None,
        timeout_s: float = 12.0,
    ) -> object:
        self.calls.append((url, params))
        answer = self.answers[url]
        if isinstance(answer, BaseException):
            raise answer
        return answer


def _status(code: int) -> aiohttp.ClientResponseError:
    request = aiohttp.RequestInfo(
        URL("https://example.invalid/"), "GET", CIMultiDictProxy(CIMultiDict()),
        URL("https://example.invalid/"),
    )
    return aiohttp.ClientResponseError(request, (), status=code)


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _cboe_doc(timestamp: str, options: list[dict[str, Any]], spot: float = 161.01) -> dict[str, Any]:
    return {"timestamp": timestamp, "data": {"current_price": spot, "options": options}}


def _cboe_row(symbol: str, open_interest: float = 10.0, iv: float = 0.5) -> dict[str, Any]:
    return {"option": symbol, "open_interest": open_interest, "iv": iv}


def _deribit_item(name: str, oi: float, mark_iv: float, created_ms: int, spot: float = 60000.0) -> dict[str, Any]:
    return {
        "instrument_name": name,
        "open_interest": oi,
        "mark_iv": mark_iv,
        "creation_timestamp": created_ms,
        "estimated_delivery_price": spot,
    }


def _utc_ms(year: int, month: int, day: int, hour: int = 0) -> int:
    return int(datetime(year, month, day, hour, tzinfo=UTC).timestamp() * 1000)


# Parsing and calendar rules


def test_occ_symbol_gives_expiry_side_and_strike() -> None:
    assert parse_occ_symbol("NVDA261120C00150000", "NVDA") == (date(2026, 11, 20), True, 150.0)
    assert parse_occ_symbol("NVDA261120P00012500", "NVDA") == (date(2026, 11, 20), False, 12.5)


def test_occ_symbol_keeps_only_its_own_root() -> None:
    # An adjusted contract carries another root and is not this ticker's chain.
    assert parse_occ_symbol("B1VDA261120C00165000", "NVDA") is None
    assert parse_occ_symbol("B1VDA261120C00165000", "B1VDA") == (date(2026, 11, 20), True, 165.0)
    assert parse_occ_symbol("NVDA2611C00150000", "NVDA") is None
    assert parse_occ_symbol("NVDA261132C00150000", "NVDA") is None
    assert parse_occ_symbol("BRKB261120C00300000", "BRKB") == (date(2026, 11, 20), True, 300.0)


def test_deribit_name_gives_expiry_side_and_strike() -> None:
    assert parse_deribit_name("BTC-29JAN27-72000-C", "BTC") == (date(2027, 1, 29), True, 72000.0)
    assert parse_deribit_name("BTC-27NOV26-60000-P", "BTC") == (date(2026, 11, 27), False, 60000.0)
    assert parse_deribit_name("BTC-27NOV26", "BTC") is None  # A future, not an option.
    assert parse_deribit_name("BTC-PERPETUAL", "BTC") is None
    assert parse_deribit_name("ETH-27NOV26-3000-C", "BTC") is None


def test_days_to_expiry_runs_from_the_quote_to_1600_new_york() -> None:
    quote = datetime(2026, 11, 14, 22, 24, 14, tzinfo=NEW_YORK)
    expires = datetime(2026, 11, 16, 16, 0, 0, tzinfo=NEW_YORK)
    expected = 1 + (17 * 3600 + 35 * 60 + 46) / 86400
    assert days_to_expiry(quote, expires) == pytest.approx(expected, abs=1e-9)


def test_days_to_expiry_is_exact_across_a_daylight_saving_change() -> None:
    # Both instants are NY wall-clock, but DST changes in between: the answer is elapsed UTC time.
    quote = datetime(2026, 11, 14, 22, 24, 14, tzinfo=NEW_YORK)
    expires = datetime(2027, 3, 19, 16, 0, 0, tzinfo=NEW_YORK)
    expected = (
        datetime(2027, 3, 19, 20, 0, 0, tzinfo=UTC) - datetime(2026, 11, 15, 3, 24, 14, tzinfo=UTC)
    ).total_seconds() / 86400
    assert days_to_expiry(quote, expires) == pytest.approx(expected, abs=1e-9)


def test_monthly_expiries_are_third_and_last_fridays() -> None:
    assert third_friday(2026, 11) == date(2026, 11, 20)
    assert third_friday(2027, 1) == date(2027, 1, 15)
    assert last_friday(2026, 11) == date(2026, 11, 27)
    assert last_friday(2026, 12) == date(2026, 12, 25)


def test_nearest_monthly_is_the_first_one_not_yet_expired() -> None:
    before = datetime(2026, 11, 14, 22, 24, tzinfo=NEW_YORK)
    on_expiry_morning = datetime(2026, 11, 20, 10, 0, tzinfo=NEW_YORK)
    after_expiry = datetime(2026, 11, 20, 17, 0, tzinfo=NEW_YORK)
    assert _nearest_monthly(CBOE_VENUE, before) == date(2026, 11, 20)
    assert _nearest_monthly(CBOE_VENUE, on_expiry_morning) == date(2026, 11, 20)
    assert _nearest_monthly(CBOE_VENUE, after_expiry) == date(2026, 12, 18)


# Chain statistics


def _row(expiry: date, strike: float, is_call: bool, oi: float) -> _Row:
    return _Row(expiry, strike, is_call, oi, 0.5, 10.0)


def test_max_pain_is_the_strike_that_minimises_the_holders_payout() -> None:
    expiry = date(2026, 11, 20)
    chain = [
        _row(expiry, 90.0, True, 100.0),
        _row(expiry, 110.0, True, 50.0),
        _row(expiry, 100.0, False, 80.0),
    ]
    # Paid to holders at a settle of 90, 100 and 110: 800, 1000 and 2000.
    assert max_pain(chain) == 90.0


def test_max_pain_ties_go_to_the_lower_strike() -> None:
    expiry = date(2026, 11, 20)
    chain = [_row(expiry, 90.0, True, 10.0), _row(expiry, 110.0, False, 10.0)]
    # Settling at 90, 100 or 110 pays 200 in every case.
    assert max_pain(chain) == 90.0


def test_max_pain_of_no_rows_is_none() -> None:
    assert max_pain([]) is None


def test_put_call_ratio_is_put_over_call_open_interest() -> None:
    expiry = date(2026, 11, 20)
    chain = [
        _row(expiry, 90.0, True, 100.0),
        _row(expiry, 110.0, True, 50.0),
        _row(expiry, 100.0, False, 75.0),
    ]
    assert put_call_oi_ratio(chain) == pytest.approx(0.5)


def test_put_call_ratio_without_call_open_interest_is_none() -> None:
    assert put_call_oi_ratio([_row(date(2026, 11, 20), 100.0, False, 75.0)]) is None


# Cboe (US stocks)


async def test_cboe_fixture_gives_the_gex_data_keys() -> None:
    doc = _load("options_cboe_nvda.json")
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]

    assert section.status == "ok"
    assert section.section == "gex"
    assert section.source == "Cboe delayed options"
    assert section.as_of == "2026-11-14"
    assert set(section.data or {}) == {
        "spot", "netGex", "callWall", "putWall", "gammaFlip", "putCallOiRatio",
        "contracts", "expiries", "maxPain", "maxPainExpiry", "currency",
    }
    assert section.data is not None
    assert section.data["spot"] == 161.01
    assert section.data["currency"] == "USD"


async def test_cboe_fixture_counts_and_ratios_match_a_recount() -> None:
    doc = _load("options_cboe_nvda.json")
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]
    assert section.data is not None

    # Recount from the fixture by hand: the adjusted B1VDA row, the zero-OI row and the
    # zero-IV row are out, so 16 contracts remain over two expiries.
    rows = [item for item in doc["data"]["options"] if item["option"].startswith("NVDA")]
    used = [item for item in rows if item["open_interest"] > 0 and item["iv"] > 0]
    calls = sum(item["open_interest"] for item in used if item["option"][-9] == "C")
    puts = sum(item["open_interest"] for item in used if item["option"][-9] == "P")
    assert section.data["contracts"] == len(used) == 16
    assert section.data["expiries"] == 2
    assert section.data["putCallOiRatio"] == pytest.approx(puts / calls)


async def test_cboe_net_gex_is_the_model_on_the_same_chain() -> None:
    doc = _load("options_cboe_nvda.json")
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]
    assert section.data is not None

    quote = datetime(2026, 11, 14, 22, 24, 14, tzinfo=NEW_YORK)
    contracts = []
    for item in doc["data"]["options"]:
        if not item["option"].startswith("NVDA") or item["open_interest"] <= 0 or item["iv"] <= 0:
            continue
        expiry, is_call, strike = parse_occ_symbol(item["option"], "NVDA")  # type: ignore[misc]
        dte = days_to_expiry(quote, datetime(expiry.year, expiry.month, expiry.day, 16, tzinfo=NEW_YORK))
        contracts.append(OptionContract(strike, is_call, item["open_interest"], item["iv"], dte))
    model = calculate_gex("NVDA", 161.01, contracts)
    # A stock contract is 100 shares, which is the model's own multiplier: no rescaling.
    assert section.data["netGex"] == pytest.approx(model.net_gex, rel=1e-12)
    assert section.data["callWall"] == model.call_wall
    assert section.data["putWall"] == model.put_wall
    assert section.data["gammaFlip"] == pytest.approx(model.gamma_flip)


async def test_cboe_max_pain_is_taken_on_the_nearest_third_friday() -> None:
    doc = _load("options_cboe_nvda.json")
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]
    assert section.data is not None

    # 16 Nov is not a monthly, so the expiry is 20 Nov, the third Friday.
    assert section.data["maxPainExpiry"] == "2026-11-20"
    settles = sorted({float(item["option"][-8:]) / 1000 for item in doc["data"]["options"]
                      if item["option"].startswith("NVDA261120") and item["open_interest"] > 0})
    paid: dict[float, float] = {}
    for settle in settles:
        total = 0.0
        for item in doc["data"]["options"]:
            if not item["option"].startswith("NVDA261120") or item["open_interest"] <= 0:
                continue
            strike = float(item["option"][-8:]) / 1000
            if item["option"][-9] == "C":
                total += item["open_interest"] * max(settle - strike, 0.0)
            else:
                total += item["open_interest"] * max(strike - settle, 0.0)
        paid[settle] = total
    expected = min(paid, key=lambda settle: (paid[settle], settle))
    assert section.data["maxPain"] == expected


async def test_cboe_404_is_an_unlisted_symbol_not_applicable() -> None:
    http = FakeHttp({f"{CBOE_URL}/ZZZQ.json": _status(404)})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("ZZZQ")  # type: ignore[arg-type]
    assert section.status == "not_applicable"
    assert section.reason == "no_listed_options"
    assert section.data is None


async def test_cboe_403_is_raised_not_read_as_unlisted() -> None:
    # A 403 may be a rate limit or a block; it must not be cached as "no listed options".
    http = FakeHttp({f"{CBOE_URL}/ZZZQ.json": _status(403)})
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("ZZZQ")  # type: ignore[arg-type]
    assert caught.value.status == 403


async def test_cboe_other_http_failures_are_raised() -> None:
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": _status(500)})
    with pytest.raises(aiohttp.ClientResponseError):
        await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]


async def test_cboe_reply_without_a_current_price_raises() -> None:
    # A malformed reply is a source fault: it must not be cached as "no data".
    doc = _load("options_cboe_nvda.json")
    del doc["data"]["current_price"]
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    with pytest.raises(ValueError, match="current_price"):
        await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]


async def test_cboe_reply_with_a_zero_price_raises() -> None:
    doc = _load("options_cboe_nvda.json")
    doc["data"]["current_price"] = 0
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    with pytest.raises(ValueError, match="current_price"):
        await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]


async def test_cboe_reply_without_a_timestamp_raises_a_clear_error() -> None:
    doc = _load("options_cboe_nvda.json")
    del doc["timestamp"]
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    with pytest.raises(ValueError, match="timestamp"):
        await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]


async def test_cboe_class_share_uses_the_root_without_its_dot() -> None:
    doc = _cboe_doc("2026-11-14 22:24:14", [
        _cboe_row("BRKB261120C00500000", open_interest=20.0, iv=0.2),
        _cboe_row("BRKB261120P00500000", open_interest=30.0, iv=0.2),
        _cboe_row("BRKA261120C00500000", open_interest=99.0, iv=0.2),
    ], spot=500.0)
    http = FakeHttp({f"{CBOE_URL}/BRK.B.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("BRK.B")  # type: ignore[arg-type]
    assert http.calls[0][0] == f"{CBOE_URL}/BRK.B.json"
    assert section.status == "ok"
    assert section.data is not None
    assert section.data["contracts"] == 2
    assert section.data["putCallOiRatio"] == pytest.approx(30.0 / 20.0)


async def test_cboe_expired_rows_are_dropped() -> None:
    doc = _cboe_doc("2026-11-17 10:00:00", [_cboe_row("NVDA261116C00160000")])
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]
    assert section.status == "empty"
    assert section.reason == "missing or invalid option chain"


async def test_cboe_chain_with_no_open_interest_is_empty_with_the_model_reason() -> None:
    doc = _cboe_doc("2026-11-14 22:24:14", [_cboe_row("NVDA261120C00160000", open_interest=0.0)])
    http = FakeHttp({f"{CBOE_URL}/NVDA.json": doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).equity_gex("NVDA")  # type: ignore[arg-type]
    assert section.status == "empty"
    assert section.reason == "missing or invalid option chain"
    assert section.data is None


# Deribit (BTC and ETH)


async def test_deribit_fixture_gives_the_gex_data_keys() -> None:
    doc = _load("options_deribit_btc.json")
    http = FakeHttp({DERIBIT_URL: doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]

    assert http.calls == [(DERIBIT_URL, {"currency": "BTC", "kind": "option"})]
    assert section.status == "ok"
    assert section.section == "options"
    assert section.source == "Deribit"
    assert section.as_of == "2026-11-14"
    assert set(section.data or {}) == {
        "spot", "netGex", "callWall", "putWall", "gammaFlip", "putCallOiRatio",
        "contracts", "expiries", "maxPain", "maxPainExpiry", "currency",
    }
    assert section.data is not None
    assert section.data["currency"] == "USD"
    assert section.data["spot"] == 63384.46
    # Seven rows have open interest; the three with none are out.
    assert section.data["contracts"] == 7
    assert section.data["expiries"] == 2
    # Max pain is on the last Friday of November (Deribit's monthly), 27 Nov 2026.
    assert section.data["maxPainExpiry"] == "2026-11-27"


async def test_deribit_net_gex_is_usd_for_one_coin_contracts() -> None:
    # One 60000 call, 10 coins of open interest, 50% IV, expiring 27 Nov 2026 08:00 UTC,
    # quoted 15 Nov 2026 00:00 UTC. A 1-coin contract's GEX is gamma * OI * spot^2 in USD.
    quote_ms = _utc_ms(2026, 11, 15)
    doc = {"jsonrpc": "2.0", "id": 1, "result": [
        _deribit_item("BTC-27NOV26-60000-C", oi=10.0, mark_iv=50.0, created_ms=quote_ms),
    ]}
    http = FakeHttp({DERIBIT_URL: doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]
    assert section.data is not None

    dte = (datetime(2026, 11, 27, 8, tzinfo=UTC) - datetime(2026, 11, 15, tzinfo=UTC)).total_seconds() / 86400
    model = calculate_gex("BTC", 60000.0, [OptionContract(60000.0, True, 10.0, 0.5, dte)])
    assert model.net_gex is not None
    # The model multiplies by 100 shares; a coin is 1 unit, so the model value is divided by 100.
    assert section.data["netGex"] == pytest.approx(model.net_gex / 100.0, rel=1e-12)
    direct = bs_gamma(60000.0, 60000.0, dte / 365.0, 0.5) * 10.0 * 60000.0**2
    assert section.data["netGex"] == pytest.approx(direct, rel=1e-9)
    assert section.data["callWall"] == 60000.0
    assert section.data["putWall"] is None
    assert section.data["gammaFlip"] is None
    assert section.data["putCallOiRatio"] == 0.0  # Calls only: no put open interest.
    assert section.data["maxPainExpiry"] == "2026-11-27"
    assert section.data["maxPain"] == 60000.0


async def test_deribit_spot_is_the_index_price_of_the_rows() -> None:
    quote_ms = _utc_ms(2026, 11, 15)
    doc = {"result": [_deribit_item("BTC-27NOV26-60000-C", 10.0, 50.0, quote_ms, spot=61234.5)]}
    http = FakeHttp({DERIBIT_URL: doc})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]
    assert section.data is not None
    assert section.data["spot"] == 61234.5


async def test_deribit_lowercase_base_is_treated_as_upper_case() -> None:
    http = FakeHttp({DERIBIT_URL: _load("options_deribit_btc.json")})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("btc")  # type: ignore[arg-type]
    assert section.status == "ok"
    assert section.symbol == "BTC"
    assert http.calls == [(DERIBIT_URL, {"currency": "BTC", "kind": "option"})]


async def test_deribit_other_coins_are_not_applicable_without_a_request() -> None:
    http = FakeHttp({})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("SOL")  # type: ignore[arg-type]
    assert section.status == "not_applicable"
    assert section.reason == "no_options_market"
    assert http.calls == []


async def test_deribit_empty_summary_is_empty() -> None:
    http = FakeHttp({DERIBIT_URL: {"result": []}})
    section = await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("ETH")  # type: ignore[arg-type]
    assert section.status == "empty"
    assert section.reason == "no_listed_options"


async def test_deribit_error_reply_without_a_result_is_raised() -> None:
    http = FakeHttp({DERIBIT_URL: {"jsonrpc": "2.0", "error": {"code": 10000}}})
    with pytest.raises(ValueError):
        await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]


async def test_deribit_reply_without_a_price_raises() -> None:
    item = _deribit_item("BTC-27NOV26-60000-C", 10.0, 50.0, _utc_ms(2026, 11, 15), spot=0.0)
    http = FakeHttp({DERIBIT_URL: {"result": [item]}})
    with pytest.raises(ValueError, match="estimated_delivery_price"):
        await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]


async def test_deribit_http_failure_is_raised_for_the_cache_to_answer() -> None:
    http = FakeHttp({DERIBIT_URL: _status(503)})
    with pytest.raises(aiohttp.ClientResponseError):
        await OptionsSource(http, clock=lambda: NOW_NS).crypto_gex("BTC")  # type: ignore[arg-type]

