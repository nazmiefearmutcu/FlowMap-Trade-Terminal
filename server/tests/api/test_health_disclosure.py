"""``/api/health`` answers liveness to anyone and the operational snapshot only to the token holder.

The route is token-exempt so probes work without a token, which makes it
reachable from any loopback-origin page. Only the liveness fields may leave
without the token; feeds, session ids, stats, config errors and the recording
flag need it.
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server.api import _env
from flowmap_server.api.app import create_app
from flowmap_server.config import Config

TOKEN = "cd" * 32
LIVENESS_KEYS = {"status", "version", "protocol_version", "uptime_s"}
SNAPSHOT_KEYS = {"feeds", "active_sessions", "stats", "config_error", "recording_enabled"}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    monkeypatch.delenv(_env.ENV_WS_ALLOWED_ORIGINS, raising=False)
    return create_app(Config(data_dir=str(tmp_path / "rec"), recording_enabled=False))


def _http(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720")


async def test_health_without_the_token_is_liveness_only(app):
    async with _http(app) as client:
        body = (await client.get("/api/health")).json()

    assert body["status"] == "ok"
    assert set(body) == LIVENESS_KEYS


@pytest.mark.parametrize("headers", [{"x-flowmap-token": "wrong"}, {"x-flowmap-token": ""}])
async def test_health_with_a_wrong_token_is_liveness_only(app, headers):
    async with _http(app) as client:
        body = (await client.get("/api/health", headers=headers)).json()

    assert set(body) == LIVENESS_KEYS


async def test_health_with_the_token_returns_the_operational_snapshot(app):
    async with _http(app) as client:
        body = (await client.get("/api/health", headers={"x-flowmap-token": TOKEN})).json()

    assert SNAPSHOT_KEYS <= set(body)
    assert isinstance(body["recording_enabled"], bool)
