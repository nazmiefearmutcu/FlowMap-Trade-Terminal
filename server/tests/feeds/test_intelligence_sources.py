"""Source failures must not create market intelligence or invented metrics."""

import json
from unittest.mock import AsyncMock, Mock

import pytest

from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.macro import MacroStressPoller


class Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def iter_chunked(self, size):
        for start in range(0, len(self._data), size):
            yield self._data[start:start + size]


class Response:
    def __init__(self, payload=None, *, status=200, error=None, headers=None):
        self.payload = payload
        self.status = status
        self.error = error
        self.headers = headers or {}

    @property
    def content(self):
        return Body(json.dumps(self.payload).encode())

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self, **_):
        return self.payload


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response


def use_response(monkeypatch, provider, response):
    session = Session(response)
    monkeypatch.setattr(provider, "_get_session", AsyncMock(return_value=session))
    return session


@pytest.mark.parametrize("key", [None, "", "   "])
async def test_macro_missing_api_key_never_queries_demo_or_persists(monkeypatch, key):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key=key, warehouse=warehouse)
    get_session = AsyncMock(side_effect=AssertionError("missing key must not query FRED"))
    monkeypatch.setattr(provider, "_get_session", get_session)
    result = await provider.compute_current_stress()
    assert result["status"] == "UNAVAILABLE"
    assert result["missing_series"] == ["SOFR", "BAMLH0A0HYM2", "T10Y2Y"]
    assert result["stress_score"] is None
    get_session.assert_not_called()
    warehouse.insert_macro_stress.assert_not_called()


@pytest.mark.parametrize("missing", [None, float("nan"), float("inf"), OSError("offline")])
async def test_macro_requires_all_finite_series_before_persisting(monkeypatch, missing):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    monkeypatch.setattr(provider, "fetch_series_observation", AsyncMock(side_effect=[0.0, missing, 0.0]))
    result = await provider.compute_current_stress()
    assert result["available"] is False
    assert result["missing_series"] == ["BAMLH0A0HYM2"]
    assert result["stress_score"] is None
    assert result["inversion_alert"] is None
    warehouse.insert_macro_stress.assert_not_called()


@pytest.mark.parametrize("response", [Response({"observations": []}), Response(status=503),
                                      Response(error=OSError("offline")),
                                      Response({"observations": [{"value": "NaN"}]})])
async def test_macro_empty_failed_or_nonfinite_http_observation_is_missing(monkeypatch, response):
    provider = MacroStressPoller(api_key="test-key", warehouse=Mock(spec=DuckWarehouse))
    use_response(monkeypatch, provider, response)
    assert await provider.fetch_series_observation("SOFR") is None


@pytest.mark.parametrize("value", [0, "0.0"])
async def test_macro_real_zero_observations_compute_and_persist(monkeypatch, value):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    session = use_response(monkeypatch, provider, Response({"observations": [
        {"date": "2000-01-03", "value": value}]}))
    result = await provider.compute_current_stress()
    assert result["available"] is True
    assert result["missing_series"] == []
    assert result["sofr"] == 0
    assert result["hy_spread_pct"] == 0
    assert result["yield_curve_10y2y"] == 0
    assert result["stress_score"] == 0
    assert result["inversion_alert"] is False
    assert len(session.calls) == 3
    assert {call[2]["params"]["series_id"] for call in session.calls} == {"SOFR", "BAMLH0A0HYM2", "T10Y2Y"}
    assert all(call[2]["params"]["api_key"] == "test-key" for call in session.calls)
    warehouse.insert_macro_stress.assert_called_once()
    assert warehouse.insert_macro_stress.call_args.args[1:5] == (0.0, 0.0, 0.0, 0.0)


class DatedResponses:
    """Serves a different observation per FRED series id, with its own date."""

    def __init__(self, by_series):
        self.by_series = by_series
        self.calls = []

    def get(self, url, **kwargs):
        series = kwargs["params"]["series_id"]
        self.calls.append(series)
        return Response(self.by_series[series])


async def test_macro_reading_keeps_observation_dates_and_the_oldest_as_of(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    recent = "2000-01-10"
    monkeypatch.setattr(provider, "_get_session", AsyncMock(return_value=DatedResponses({
        "SOFR": {"observations": [{"date": recent, "value": "5.3"}]},
        "BAMLH0A0HYM2": {"observations": [{"date": "2000-01-05", "value": "4.1"}]},
        "T10Y2Y": {"observations": [{"date": recent, "value": "0.2"}]},
    })))
    result = await provider.compute_current_stress()
    assert result["as_of"] == "2000-01-05"
    assert result["series_dates"]["T10Y2Y"] == recent
    assert result["source_status"] == {"SOFR": "ok", "BAMLH0A0HYM2": "ok", "T10Y2Y": "ok"}
    assert result["stale"] is True  # January 2000 is far outside the freshness window
    assert result["method"]["model"].startswith("uncalibrated heuristic")
    assert warehouse.insert_macro_stress.call_args.args[0] == "2000-01-05"


async def test_macro_failure_names_its_reason_and_persists_nothing(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    monkeypatch.setattr(provider, "_get_session", AsyncMock(return_value=DatedResponses({
        "SOFR": {"observations": []},
        "BAMLH0A0HYM2": {"observations": [{"date": "2000-01-05", "value": "4.1"}]},
        "T10Y2Y": {"observations": [{"date": "2000-01-05", "value": "0.2"}]},
    })))
    result = await provider.compute_current_stress()
    assert result["available"] is False
    assert result["missing_series"] == ["SOFR"]
    assert result["unavailable_reason"] == "fred_no_observation"
    assert result["source_status"] == {"SOFR": "fred_no_observation", "BAMLH0A0HYM2": "ok",
                                       "T10Y2Y": "ok"}
    warehouse.insert_macro_stress.assert_not_called()


@pytest.mark.parametrize(("status", "reason"), [(403, "fred_rejected"), (429, "fred_rate_limited")])
async def test_macro_rejected_or_limited_key_is_not_reported_as_missing(monkeypatch, status, reason):
    provider = MacroStressPoller(api_key="test-key", warehouse=Mock(spec=DuckWarehouse))
    use_response(monkeypatch, provider, Response(status=status))
    result = await provider.compute_current_stress()
    assert result["unavailable_reason"] == reason


async def test_macro_without_a_key_reports_the_missing_key(monkeypatch):
    provider = MacroStressPoller(api_key=None, warehouse=Mock(spec=DuckWarehouse))
    result = await provider.compute_current_stress()
    assert result["unavailable_reason"] == "fred_api_key_missing"


class TextResponse(Response):
    def __init__(self, text):
        super().__init__(status=200)
        self._text = text

    async def text(self, **_):
        return self._text

