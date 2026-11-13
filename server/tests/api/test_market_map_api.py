"""GET /api/market-map: camelCase JSON, market validation and the unavailable reply.

The service is pre-seeded on ``app.state.market_map`` with fake fetchers that
return the trimmed real payloads, so no request leaves the process.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import aiohttp
import httpx

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.data.market_map import MarketMapService

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "market_map"
NASDAQ = json.loads((FIXTURES / "nasdaq_screener.json").read_text(encoding="utf-8"))
COINGECKO = json.loads((FIXTURES / "coingecko_markets.json").read_text(encoding="utf-8"))
NOW_NS = 1_700_000_000_123_456_789


async def _ok_us() -> object:
    return NASDAQ


async def _ok_crypto() -> object:
    return COINGECKO


async def _ok_pairs() -> object:
    return [{"symbol": "BTCUSDT", "price": "68000.00"}]


async def _down() -> object:
    raise RuntimeError("https://api.example.test/feed?token=secret down")


def _client(us=_ok_us, crypto=_ok_crypto) -> httpx.AsyncClient:
    app = create_app(Config())
    app.state.market_map = MarketMapService(
        fetch_us=us, fetch_crypto=crypto, fetch_pairs=_ok_pairs, clock=lambda: NOW_NS
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720")


async def test_us_answer_has_camel_case_keys_and_millisecond_as_of():
    async with _client() as c:
        r = await c.get("/api/market-map", params={"market": "us"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"market", "asOf", "source", "stale", "items"}
    assert body["market"] == "us"
    assert body["source"] == "Nasdaq screener"
    assert body["stale"] is False
    assert body["asOf"] == NOW_NS // 1_000_000
    assert isinstance(body["asOf"], int)


async def test_us_items_carry_the_tile_fields():
    async with _client() as c:
        body = (await c.get("/api/market-map", params={"market": "us"})).json()
    first = body["items"][0]
    assert set(first) == {"symbol", "name", "group", "marketCap", "price", "change",
                          "volume", "chart"}
    assert first["symbol"] == "AAPL"
    assert first["change"] == {"1d": -0.135}
    assert first["chart"] == {"market": "equity", "symbol": "AAPL"}


async def test_us_is_the_default_market():
    async with _client() as c:
        body = (await c.get("/api/market-map")).json()
    assert body["market"] == "us"


async def test_crypto_answer_is_served():
    async with _client() as c:
        r = await c.get("/api/market-map", params={"market": "crypto"})
    assert r.status_code == 200
    body = r.json()
    assert body["market"] == "crypto"
    assert body["source"] == "CoinGecko"
    assert body["items"][0]["symbol"] == "BTC"
    assert body["items"][0]["group"] == "Crypto"
    assert set(body["items"][0]["change"]) <= {"1h", "24h", "7d"}


async def test_unknown_market_is_a_422_with_a_stable_code():
    async with _client() as c:
        r = await c.get("/api/market-map", params={"market": "xyz"})
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "unknown_market"
    assert "xyz" in error["message"]


async def test_unavailable_source_is_a_503_with_a_reason_and_no_url():
    async with _client(us=_down) as c:
        r = await c.get("/api/market-map", params={"market": "us"})
    assert r.status_code == 503
    error = r.json()["error"]
    assert error["code"] == "market_map_unavailable"
    assert "Nasdaq screener" in error["message"]
    assert "://" not in error["message"]
    assert "?" not in error["message"]
    assert "secret" not in r.text


class _UpstreamError(aiohttp.ClientResponseError):
    """Stands in for an aiohttp HTTP error, whose text carries the full URL."""

    def __str__(self) -> str:
        return "503, message='Service Unavailable', url='https://feed.test/list?key=abc123'"


async def _http_error() -> object:
    raise _UpstreamError(None, (), status=503, message="Service Unavailable")


async def test_http_error_reply_carries_no_url_or_query():
    async with _client(crypto=_http_error) as c:
        r = await c.get("/api/market-map", params={"market": "crypto"})
    assert r.status_code == 503
    assert r.json()["error"]["message"] == "CoinGecko is unavailable right now"
    assert "http" not in r.text
    assert "?" not in r.text


# --- shutdown closes the market map service -----------------------------------


class _ParkedCache:
    """Lifespan prewarm stand-in: parks until the shutdown cancels it."""

    async def run_background(self, markets: tuple[str, ...], interval_s: float) -> None:
        await asyncio.sleep(3600)


class _RecordingService(MarketMapService):
    def __init__(self, *, fail_close: bool = False) -> None:
        super().__init__(fetch_us=_ok_us, fetch_crypto=_ok_crypto, fetch_pairs=_ok_pairs)
        self.closed = 0
        self.fail_close = fail_close

    async def close(self) -> None:
        self.closed += 1
        if self.fail_close:
            raise RuntimeError("socket already gone")
        await super().close()


async def test_shutdown_closes_the_market_map_service(tmp_path):
    app = create_app(Config(data_dir=str(tmp_path)), market_cache=_ParkedCache())
    service = _RecordingService()
    app.state.market_map = service
    async with app.router.lifespan_context(app):
        assert service.closed == 0
    assert service.closed == 1


async def test_failed_market_map_close_does_not_stop_shutdown(tmp_path, caplog):
    app = create_app(Config(data_dir=str(tmp_path)), market_cache=_ParkedCache())
    app.state.market_map = _RecordingService(fail_close=True)
    flushed: list[bool] = []
    manager = app.state.manager
    flush_all = manager.flush_all

    async def spy_flush() -> None:
        flushed.append(True)
        await flush_all()

    manager.flush_all = spy_flush
    with caplog.at_level(logging.WARNING, logger="flowmap_server.api.app"):
        async with app.router.lifespan_context(app):
            pass
    assert flushed == [True]
    assert "market map did not close cleanly: RuntimeError" in caplog.text
