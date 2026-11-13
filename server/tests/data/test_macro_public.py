"""Public macro readings: parsers, the stress score and the cached service, with no network.

The parsers run on inline payloads that match the New York Fed and Treasury
formats. The service runs against fake fetchers and an injected monotonic clock,
so no request leaves the process.
"""

from __future__ import annotations

import csv
import io
import math

import pytest

from flowmap_server.data.macro_public import (
    CACHE_TTL_S,
    RETRY_AFTER_FAILURE_S,
    MacroPublicService,
    MacroSourceError,
    MacroUnavailable,
    Observation,
    parse_sofr_json,
    parse_treasury_curve_csv,
)
from flowmap_server.feeds.macro import score_reading

NOW_NS = 1_700_000_000_123_456_789
HEADER = [
    "Date", "1 Mo", "1.5 Month", "2 Mo", "3 Mo", "4 Mo", "6 Mo", "1 Yr",
    "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr",
]


def _sofr(date: str = "2026-11-12", rate: object = 3.90) -> dict[str, object]:
    return {"refRates": [{"effectiveDate": date, "type": "SOFR", "percentRate": rate}]}


def _csv(rows: list[list[str]], header: list[str] = HEADER) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue()


def _curve_row(date: str, two: str = "4.86", ten: str = "5.10") -> list[str]:
    return [date, "4.12", "4.18", "4.26", "4.32", "4.35", "4.42", "4.65",
            two, "4.90", "4.95", "5.02", ten, "5.48", "5.43"]


# --- New York Fed SOFR JSON ----------------------------------------------------


def test_sofr_json_reads_the_rate_and_its_effective_date():
    assert parse_sofr_json(_sofr()) == Observation(3.9, "2026-11-12")


def test_sofr_json_accepts_an_integer_rate():
    assert parse_sofr_json(_sofr(rate=4)) == Observation(4.0, "2026-11-12")


@pytest.mark.parametrize(
    "payload",
    [
        "not an object",
        [],
        {},
        {"refRates": "nope"},
        {"refRates": ["not an object"]},
        {"refRates": [{"effectiveDate": "2026-11-12"}]},
        {"refRates": [{"percentRate": 3.9}]},
        {"refRates": [{"effectiveDate": "12/11/2026", "percentRate": 3.9}]},
        {"refRates": [{"effectiveDate": 20261112, "percentRate": 3.9}]},
        {"refRates": [{"effectiveDate": "2026-11-12", "percentRate": "3.90"}]},
        {"refRates": [{"effectiveDate": "2026-11-12", "percentRate": True}]},
        {"refRates": [{"effectiveDate": "2026-11-12", "percentRate": math.nan}]},
        {"refRates": [{"effectiveDate": "2026-11-12", "percentRate": math.inf}]},
    ],
)
def test_sofr_json_wrong_shapes_and_types_are_malformed(payload):
    with pytest.raises(MacroSourceError) as caught:
        parse_sofr_json(payload)
    assert caught.value.reason == "malformed"


def test_sofr_json_empty_list_has_no_observation():
    with pytest.raises(MacroSourceError) as caught:
        parse_sofr_json({"refRates": []})
    assert caught.value.reason == "no_observation"


# --- Treasury par yield curve CSV ----------------------------------------------


def test_curve_csv_spread_is_ten_year_minus_two_year_of_the_newest_row():
    text = _csv([_curve_row("11/12/2026"), _curve_row("11/11/2026", two="4.90", ten="5.00")])
    assert parse_treasury_curve_csv(text) == Observation(0.24, "2026-11-12")


def test_curve_csv_reads_columns_by_header_name_when_the_order_changes():
    header = ["Date", "10 Yr", "2 Yr", "30 Yr"]
    text = _csv([["11/12/2026", "5.10", "4.86", "5.43"]], header=header)
    assert parse_treasury_curve_csv(text) == Observation(0.24, "2026-11-12")


def test_curve_csv_skips_a_row_with_an_empty_two_year_cell():
    text = _csv([_curve_row("11/12/2026", two=""), _curve_row("11/11/2026", two="4.90", ten="5.00")])
    assert parse_treasury_curve_csv(text) == Observation(0.10, "2026-11-11")


def test_curve_csv_skips_a_row_with_an_empty_ten_year_cell():
    text = _csv([_curve_row("11/12/2026", ten=""), _curve_row("11/11/2026", two="4.90", ten="5.00")])
    assert parse_treasury_curve_csv(text) == Observation(0.10, "2026-11-11")


def test_curve_csv_skips_na_cells():
    text = _csv([_curve_row("11/12/2026", two="N/A"), _curve_row("11/11/2026", two="4.90", ten="5.00")])
    assert parse_treasury_curve_csv(text) == Observation(0.10, "2026-11-11")


