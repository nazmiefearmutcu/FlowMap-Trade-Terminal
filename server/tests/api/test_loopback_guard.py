"""Loopback Host guard, session token and the single origin policy.

The guard is a pure-ASGI layer over HTTP AND WebSocket scopes: a rebound
``Host`` is refused (400 / WS 4400), and when ``FLOWMAP_SESSION_TOKEN`` is set
every request must carry it (401 / WS 4401). ``GET /api/health`` and
``OPTIONS`` are exempt from the token only.
"""

from __future__ import annotations

import re

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from flowmap_server.api import _env
from flowmap_server.api.app import create_app
from flowmap_server.config import Config

TOKEN = "ab" * 32


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv(_env.ENV_SESSION_TOKEN, raising=False)
    monkeypatch.delenv(_env.ENV_WS_ALLOWED_ORIGINS, raising=False)
    return create_app(Config(data_dir=str(tmp_path / "rec"), recording_enabled=False))


def _http(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720")


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "127.0.0.1:8720", "localhost", "LOCALHOST:5173", "[::1]", "[::1]:8720", "testserver"],
)
def test_loopback_hosts_are_accepted(host):
    assert _env.host_is_loopback(host)


@pytest.mark.parametrize(
    "host",
    [
        None, "", "evil.example", "localhost.evil.example", "127.0.0.1.evil.example",
        "::1", "[::1", "[::1]x", "localhost:", "localhost:abc", "a:b:c", "0.0.0.0:8720",
    ],
)
def test_other_hosts_are_refused(host):
    assert not _env.host_is_loopback(host)


async def test_rebound_host_is_refused_over_http(app):
    async with _http(app) as client:
        refused = await client.get("/api/symbols", headers={"host": "evil.example"})
        ok = await client.get("/api/symbols")
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "bad_request"
    assert ok.status_code == 200


