"""Source failures must not create market intelligence or invented metrics."""

from datetime import UTC, datetime, timedelta
import json
from unittest.mock import AsyncMock, Mock

import pytest

from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.capitol import CapitolTradesWatcher
from flowmap_server.feeds.contracts import DefenseContractsListener
from flowmap_server.feeds.headcount import HeadcountVelocityTracker
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


@pytest.mark.parametrize("provider_type", [CapitolTradesWatcher, DefenseContractsListener])
@pytest.mark.parametrize("failure", ["empty", "http", "exception", "malformed"])
async def test_empty_or_failed_awards_and_filings_never_persist(monkeypatch, provider_type, failure):
    warehouse = Mock(spec=DuckWarehouse)
    provider = provider_type(warehouse)
    payload = [] if provider_type is CapitolTradesWatcher else {"results": []}
    response = Response(payload)
    if failure == "http":
        response.status = 503
    elif failure == "exception":
        response.error = OSError("offline")
    elif failure == "malformed":
        response.payload = {"results": "invalid"}
    use_response(monkeypatch, provider, response)
    result = await (provider.fetch_recent_trades() if isinstance(provider, CapitolTradesWatcher)
                    else provider.fetch_recent_contracts())
    assert result == []
    warehouse.insert_intelligence.assert_not_called()


@pytest.mark.parametrize("date_format", ["%Y-%m-%d", "%m/%d/%Y"])
async def test_capitol_filters_real_filings_and_preserves_ranges(monkeypatch, date_format):
    warehouse = Mock(spec=DuckWarehouse)
    provider = CapitolTradesWatcher(warehouse)
    today = datetime.now(UTC).date()
    recent = {"ticker": "NVDA", "representative": "Source Representative", "type": "purchase",
              "transaction_date": today.strftime(date_format), "amount": "$15,001 - $50,000",
              "disclosure_date": today.isoformat()}
    records = [recent, {**recent, "ticker": "MSFT"},
               {**recent, "transaction_date": (today - timedelta(days=60)).isoformat()},
               {**recent, "transaction_date": (today + timedelta(days=1)).isoformat()},
               {**recent, "transaction_date": "unknown"}, None]
    use_response(monkeypatch, provider, Response(records))
    result = await provider.fetch_recent_trades(lookback_days=30, symbols={"nvda"})
    assert len(result) == 1
    assert result[0]["symbol"] == "NVDA"
    assert result[0]["amount_usd"] is None
    detail = json.loads(result[0]["detail"])
    assert detail["amount_range"] == recent["amount"]
    assert detail["transaction_date"] == recent["transaction_date"]
    assert detail["date"] == today.isoformat()
    assert detail["politician"] == recent["representative"]
    assert result[0]["headline"] == ""
    warehouse.insert_intelligence.assert_called_once()
    assert warehouse.insert_intelligence.call_args.args[4] is None


async def test_capitol_empty_symbol_filter_and_missing_amount_do_not_invent(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = CapitolTradesWatcher(warehouse)
    record = {"ticker": "LMT", "transaction_date": datetime.now(UTC).date().isoformat()}
    use_response(monkeypatch, provider, Response([record]))
    assert await provider.fetch_recent_trades(symbols=set()) == []
    warehouse.insert_intelligence.assert_not_called()
    result = await provider.fetch_recent_trades(symbols={"LMT"})
    assert result[0]["amount_usd"] is None
    assert json.loads(result[0]["detail"])["amount_range"] is None
    assert json.loads(result[0]["detail"])["type"] is None


async def test_contracts_keep_source_fields_and_a_real_zero_award(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    record = {"Recipient Name": "Lockheed Martin Corporation", "Award Amount": 0,
              "Awarding Agency": "NASA", "Description": "Source description",
              "Action Date": "2026-10-10", "Award ID": "SOURCE-AWARD-ID"}
    session = use_response(monkeypatch, provider, Response({"results": [record, {
        "Recipient Name": "Unmapped Recipient", "Award Amount": 500,
    }]}))
    result = await provider.fetch_recent_contracts(lookback_days=3, limit=8)
    assert len(result) == 1
    assert result[0]["amount_usd"] == 0
    detail = json.loads(result[0]["detail"])
    assert detail == {"recipient": record["Recipient Name"], "award_id": record["Award ID"],
                      "agency": "NASA", "description": "Source description", "date": "2026-10-10"}
    assert result[0]["headline"] == ""
    assert session.calls[0][2]["json"]["limit"] == 8
    warehouse.insert_intelligence.assert_called_once()
    assert warehouse.insert_intelligence.call_args.args[4] == 0


@pytest.mark.parametrize("amount", [None, "invalid", "NaN", "Infinity", float("nan"), True])
async def test_contract_missing_or_invalid_fields_remain_unknown(monkeypatch, amount):
    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    use_response(monkeypatch, provider, Response({"results": [{
        "Recipient Name": "Palantir", "Award Amount": amount,
    }]}))
    result = await provider.fetch_recent_contracts()
    assert len(result) == 1
    assert result[0]["amount_usd"] is None
    detail = json.loads(result[0]["detail"])
    assert detail["agency"] is None
    assert detail["description"] is None
    assert detail["date"] is None
    assert result[0]["headline"] == ""
    assert warehouse.insert_intelligence.call_args.args[4] is None


@pytest.mark.parametrize("response", [Response(status=404), Response(error=OSError("offline")),
                                      Response({}), Response({"jobs": "invalid"})])
async def test_unavailable_job_board_has_unknown_counts(monkeypatch, response):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, response)
    result = await provider.fetch_company_headcount("PLTR")
    assert result["available"] is False
    assert result["total_openings"] is None
    assert result["rd_engineering_openings"] is None
    assert result["sales_openings"] is None
    assert result["ga_openings"] is None
    assert result["talent_index_delta_pct"] is None
    assert result["signal"] == "UNAVAILABLE"


async def test_valid_empty_job_board_is_zero_without_invented_velocity(monkeypatch):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, Response({"jobs": []}))
    result = await provider.fetch_company_headcount("PLTR")
    assert result["available"] is True
    assert result["total_openings"] == 0
    assert result["rd_engineering_openings"] == 0
    assert result["talent_index_delta_pct"] is None
    assert result["signal"] == "CURRENT_OPENINGS"


