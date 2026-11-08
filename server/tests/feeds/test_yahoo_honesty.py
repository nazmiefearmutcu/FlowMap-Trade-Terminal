"""Yahoo history must tell an unknown ticker, an outage and an empty chart apart."""

import asyncio
import json
import logging
from types import SimpleNamespace

import pytest

from flowmap_server.feeds import _yahoo as yahoo


def _error_chart(code: str) -> dict:
    return {"chart": {"result": None, "error": {"code": code, "description": "No data found"}}}


def _empty_chart() -> dict:
    return {"chart": {"error": None, "result": []}}


def _client(monkeypatch, bodies: dict[str, object], *, fail_hosts=()):
    """Serve a JSON body per host; hosts in *fail_hosts* raise a network error."""
    entered: list[str] = []

    class Content:
        def __init__(self, data: bytes) -> None:
            self._data = data

        async def iter_chunked(self, size):
            yield self._data

    class Response:
        def __init__(self, host: str) -> None:
            self.content = Content(json.dumps(bodies[host]).encode())
            self._host = host

        def raise_for_status(self) -> None:
            return None

        async def __aenter__(self):
            if self._host in fail_hosts:
                raise yahoo.aiohttp.ClientError("host unavailable")
            return self

        async def __aexit__(self, *exc):
            return None

    class Client:
        def __init__(self, **kwargs) -> None:
            pass

        def get(self, url, **kwargs):
            host = url.split("/")[2]
            entered.append(host)
            return Response(host)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    monkeypatch.setattr(yahoo.aiohttp, "ClientSession", Client)
    monkeypatch.setattr(yahoo.aiohttp, "TCPConnector", lambda **kw: SimpleNamespace())
    return entered


HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


def test_unknown_ticker_is_not_an_outage_and_is_not_retried_on_the_second_host(monkeypatch):
    entered = _client(monkeypatch, {host: _error_chart("Not Found") for host in HOSTS})
    with pytest.raises(yahoo.UnknownSymbolError):
        asyncio.run(yahoo._request_bars("NOPE"))
    assert entered == [HOSTS[0]]


def test_provider_error_other_than_not_found_is_an_outage(monkeypatch):
    entered = _client(monkeypatch, {host: _error_chart("Internal") for host in HOSTS})
    with pytest.raises(yahoo.YahooUnavailableError):
        asyncio.run(yahoo._request_bars("AAPL"))
    assert entered == list(HOSTS)


def test_both_hosts_with_no_bars_is_reported_as_no_data(monkeypatch):
    _client(monkeypatch, {host: _empty_chart() for host in HOSTS})
    with pytest.raises(yahoo.YahooNoDataError):
        asyncio.run(yahoo._request_bars("AAPL"))


def test_outage_on_one_host_and_no_data_on_the_other_stays_an_outage(monkeypatch):
    _client(monkeypatch, {HOSTS[0]: _empty_chart(), HOSTS[1]: _empty_chart()}, fail_hosts=(HOSTS[1],))
    with pytest.raises(yahoo.aiohttp.ClientError):
        asyncio.run(yahoo._request_bars("AAPL"))


async def test_equity_bars_logs_no_data_and_returns_empty_without_raising(monkeypatch, caplog):
    async def request(symbol):
        raise yahoo.YahooNoDataError("no bars")

    monkeypatch.setattr(yahoo, "_request_bars", request)
    with caplog.at_level(logging.INFO, logger=yahoo.__name__):
        assert await yahoo.equity_bars("EMPTY") == ()
    assert any("no minute bars for EMPTY" in rec.getMessage() for rec in caplog.records)


async def test_history_budget_covers_both_hosts_and_names_the_timeout(monkeypatch):
    assert yahoo._BAR_DEADLINE_S >= 2 * 3.0 + 1.0, "two 3 s host timeouts plus admission"

    async def hang(symbol):
        await asyncio.Event().wait()

    monkeypatch.setattr(yahoo, "_BAR_DEADLINE_S", 0.02)
    monkeypatch.setattr(yahoo, "_request_bars", hang)
    with pytest.raises(TimeoutError, match="'SLOW' exceeded 0.02s"):
        await yahoo.equity_bars("SLOW")


def test_parse_flags_unknown_ticker_separately_from_unavailable():
    with pytest.raises(yahoo.UnknownSymbolError):
        yahoo._parse_bars(_error_chart("Not Found"), "NOPE", now_ns=10**18)
    with pytest.raises(yahoo.YahooUnavailableError):
        yahoo._parse_bars({"chart": None}, "AAPL", now_ns=10**18)
