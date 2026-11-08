"""Env-var readers for the api/ layer.

The WS edge's own knobs are read here directly from the environment rather
than through ``config.py``, deliberately at CALL time (not import time) so
operators can change them per boot and tests can monkeypatch ``os.environ``
against a live server. Both helpers are total: an unusable
value falls back to the documented default instead of refusing to serve.

Knobs
-----
``FLOWMAP_WS_ALLOWED_ORIGINS``
    Overrides the built-in browser-origin allow-list with a comma-separated
    list of exact origins (the built-in loopback/tauri policy is REPLACED —
    re-list what you need). The single value ``*`` disables the origin check
    entirely (deployment escape hatch; the server still listens on loopback
    only). Absent/empty ``Origin`` (non-browser clients) is always accepted
    regardless of this setting. Unset -> the built-in policy.

``FLOWMAP_WS_MAX_CONNECTIONS``
    Per-process cap on concurrently served ``/ws`` connections (default 16).
    Over-limit clients are accepted-then-closed with WS close code 1013
    ("try again later") so a browser sees an honest, actionable signal
    instead of a hang. Values below 1 clamp to 1; unparseable values fall
    back to the default.
"""

from __future__ import annotations

import hmac
import os
import re
from collections.abc import Sequence
from urllib.parse import urlsplit

__all__ = [
    "ENV_SESSION_TOKEN",
    "ENV_WS_ALLOWED_ORIGINS",
    "ENV_WS_MAX_CONNECTIONS",
    "WS_AUTH_SUBPROTOCOL_PREFIX",
    "WS_MAX_CONNECTIONS_DEFAULT",
    "WS_SUBPROTOCOL",
    "accept_subprotocol",
    "host_is_loopback",
    "origin_allowed",
    "origin_regex",
    "session_token_ok",
    "subprotocol_tokens",
    "ws_max_connections",
]

ENV_WS_ALLOWED_ORIGINS = "FLOWMAP_WS_ALLOWED_ORIGINS"
ENV_WS_MAX_CONNECTIONS = "FLOWMAP_WS_MAX_CONNECTIONS"
# Per-launch secret the desktop shell generates and passes to the sidecar
# Unset or empty = no token check (browser dev mode, tests).
ENV_SESSION_TOKEN = "FLOWMAP_SESSION_TOKEN"
WS_MAX_CONNECTIONS_DEFAULT = 16
# The WebSocket subprotocol the FlowMap client offers and the server echoes. A
# browser fails the handshake when the offered subprotocol is not selected.
WS_SUBPROTOCOL = "flowmap.v1"
# The session token travels in a second offered entry, ``flowmap.auth.<token>``:
# browsers cannot set headers on a WebSocket, and a query string ends up in
# intermediary logs. The entry is checked and never echoed back on accept.
WS_AUTH_SUBPROTOCOL_PREFIX = "flowmap.auth."

# Non-loopback origins always allowed by the built-in policy: the packaged
# Tauri webview serves the SPA from these (windows/ macOS differ) and opens
# its WS from there. Matched exactly (after lowercase). Windows WebView2 serves
# over the custom protocol as `http://tauri.localhost` (the REST CORS list in
# api/app.py already carries it) while macOS uses `tauri://localhost`; the
# https variant covers a secure-context webview.
_TAURI_ORIGINS = frozenset(
    {"tauri://localhost", "https://tauri.localhost", "http://tauri.localhost"}
)
# Browser origins on the loopback hosts are trusted regardless of port (vite
# and other dev servers pick free ports). http only — the brief's policy.
# ::1 is the IPv6 loopback: a dev server bound to it (vite -6) sends
# `http://[::1]:<port>` origins that must pass the same trust.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def origin_allowed(origin: str | None, environ: dict[str, str] | None = None) -> bool:
    """The ``/ws`` origin policy.

    Always allowed, regardless of env:

    - absent/empty ``Origin`` — non-browser clients (the Tauri sidecar
      monitor, wscat, tests) never send one; browsers ALWAYS do, so an
      origin-bearing request is the thing to gate.

    Built-in policy (env unset): ``http://127.0.0.1:<any port>``,
    ``http://localhost:<any port>``, ``http://[::1]:<any port>`` (vite and
    local tools), ``tauri://localhost``, ``https://tauri.localhost`` and
    ``http://tauri.localhost`` (the packaged desktop webview).

    ``FLOWMAP_WS_ALLOWED_ORIGINS`` REPLACES that browser-origin list with
    its comma-separated entries; the single value ``*`` accepts everything.
    """
    env = os.environ if environ is None else environ
    raw = str(env.get(ENV_WS_ALLOWED_ORIGINS, "")).strip()
    if raw == "*":
        return True
    if origin is None or not origin.strip():
        return True  # non-browser client: no Origin header at all
    o = _normalize_origin(origin)
    if raw:
        return any(_normalize_origin(extra) == o for extra in raw.split(",") if extra.strip())
    if o in _TAURI_ORIGINS:
        return True
    try:
        parts = urlsplit(o)
    except ValueError:  # pragma: no cover — urlsplit rarely raises
        return False
    return parts.scheme == "http" and (parts.hostname or "") in _LOOPBACK_HOSTS


