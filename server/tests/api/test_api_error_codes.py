"""Stable REST error codes and the recording switch on the availability reply.

The client branches on ``error.code`` and the HTTP status, never on the English
message text, so these codes are a contract: a wording change must not break it.
"""

from __future__ import annotations

import httpx

from flowmap_server.api.app import create_app
from flowmap_server.api.errors import ApiError
from flowmap_server.config import Config


def _client(cfg: Config) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=create_app(cfg))
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720")


WINDOW = {"market": "sim", "symbol": "SIM-DEMO", "start_ns": 0, "end_ns": 1}


async def test_window_with_the_recording_switch_off_is_a_coded_422(tmp_path):
    async with _client(Config(data_dir=str(tmp_path), recording_enabled=False)) as client:
        r = await client.get("/api/recordings/window", params=WINDOW)
    assert r.status_code == 422
    body = r.json()["error"]
    assert body["code"] == "replay_unavailable"
    assert body["message"]  # human text stays present for logs and diagnostics


async def test_window_without_a_recording_store_is_a_coded_404(tmp_path):
    app = create_app(Config(data_dir=str(tmp_path), recording_enabled=False))
    app.state.manager._recorder = None
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720") as client:
        r = await client.get("/api/recordings/window", params=WINDOW)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "recording_store_missing"


async def test_availability_reports_recording_enabled_both_ways(tmp_path):
    params = {"market": "sim", "symbol": "SIM-DEMO"}
    async with _client(Config(data_dir=str(tmp_path / "off"), recording_enabled=False)) as client:
        off = await client.get("/api/recordings/availability", params=params)
    async with _client(Config(data_dir=str(tmp_path / "on"), recording_enabled=True)) as client:
        on = await client.get("/api/recordings/availability", params=params)
    assert off.status_code == on.status_code == 200
    assert off.json()["recording_enabled"] is False
    assert on.json()["recording_enabled"] is True


async def test_unknown_movers_market_has_a_stable_code(tmp_path):
    async with _client(Config(data_dir=str(tmp_path), recording_enabled=False)) as client:
        r = await client.get("/api/movers", params={"market": "kraken"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "unknown_market"


async def test_malformed_quote_symbol_has_a_stable_code(tmp_path):
    async with _client(Config(data_dir=str(tmp_path), recording_enabled=False)) as client:
        r = await client.get("/api/quote", params={"market": "binance-spot", "symbol": "!!!"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_symbol"


def test_api_error_carries_its_code_and_status():
    err = ApiError(422, "replay_unavailable", "no replayable recording covers this window")
    assert err.status_code == 422
    assert err.api_code == "replay_unavailable"
    assert err.detail == "no replayable recording covers this window"
