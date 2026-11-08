"""A broken stats producer is logged, and the health probe still answers 200."""

from __future__ import annotations

import logging

import httpx
import pytest

from flowmap_server.api.app import create_app
from flowmap_server.config import Config


@pytest.fixture
def app():
    return create_app(Config())


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720") as c:
        yield c


async def test_failing_stats_snapshot_is_logged_and_health_stays_ok(app, client, caplog, monkeypatch):
    def broken_snapshot():
        raise RuntimeError("stats producer exploded")

    monkeypatch.setattr(app.state.manager.stats, "snapshot", broken_snapshot)
    with caplog.at_level(logging.WARNING, logger="flowmap_server.api.rest"):
        r = await client.get("/api/health")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["stats_available"] is False
    failures = [rec for rec in caplog.records if rec.getMessage() == "health stats producer failed"]
    assert len(failures) == 1
    assert failures[0].exc_info is not None