def test_curve_csv_skips_a_short_row():
    text = _csv([["11/12/2026", "4.12"], _curve_row("11/11/2026", two="4.90", ten="5.00")])
    assert parse_treasury_curve_csv(text) == Observation(0.10, "2026-11-11")


def test_curve_csv_empty_file_has_no_observation():
    with pytest.raises(MacroSourceError) as caught:
        parse_treasury_curve_csv("")
    assert caught.value.reason == "no_observation"


def test_curve_csv_header_only_has_no_observation():
    with pytest.raises(MacroSourceError) as caught:
        parse_treasury_curve_csv(_csv([]))
    assert caught.value.reason == "no_observation"


def test_curve_csv_rows_without_both_tenors_have_no_observation():
    text = _csv([_curve_row("11/12/2026", two=""), _curve_row("11/11/2026", ten="N/A")])
    with pytest.raises(MacroSourceError) as caught:
        parse_treasury_curve_csv(text)
    assert caught.value.reason == "no_observation"


def test_curve_csv_missing_tenor_column_is_malformed():
    header = ["Date", "2 Yr", "30 Yr"]
    with pytest.raises(MacroSourceError) as caught:
        parse_treasury_curve_csv(_csv([["11/12/2026", "4.86", "5.43"]], header=header))
    assert caught.value.reason == "malformed"


def test_curve_csv_converts_the_date_to_iso():
    text = _csv([_curve_row("01/05/2026")])
    assert parse_treasury_curve_csv(text).date == "2026-01-05"


# --- Stress score -------------------------------------------------------------


def test_score_is_normal_when_spread_is_tight_and_curve_is_positive():
    score, status = score_reading(hy_spread=3.0, yield_curve=0.5)
    assert (score, status) == (0.0, "NORMAL_LIQUIDITY")


def test_score_is_severe_when_spread_is_wide_and_curve_inverted():
    score, status = score_reading(hy_spread=6.0, yield_curve=-0.5)
    assert (score, status) == (1.0, "SEVERE_STRESS")


def test_score_is_elevated_between_the_thresholds():
    score, status = score_reading(hy_spread=4.5, yield_curve=0.0)
    assert (score, status) == (0.3, "NORMAL_LIQUIDITY")
    score, status = score_reading(hy_spread=5.0, yield_curve=0.0)
    assert status == "ELEVATED"


# --- Service ------------------------------------------------------------------


class _Calls:
    def __init__(self) -> None:
        self.count = {"sofr": 0, "curve": 0, "hy": 0}


def _service(
    *,
    sofr=None,
    curve=None,
    hy=None,
    now: list[float] | None = None,
    calls: _Calls | None = None,
) -> MacroPublicService:
    calls = calls or _Calls()
    now = now if now is not None else [0.0]

    def wrap(name, fn):
        async def call():
            calls.count[name] += 1
            return await fn()
        return call

    async def ok_sofr():
        return Observation(3.9, "2026-11-12")

    async def ok_curve():
        return Observation(-0.25, "2026-11-12")

    async def ok_hy():
        return Observation(6.0, "2026-11-11")

    return MacroPublicService(
        fetch_sofr=wrap("sofr", sofr or ok_sofr),
        fetch_curve=wrap("curve", curve or ok_curve),
        fetch_hy=wrap("hy", hy or ok_hy),
        clock=lambda: NOW_NS,
        monotonic=lambda: now[0],
    )


async def test_full_reading_carries_values_dates_score_and_sources():
    reading = await _service().get()
    assert reading.sofr == 3.9
    assert reading.sofr_date == "2026-11-12"
    assert reading.yield_10y2y == -0.25
    assert reading.curve_date == "2026-11-12"
    assert reading.hy_spread == 6.0
    assert reading.hy_date == "2026-11-11"
    assert reading.stress_score == pytest.approx(0.8)
    assert reading.status == "SEVERE_STRESS"
    assert reading.source_status == {"SOFR": "ok", "BAMLH0A0HYM2": "ok", "T10Y2Y": "ok"}
    assert reading.sources == {
        "SOFR": "New York Fed", "T10Y2Y": "US Treasury", "BAMLH0A0HYM2": "FRED",
    }
    assert reading.as_of_ns == NOW_NS
    assert reading.stale is False


async def test_missing_hy_spread_leaves_the_regime_empty_and_keeps_the_other_values():
    async def no_key():
        raise MacroSourceError("fred_api_key_missing")

    reading = await _service(hy=no_key).get()
    assert reading.sofr == 3.9
    assert reading.yield_10y2y == -0.25
    assert reading.hy_spread is None
    assert reading.hy_date is None
    assert reading.stress_score is None
    assert reading.status is None
    assert reading.source_status["BAMLH0A0HYM2"] == "fred_api_key_missing"
    assert reading.source_status["SOFR"] == "ok"