def _normalize_origin(value: str) -> str:
    """Case-fold and trim one origin (scheme/host are case-insensitive, RFC
    3986) and drop a trailing slash, on BOTH the incoming Origin and the
    operator-configured entries."""
    return value.strip().lower().rstrip("/")


def origin_regex(environ: dict[str, str] | None = None) -> str:
    """The SAME origin policy as :func:`origin_allowed`, as a regex for the
    REST CORS middleware. Deriving both from one place keeps the two surfaces
    from disagreeing (a dev server on another loopback port must not open
    ``/ws`` yet have its ``/api`` fetches CORS-blocked)."""
    env = os.environ if environ is None else environ
    raw = str(env.get(ENV_WS_ALLOWED_ORIGINS, "")).strip()
    if raw == "*":
        return r".*"
    if raw:
        entries = [_normalize_origin(extra) for extra in raw.split(",") if extra.strip()]
        if not entries:
            return r"(?!)"  # an all-blank list allows nothing, as origin_allowed does
        return "(?i:" + "|".join(re.escape(e) for e in entries) + ")"
    # Loopback is http only, exactly as origin_allowed states; tauri has both
    # schemes for the secure-context webview.
    return (
        r"(?i:http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?"
        r"|tauri://localhost|https://tauri\.localhost|http://tauri\.localhost)"
    )


def host_is_loopback(host: str | None) -> bool:
    """The ``Host`` header policy.

    Accepts ``127.0.0.1``, ``localhost`` and ``[::1]`` with an optional
    numeric port, plus the Starlette TestClient host ``testserver``. A rebound
    hostname (``evil.example``) or a malformed value is refused.
    """
    if not host:
        return False
    h = host.strip().lower()
    if h == "testserver":
        return True
    if h.startswith("["):
        end = h.find("]")
        if end == -1:
            return False
        name, rest = h[: end + 1], h[end + 1 :]
        if rest and not (rest.startswith(":") and rest[1:].isdigit()):
            return False
        return name == "[::1]"
    name, sep, port = h.partition(":")
    if sep and not port.isdigit():
        return False
    return name in ("127.0.0.1", "localhost")


def session_token_ok(provided: str | None, environ: dict[str, str] | None = None) -> bool:
    """True when no token is configured, or *provided* equals it.

    Compared with :func:`hmac.compare_digest` so the check does not leak the
    secret through timing. An unset or empty ``FLOWMAP_SESSION_TOKEN`` disables
    the check (browser dev mode, tests)."""
    env = os.environ if environ is None else environ
    expected = str(env.get(ENV_SESSION_TOKEN, ""))
    if not expected:
        return True
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def subprotocol_tokens(offered: Sequence[str]) -> list[str]:
    """Token values carried by the offered ``flowmap.auth.<token>`` entries."""
    tokens: list[str] = []
    for entry in offered:
        value = entry.strip()
        if value.startswith(WS_AUTH_SUBPROTOCOL_PREFIX):
            tokens.append(value[len(WS_AUTH_SUBPROTOCOL_PREFIX):])
    return tokens


def accept_subprotocol(offered: Sequence[str]) -> str | None:
    """The subprotocol to echo on a WebSocket accept: ``flowmap.v1`` when the
    peer offered it, else None. The auth entry is never echoed."""
    return WS_SUBPROTOCOL if any(entry.strip() == WS_SUBPROTOCOL for entry in offered) else None


def ws_max_connections(environ: dict[str, str] | None = None) -> int:
    """Per-process WS connection cap (default 16; see module docstring)."""
    env = os.environ if environ is None else environ
    raw = str(env.get(ENV_WS_MAX_CONNECTIONS, "")).strip()
    if not raw:
        return WS_MAX_CONNECTIONS_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return WS_MAX_CONNECTIONS_DEFAULT
    return max(1, value)