async def test_job_counts_are_an_explicit_current_department_heuristic(monkeypatch):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, Response({"jobs": [
        {"title": "Software Engineer"}, {"title": "Account Executive", "departments": [{"name": "Sales"}]},
        {"title": "Payroll Specialist"},
    ]}))
    result = await provider.fetch_company_headcount("PLTR")
    assert result["total_openings"] == 3
    assert result["rd_engineering_openings"] == 1
    assert result["sales_openings"] == 1
    assert result["ga_openings"] == 1
    assert result["department_classification"] == "title_and_department_keyword_heuristic"
    assert result["talent_index_delta_pct"] is None


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


async def test_capitol_event_is_stamped_with_transaction_date_and_stored_once(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = CapitolTradesWatcher(warehouse)
    today = datetime.now(UTC).date()
    record = {"ticker": "NVDA", "representative": "Source Representative", "type": "purchase",
              "transaction_date": today.isoformat(), "amount": "$1,001 - $15,000"}
    use_response(monkeypatch, provider, Response([record]))
    first = await provider.fetch_recent_trades(lookback_days=30)
    second = await provider.fetch_recent_trades(lookback_days=30)  # the same window, polled again
    midnight = int(datetime(today.year, today.month, today.day, tzinfo=UTC).timestamp()) * 10**9
    assert first[0]["ts_ns"] == midnight and second[0]["ts_ns"] == midnight
    assert json.loads(first[0]["detail"])["ingested_ns"] > midnight
    assert warehouse.insert_intelligence.call_count == 1
    assert warehouse.insert_intelligence.call_args.args[0] == midnight
    assert provider.last_status["source_ok"] is True
    assert provider.last_status["latest_transaction_date"] == today.isoformat()


async def test_capitol_unchanged_dataset_is_revalidated_not_redownloaded(monkeypatch):
    today = datetime.now(UTC).date()
    record = {"ticker": "NVDA", "representative": "Source Representative", "type": "purchase",
              "transaction_date": today.isoformat(), "amount": "$1,001 - $15,000"}
    provider = CapitolTradesWatcher(Mock(spec=DuckWarehouse))
    session = use_response(monkeypatch, provider, Response([record], headers={"ETag": '"v1"'}))
    first = await provider.fetch_recent_trades()
    session.response = Response(status=304)
    second = await provider.fetch_recent_trades()
    assert session.calls[-1][2]["headers"] == {"If-None-Match": '"v1"'}
    assert [row["symbol"] for row in first] == ["NVDA"] and [row["symbol"] for row in second] == ["NVDA"]
    assert provider.last_status["source_ok"] is True


async def test_capitol_oversized_download_is_refused_while_streaming(monkeypatch):
    from flowmap_server.feeds import capitol

    monkeypatch.setattr(capitol, "_MAX_RESPONSE_BYTES", 64)
    provider = CapitolTradesWatcher(Mock(spec=DuckWarehouse))
    rows = [{"ticker": "NVDA", "representative": "X", "type": "purchase",
             "transaction_date": "2026-01-01", "amount": "$1"} for _ in range(20)]
    use_response(monkeypatch, provider, Response(rows))  # no Content-Length: the stream is capped
    assert await provider.fetch_recent_trades() == []
    assert provider.last_status["error"] == "response_too_large"


async def test_capitol_outage_is_reported_in_status_not_as_an_empty_window(monkeypatch):
    provider = CapitolTradesWatcher(Mock(spec=DuckWarehouse))
    use_response(monkeypatch, provider, Response(status=503))
    assert await provider.fetch_recent_trades() == []
    assert provider.last_status["source_ok"] is False
    assert provider.last_status["error"] == "http_503"


async def test_darkpool_steps_back_over_unpublished_days_and_reports_the_date_read(monkeypatch):
    from flowmap_server.feeds.darkpool import DarkPoolCollector

    warehouse = Mock(spec=DuckWarehouse)
    collector = DarkPoolCollector(warehouse)
    requested = []

    class ByDate:
        def get(self, url, **kwargs):
            requested.append(url)
            if url.endswith("20260710.txt"):  # the Friday is published; Monday's file is not yet
                return TextResponse("Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume\n"
                                    "20260710|ABC|60|0|100\n")
            return Response(status=404)

    monkeypatch.setattr(collector, "_get_session", AsyncMock(return_value=ByDate()))
    from datetime import date as _date

    rows = await collector.fetch_regsho_daily(target_date=_date(2026, 7, 13))  # a Monday
    assert len(requested) == 2
    assert rows and rows[0]["high_short_share"] is True
    assert "is_institutional_divergence" not in rows[0]
    assert collector.last_status["date_used"] == "2026-07-10"
    assert collector.last_status["requested_date"] == "2026-07-13"


async def test_darkpool_outage_is_not_an_empty_day(monkeypatch):
    from datetime import date as _date

    from flowmap_server.feeds.darkpool import DarkPoolCollector

    collector = DarkPoolCollector(Mock(spec=DuckWarehouse))
    monkeypatch.setattr(collector, "_get_session", AsyncMock(return_value=Session(Response(status=500))))
    assert await collector.fetch_regsho_daily(target_date=_date(2026, 7, 10)) == []
    assert collector.last_status["source_ok"] is False and collector.last_status["error"] == "http_500"


async def test_headcount_never_guesses_a_board_for_an_unmapped_ticker(monkeypatch):
    provider = HeadcountVelocityTracker()
    session = AsyncMock(side_effect=AssertionError("unmapped ticker must not query a board"))
    monkeypatch.setattr(provider, "_get_session", session)
    result = await provider.fetch_company_headcount("ACME")
    assert result["available"] is False and result["reason"] == "no_board_mapped"
    session.assert_not_called()


async def test_headcount_accounting_roles_are_not_sales(monkeypatch):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, Response({"jobs": [
        {"title": "Accountant"}, {"title": "Accounts Payable Clerk"}, {"title": "Accounting Manager"},
    ]}))
    result = await provider.fetch_company_headcount("PLTR")
    assert result["sales_openings"] == 0 and result["ga_openings"] == 3