async def test_one_failing_series_does_not_fail_the_others():
    async def sofr_down():
        raise MacroSourceError("http_500")

    reading = await _service(sofr=sofr_down).get()
    assert reading.sofr is None
    assert reading.sofr_date is None
    assert reading.source_status["SOFR"] == "http_500"
    assert reading.yield_10y2y == -0.25
    assert reading.hy_spread == 6.0
    assert reading.status == "SEVERE_STRESS"


async def test_an_unexpected_error_is_reported_as_unreachable_without_its_text():
    async def boom():
        raise RuntimeError("https://markets.example.test/x?key=secret")

    reading = await _service(sofr=boom).get()
    assert reading.source_status["SOFR"] == "unreachable"
    assert "secret" not in repr(reading)


async def test_reading_is_served_from_cache_within_the_ttl():
    calls = _Calls()
    now = [0.0]
    service = _service(calls=calls, now=now)
    await service.get()
    now[0] = CACHE_TTL_S - 1
    await service.get()
    assert calls.count == {"sofr": 1, "curve": 1, "hy": 1}


async def test_reading_is_refetched_after_the_ttl():
    calls = _Calls()
    now = [0.0]
    service = _service(calls=calls, now=now)
    await service.get()
    now[0] = CACHE_TTL_S
    await service.get()
    assert calls.count == {"sofr": 2, "curve": 2, "hy": 2}


async def test_all_series_missing_without_a_previous_reading_is_unavailable_with_reasons():
    async def down(reason):
        raise MacroSourceError(reason)

    async def sofr():
        return await down("unreachable")

    async def curve():
        return await down("malformed")

    async def hy():
        return await down("fred_api_key_missing")

    with pytest.raises(MacroUnavailable) as caught:
        await _service(sofr=sofr, curve=curve, hy=hy).get()
    message = str(caught.value)
    assert "unreachable" in message
    assert "malformed" in message
    assert "fred_api_key_missing" in message
    assert "://" not in message


async def test_failed_refresh_serves_the_previous_reading_as_stale():
    now = [0.0]
    failing = [False]

    async def sofr():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(3.9, "2026-11-12")

    async def curve():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(-0.25, "2026-11-12")

    async def hy():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(6.0, "2026-11-11")

    service = _service(sofr=sofr, curve=curve, hy=hy, now=now)
    first = await service.get()
    failing[0] = True
    now[0] = CACHE_TTL_S
    stale = await service.get()
    assert stale.stale is True
    assert stale.sofr == first.sofr
    assert stale.status == first.status
    assert stale.as_of_ns == first.as_of_ns


async def test_failed_refresh_is_not_retried_inside_the_retry_floor():
    calls = _Calls()
    now = [0.0]
    failing = [False]

    async def sofr():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(3.9, "2026-11-12")

    async def curve():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(-0.25, "2026-11-12")

    async def hy():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(6.0, "2026-11-11")

    service = _service(sofr=sofr, curve=curve, hy=hy, now=now, calls=calls)
    await service.get()
    failing[0] = True
    now[0] = CACHE_TTL_S
    await service.get()
    attempts = calls.count["sofr"]
    now[0] = CACHE_TTL_S + RETRY_AFTER_FAILURE_S - 1
    stale = await service.get()
    assert stale.stale is True
    assert calls.count["sofr"] == attempts
    now[0] = CACHE_TTL_S + RETRY_AFTER_FAILURE_S
    await service.get()
    assert calls.count["sofr"] == attempts + 1


async def test_failed_refresh_with_nothing_held_is_unavailable_inside_the_retry_floor():
    now = [0.0]
    calls = _Calls()

    async def down():
        raise MacroSourceError("http_503")

    async def hy_down():
        raise MacroSourceError("fred_api_key_missing")

    service = _service(sofr=down, curve=down, hy=hy_down, now=now, calls=calls)
    with pytest.raises(MacroUnavailable):
        await service.get()
    with pytest.raises(MacroUnavailable):
        await service.get()
    assert calls.count["sofr"] == 1


async def test_default_hy_fetch_without_a_key_reports_the_missing_key_and_makes_no_request(
    monkeypatch,
):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    service = MacroPublicService(
        fetch_sofr=lambda: _ready(Observation(3.9, "2026-11-12")),
        fetch_curve=lambda: _ready(Observation(-0.25, "2026-11-12")),
    )
    reading = await service.get()
    assert reading.source_status["BAMLH0A0HYM2"] == "fred_api_key_missing"
    assert reading.hy_spread is None
    await service.close()