async def test_session_token_required_over_http_and_health_is_exempt(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    async with _http(app) as client:
        missing = await client.get("/api/symbols")
        wrong = await client.get("/api/symbols", headers={"x-flowmap-token": "00" * 32})
        right = await client.get("/api/symbols", headers={"x-flowmap-token": TOKEN})
        health = await client.get("/api/health")
    assert missing.status_code == 401 and missing.json()["error"]["code"] == "unauthorized"
    assert wrong.status_code == 401
    assert right.status_code == 200
    assert health.status_code == 200  # exempt from the token, never from the Host check


async def test_options_preflight_is_exempt_from_the_token(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    async with _http(app) as client:
        response = await client.options(
            "/api/symbols",
            headers={
                "origin": "http://127.0.0.1:5173",
                "access-control-request-method": "GET",
                "access-control-request-headers": "x-flowmap-token",
            },
        )
    assert response.status_code == 200
    assert "x-flowmap-token" in response.headers["access-control-allow-headers"].lower()


def test_token_unset_skips_the_check(app):
    client = TestClient(app)
    assert client.get("/api/symbols").status_code == 200


async def _ws_handshake(app, *, host: bytes, query: bytes = b"", headers=()) -> list[dict]:
    """Drive one WebSocket handshake at the ASGI level and return what the
    server sent. TestClient always sends its own Host, so a rebound Host can
    only be presented this way."""
    scope = {
        "type": "websocket", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "scheme": "ws", "path": "/ws", "raw_path": b"/ws", "root_path": "",
        "query_string": query, "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8720), "subprotocols": [], "state": {},
        "headers": [(b"host", host), *headers],
    }
    inbox = [{"type": "websocket.connect"}]
    sent: list[dict] = []

    async def receive() -> dict:
        return inbox.pop(0) if inbox else {"type": "websocket.disconnect", "code": 1000}

    async def send(message: dict) -> None:
        sent.append(message)

    await app(scope, receive, send)
    return sent


async def test_websocket_rebound_host_closes_4400(app):
    sent = await _ws_handshake(app, host=b"evil.example")
    closes = [m for m in sent if m["type"] == "websocket.close"]
    assert closes and closes[-1]["code"] == 4400
    assert any(m["type"] == "websocket.accept" for m in sent)  # accept-then-close delivers the code


def test_websocket_token_missing_or_wrong_closes_4401(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as missing:
        with client.websocket_connect("/ws") as ws:
            ws.receive_bytes()  # the refusal close surfaces here
    assert missing.value.code == 4401
    with pytest.raises(WebSocketDisconnect) as wrong:
        with client.websocket_connect("/ws?token=" + "00" * 32) as ws:
            ws.receive_bytes()
    assert wrong.value.code == 4401


def test_websocket_accepts_the_token_in_query_or_header(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    client = TestClient(app)
    # A valid token passes the guard: the server sends nothing until a
    # Subscribe, so the socket simply stays open until the context exits.
    with client.websocket_connect(f"/ws?token={TOKEN}"):
        pass
    with client.websocket_connect("/ws", headers={"x-flowmap-token": TOKEN}):
        pass


def test_session_token_comparison_is_exact(monkeypatch):
    env = {_env.ENV_SESSION_TOKEN: TOKEN}
    assert _env.session_token_ok(TOKEN, env)
    assert not _env.session_token_ok(TOKEN[:-1], env)
    assert not _env.session_token_ok(TOKEN + "0", env)
    assert not _env.session_token_ok(None, env)
    assert _env.session_token_ok(None, {})  # unset: no check


# --- one origin policy for /ws and REST CORS ---------------------------------

SAMPLE_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://[::1]:5173",
    "HTTP://LOCALHOST:9",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "https://127.0.0.1:5173",
    "http://evil.example",
    "http://localhost.evil.example",
]


@pytest.mark.parametrize("env", [{}, {_env.ENV_WS_ALLOWED_ORIGINS: "http://MyApp.local:3000/"}])
def test_rest_cors_regex_and_ws_gate_agree(env):
    pattern = re.compile(_env.origin_regex(env))
    for origin in SAMPLE_ORIGINS:
        assert bool(pattern.fullmatch(origin)) == _env.origin_allowed(origin, env), origin


def test_configured_origin_with_uppercase_and_trailing_slash_matches():
    env = {_env.ENV_WS_ALLOWED_ORIGINS: "http://MyApp.local:3000/"}
    assert _env.origin_allowed("http://myapp.local:3000", env)
    assert _env.origin_allowed("http://MYAPP.local:3000/", env)
    assert not _env.origin_allowed("http://other.local:3000", env)


async def test_rest_cors_allows_any_loopback_port_like_ws_does(app):
    async with _http(app) as client:
        response = await client.options(
            "/api/symbols",
            headers={"origin": "http://127.0.0.1:9999", "access-control-request-method": "GET"},
        )
    assert response.headers.get("access-control-allow-origin") == "http://127.0.0.1:9999"


def test_websocket_token_in_subprotocol_is_accepted_and_only_flowmap_v1_is_echoed(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    client = TestClient(app)
    offered = [_env.WS_SUBPROTOCOL, _env.WS_AUTH_SUBPROTOCOL_PREFIX + TOKEN]
    with client.websocket_connect("/ws", subprotocols=offered) as ws:
        # The token entry is checked and never echoed back in the accept.
        assert ws.accepted_subprotocol == _env.WS_SUBPROTOCOL


def test_websocket_wrong_or_ambiguous_subprotocol_token_closes_4401(app, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    client = TestClient(app)
    wrong = [_env.WS_SUBPROTOCOL, _env.WS_AUTH_SUBPROTOCOL_PREFIX + "00" * 32]
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws", subprotocols=wrong) as ws:
            # The refusal is accepted first, so a browser completes the handshake
            # and then reads the honest close code.
            assert ws.accepted_subprotocol == _env.WS_SUBPROTOCOL
            ws.receive_bytes()
    assert refused.value.code == 4401
    doubled = [_env.WS_SUBPROTOCOL, _env.WS_AUTH_SUBPROTOCOL_PREFIX + TOKEN,
               _env.WS_AUTH_SUBPROTOCOL_PREFIX + TOKEN]
    with pytest.raises(WebSocketDisconnect) as ambiguous:
        with client.websocket_connect("/ws", subprotocols=doubled) as ws:
            ws.receive_bytes()
    assert ambiguous.value.code == 4401


def test_websocket_subprotocol_without_a_configured_token_echoes_flowmap_v1(app):
    with TestClient(app).websocket_connect("/ws", subprotocols=[_env.WS_SUBPROTOCOL]) as ws:
        assert ws.accepted_subprotocol == _env.WS_SUBPROTOCOL


def test_subprotocol_helpers_pick_the_echo_and_the_token_only():
    offered = [" flowmap.v1", "flowmap.auth." + TOKEN]
    assert _env.accept_subprotocol(offered) == _env.WS_SUBPROTOCOL
    assert _env.accept_subprotocol(["flowmap.auth." + TOKEN]) is None
    assert _env.accept_subprotocol([]) is None
    assert _env.subprotocol_tokens(offered) == [TOKEN]