async def test_contracts_query_is_filtered_to_mapped_recipients_at_the_source(monkeypatch):
    from flowmap_server.feeds.contracts import RECIPIENT_TICKER_MAP

    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    session = use_response(monkeypatch, provider, Response({"results": []}))
    assert await provider.fetch_recent_contracts() == []
    filters = session.calls[0][2]["json"]["filters"]
    assert set(filters["recipient_search_text"]) == set(RECIPIENT_TICKER_MAP)
    assert provider.last_status["source_ok"] is True


async def test_contract_is_stamped_with_its_action_date(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    use_response(monkeypatch, provider, Response({"results": [{
        "Recipient Name": "Lockheed Martin Corporation", "Award Amount": 10.0,
        "Action Date": "2026-07-01", "Award ID": "A1",
    }]}))
    result = await provider.fetch_recent_contracts()
    expected = int(datetime(2026, 7, 1, tzinfo=UTC).timestamp()) * 10**9
    assert result[0]["ts_ns"] == expected
    assert warehouse.insert_intelligence.call_args.args[0] == expected


class TextResponse(Response):
    def __init__(self, text):
        super().__init__(status=200)
        self._text = text

    async def text(self, **_):
        return self._text


async def test_darkpool_user_agent_carries_the_package_version():
    from flowmap_server import __version__
    from flowmap_server.feeds.darkpool import DarkPoolCollector

    collector = DarkPoolCollector(Mock(spec=DuckWarehouse))
    try:
        session = await collector._get_session()
        assert session.headers["User-Agent"] == f"FlowMap/{__version__} (research)"
    finally:
        await collector.close()