async def _ready(value):
    return value


def test_poller_built_without_a_warehouse_does_not_open_one_until_it_persists(monkeypatch):
    from flowmap_server.feeds.macro import MacroStressPoller

    def refuse():
        raise AssertionError("the shared warehouse was opened")

    monkeypatch.setattr("flowmap_server.feeds.macro.shared_warehouse", refuse)
    poller = MacroStressPoller(api_key=None)
    assert poller.api_key is None


class _FakeStream:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self, n: int = -1) -> bytes:
        chunk, self._data = self._data[:n], self._data[n:]
        return chunk


class _FakeResponse:
    def __init__(self, data: bytes, declared: int | None = None) -> None:
        self.content_length = declared
        self.content = _FakeStream(data)


async def test_capped_read_returns_a_body_within_the_limit():
    from flowmap_server.data.macro_public import _read_capped

    assert await _read_capped(_FakeResponse(b"abc"), limit=10) == b"abc"


async def test_capped_read_refuses_a_declared_length_over_the_limit():
    from flowmap_server.data.macro_public import _read_capped

    with pytest.raises(ValueError):
        await _read_capped(_FakeResponse(b"abc", declared=500), limit=10)


async def test_capped_read_stops_an_undeclared_body_over_the_limit():
    from flowmap_server.data.macro_public import _read_capped

    with pytest.raises(ValueError):
        await _read_capped(_FakeResponse(b"x" * 200_000), limit=100_000)


# --- A partial refresh keeps the last good value of the series that failed ----


def _curve_source(state: dict[str, object]):
    async def curve():
        if state["down"]:
            raise MacroSourceError("http_503")
        return state["value"]

    return curve


async def test_a_failed_curve_keeps_the_held_value_and_marks_the_reading_stale():
    now = [0.0]
    state: dict[str, object] = {"down": False, "value": Observation(-0.25, "2026-11-12")}
    service = _service(curve=_curve_source(state), now=now)
    first = await service.get()
    state["down"] = True
    now[0] = CACHE_TTL_S
    merged = await service.get()
    assert merged.stale is True
    assert merged.yield_10y2y == -0.25
    assert merged.curve_date == "2026-11-12"
    assert merged.source_status["T10Y2Y"] == "http_503"
    assert merged.source_status["SOFR"] == "ok"
    assert merged.sofr == first.sofr
    assert merged.hy_spread == 6.0
    assert merged.stress_score == first.stress_score
    assert merged.status == first.status


async def test_a_successful_curve_read_after_a_failure_clears_stale():
    now = [0.0]
    state: dict[str, object] = {"down": False, "value": Observation(-0.25, "2026-11-12")}
    service = _service(curve=_curve_source(state), now=now)
    await service.get()
    state["down"] = True
    now[0] = CACHE_TTL_S
    assert (await service.get()).stale is True
    state["down"] = False
    state["value"] = Observation(-0.5, "2026-11-13")
    now[0] = 2 * CACHE_TTL_S
    reading = await service.get()
    assert reading.stale is False
    assert reading.yield_10y2y == -0.5
    assert reading.curve_date == "2026-11-13"
    assert reading.source_status["T10Y2Y"] == "ok"


async def test_a_series_that_never_succeeded_stays_missing_after_a_partial_refresh():
    now = [0.0]
    state: dict[str, object] = {"down": True, "value": Observation(-0.25, "2026-11-12")}
    service = _service(curve=_curve_source(state), now=now)
    first = await service.get()
    assert first.yield_10y2y is None
    assert first.curve_date is None
    assert first.stress_score is None
    assert first.status is None
    assert first.source_status["T10Y2Y"] == "http_503"
    now[0] = CACHE_TTL_S
    second = await service.get()
    assert second.yield_10y2y is None
    assert second.curve_date is None
    assert second.stale is False
    assert second.source_status["SOFR"] == "ok"


# --- Curve year fallback -----------------------------------------------------


async def test_the_curve_falls_back_to_the_previous_year_when_this_years_file_is_404(monkeypatch):
    from datetime import UTC
    from datetime import datetime as real_datetime

    year = real_datetime.now(UTC).year
    seen: list[str] = []

    async def fake_get_body(self, url, *, headers, limit):
        seen.append(url)
        if f"/{year}/all" in url:
            raise MacroSourceError("http_404")
        return _csv([_curve_row("11/12/2026")]).encode()

    monkeypatch.setattr(MacroPublicService, "_get_body", fake_get_body)
    observation = await MacroPublicService()._fetch_curve()
    assert observation == Observation(0.24, "2026-11-12")
    assert len(seen) == 2
