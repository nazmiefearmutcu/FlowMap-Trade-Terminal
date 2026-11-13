"""GET /api/macro: camelCase JSON, the stale flag, the unavailable reply and shutdown.

The service is pre-seeded on ``app.state.macro`` with fake fetchers, so no
request leaves the process.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.data.macro_public import MacroPublicService, MacroSourceError, Observation

NOW_NS = 1_700_000_000_123_456_789


async def _sofr() -> Observation:
    return Observation(3.9, "2026-11-12")


async def _curve() -> Observation:
    return Observation(0.24, "2026-11-12")


async def _hy() -> Observation:
    return Observation(3.5, "2026-11-11")


async def _down(reason: str = "http_503"):
    raise MacroSourceError(reason)


def _service(sofr=_sofr, curve=_curve, hy=_hy, now=None) -> MacroPublicService:
    return MacroPublicService(
        fetch_sofr=sofr, fetch_curve=curve, fetch_hy=hy,
        clock=lambda: NOW_NS, monotonic=now or (lambda: 0.0),
    )


def _client(service: MacroPublicService) -> httpx.AsyncClient:
    app = create_app(Config())
    app.state.macro = service
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720")


async def test_reading_has_camel_case_keys_and_millisecond_as_of():
    async with _client(_service()) as c:
        r = await c.get("/api/macro")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {
        "sofr", "sofrDate", "yield10y2y", "curveDate", "hySpread", "hyDate",
        "stressScore", "status", "sourceStatus", "sources", "asOf", "stale",
    }
    assert body["sofr"] == 3.9
    assert body["sofrDate"] == "2026-11-12"
    assert body["yield10y2y"] == 0.24
    assert body["curveDate"] == "2026-11-12"
    assert body["hySpread"] == 3.5
    assert body["hyDate"] == "2026-11-11"
    assert body["asOf"] == NOW_NS // 1_000_000
    assert isinstance(body["asOf"], int)
    assert body["stale"] is False


async def test_full_reading_carries_the_regime_and_the_sources():
    async with _client(_service()) as c:
        body = (await c.get("/api/macro")).json()
    assert body["status"] == "NORMAL_LIQUIDITY"
    assert body["stressScore"] == 0.1
    assert body["sourceStatus"] == {"SOFR": "ok", "BAMLH0A0HYM2": "ok", "T10Y2Y": "ok"}
    assert body["sources"] == {
        "SOFR": "New York Fed", "T10Y2Y": "US Treasury", "BAMLH0A0HYM2": "FRED",
    }


async def test_missing_high_yield_spread_is_null_with_its_reason():
    async def no_key():
        raise MacroSourceError("fred_api_key_missing")

    async with _client(_service(hy=no_key)) as c:
        body = (await c.get("/api/macro")).json()
    assert body["hySpread"] is None
    assert body["hyDate"] is None
    assert body["stressScore"] is None
    assert body["status"] is None
    assert body["sourceStatus"]["BAMLH0A0HYM2"] == "fred_api_key_missing"
    assert body["sofr"] == 3.9


async def test_stale_reading_is_marked_stale():
    now = [0.0]
    failing = [False]

    async def sofr():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(3.9, "2026-11-12")

    async def curve():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(0.24, "2026-11-12")

    async def hy():
        if failing[0]:
            raise MacroSourceError("unreachable")
        return Observation(3.5, "2026-11-11")

    service = _service(sofr=sofr, curve=curve, hy=hy, now=lambda: now[0])
    async with _client(service) as c:
        assert (await c.get("/api/macro")).json()["stale"] is False
        failing[0] = True
        now[0] = 15 * 60.0
        body = (await c.get("/api/macro")).json()
    assert body["stale"] is True
    assert body["sofr"] == 3.9


async def test_nothing_available_is_a_503_with_a_reason_and_no_url():
    async def sofr():
        raise MacroSourceError("http_500")

    async def curve():
        raise MacroSourceError("malformed")

    async def hy():
        raise MacroSourceError("fred_api_key_missing")

    async with _client(_service(sofr=sofr, curve=curve, hy=hy)) as c:
        r = await c.get("/api/macro")
    assert r.status_code == 503
    error = r.json()["error"]
    assert error["code"] == "macro_unavailable"
    assert "http_500" in error["message"]
    assert "malformed" in error["message"]
    assert "fred_api_key_missing" in error["message"]
    assert "://" not in error["message"]
    assert "?" not in error["message"]


async def test_unexpected_failure_reply_carries_no_url_or_secret():
    async def boom():
        raise RuntimeError("https://api.example.test/feed?key=secret")

    async def down():
        raise MacroSourceError("unreachable")

    async with _client(_service(sofr=boom, curve=down, hy=down)) as c:
        r = await c.get("/api/macro")
    assert r.status_code == 503
    assert "secret" not in r.text
    assert "://" not in r.text


# --- shutdown closes the macro service ----------------------------------------


class _ParkedCache:
    """Lifespan prewarm stand-in: parks until the shutdown cancels it."""

    async def run_background(self, markets: tuple[str, ...], interval_s: float) -> None:
        await asyncio.sleep(3600)


class _RecordingService(MacroPublicService):
    def __init__(self, *, fail_close: bool = False) -> None:
        super().__init__(fetch_sofr=_sofr, fetch_curve=_curve, fetch_hy=_hy)
        self.closed = 0
        self.fail_close = fail_close

    async def close(self) -> None:
        self.closed += 1
        if self.fail_close:
            raise RuntimeError("socket already gone")
        await super().close()


async def test_shutdown_closes_the_macro_service(tmp_path):
    app = create_app(Config(data_dir=str(tmp_path)), market_cache=_ParkedCache())
    service = _RecordingService()
    app.state.macro = service
    async with app.router.lifespan_context(app):
        assert service.closed == 0
    assert service.closed == 1


async def test_failed_macro_close_does_not_stop_shutdown(tmp_path, caplog):
    app = create_app(Config(data_dir=str(tmp_path)), market_cache=_ParkedCache())
    app.state.macro = _RecordingService(fail_close=True)
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
    assert "macro data did not close cleanly: RuntimeError" in caplog.text
