"""FastAPI application factory.

``create_app`` wires the REST router, the binary WS endpoint and CORS around
one :class:`SessionManager`. The default manager serves market "sim" with a
REALTIME SimFeed (the non-realtime sim generator never awaits between
events, so inside a shared event loop it would starve every other task,
uvicorn included) plus the live crypto markets via :class:`CryptoFeed`, and
carries a :class:`Recorder` rooted at ``cfg.data_dir`` so every live session
self-records and rehydrates. Tests that want instant data
or no disk IO inject their own manager.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from flowmap_server import __version__
from flowmap_server.api import _env, discovery, export, lifecycle, rest, ws
from flowmap_server.api.market_cache import (
    MarketDataCache,
    default_movers_fn,
    default_quote_fn,
)
from flowmap_server.config import Config
from flowmap_server.core.backfill import default_backfill_fn
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import SessionManager
from flowmap_server.core.session_common import SHUTDOWN_FLUSH_DEADLINE_S
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.router import feed_factory
from flowmap_server.proto import events

__all__ = ["create_app"]

logger = logging.getLogger(__name__)

# CORS for the REST surface uses the SAME origin policy as the `/ws` gate
# (api/_env.py: origin_regex / origin_allowed; FLOWMAP_WS_ALLOWED_ORIGINS). The
# packaged webview (`tauri://localhost`, `http://tauri.localhost`) fetches the
# directory cross-origin from the loopback sidecar, and loopback dev servers on
# any port are trusted by both surfaces alike, so the two can no longer disagree.
_CORS_ALLOW_HEADERS = ["X-FlowMap-Token"]


def _error_response(code: str, message: str, status_code: int) -> JSONResponse:
    """One machine-readable error shape for the whole REST surface."""
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


async def _refuse(scope: Scope, receive: Receive, send: Send, *, status: int,
                  ws_code: int, code: str, message: str) -> None:
    """Reject one HTTP request, or one WebSocket with an honest close code.

    A WebSocket must be accepted before a close code can reach the peer (a
    bare pre-accept close becomes an HTTP 403 and the code is lost), so the
    handshake is accepted and closed at once — the same pattern as the
    ``/ws`` origin gate in api/ws.py.
    """
    if scope["type"] == "websocket":
        await receive()  # the websocket.connect message
        await send({"type": "websocket.accept",
                    "subprotocol": _env.accept_subprotocol(scope.get("subprotocols") or [])})
        await send({"type": "websocket.close", "code": ws_code, "reason": message})
        return
    await _error_response(code, message, status)(scope, receive, send)


class _LoopbackGuard:
    """Pure-ASGI guard over HTTP AND WebSocket scopes.

    1. ``Host`` must be a loopback name (127.0.0.1, localhost, [::1]) with an
       optional port, or the TestClient host ``testserver``. Anything else —
       the signature of a DNS-rebinding page — is refused (400 / WS 4400).
    2. When ``FLOWMAP_SESSION_TOKEN`` is set and non-empty, the request must
       carry it: header ``X-FlowMap-Token`` (HTTP and WS), or on WS the offered
       subprotocol ``flowmap.auth.<token>`` (the browser client path, since
       browsers cannot set headers on a WebSocket), or query ``token=`` (WS
       only, kept for tools and older clients; the logs redact it). Refused
       with 401 / WS 4401. ``GET /api/health`` and ``OPTIONS`` (CORS
       preflight) are exempt from this token check, never from the Host check.

    The token is compared in constant time. The guard sits outside CORS, so a
    refused request never reaches a route or a CORS answer.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        raw_headers: list[tuple[bytes, bytes]] = list(scope.get("headers") or [])
        hosts = [value for name, value in raw_headers if name == b"host"]
        if len(hosts) != 1 or not _env.host_is_loopback(hosts[0].decode("latin-1")):
            await _refuse(scope, receive, send, status=400, ws_code=4400,
                          code="bad_request", message="host not allowed")
            return
        if not self._token_exempt(scope):
            provided = self._provided_token(scope, raw_headers)
            if not _env.session_token_ok(provided):
                await _refuse(scope, receive, send, status=401, ws_code=4401,
                              code="unauthorized", message="missing or invalid session token")
                return
        await self.app(scope, receive, send)

    @staticmethod
    def _token_exempt(scope: Scope) -> bool:
        if scope["type"] != "http":
            return False
        method = scope.get("method", "")
        return method == "OPTIONS" or (method == "GET" and scope.get("path") == "/api/health")

    @staticmethod
    def _provided_token(scope: Scope, raw_headers: list[tuple[bytes, bytes]]) -> str | None:
        values = [value for name, value in raw_headers if name == b"x-flowmap-token"]
        if len(values) == 1:
            return values[0].decode("utf-8", errors="replace")
        if len(values) > 1 or scope["type"] != "websocket":
            return None  # ambiguous duplicate header: refuse rather than guess
        offered = _env.subprotocol_tokens(scope.get("subprotocols") or [])
        if len(offered) == 1:
            return offered[0]
        if len(offered) > 1:
            return None  # ambiguous duplicate credential: refuse rather than guess
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        tokens = query.get("token", [])
        return tokens[0] if len(tokens) == 1 else None


def _install_error_handlers(app: FastAPI) -> None:
    """Structured JSON errors: ``{"error": {"code", "message"}}``.

    Replaces the framework defaults (Starlette's ``{"detail": ...}`` and
    FastAPI's verbose 422 ``detail`` list) so the client parses ONE shape.
    Status codes are preserved: 404 stays 404, validation stays 422
    (FastAPI's contract), only the BODY is normalized.
    """
    _HTTP_CODES = {
        400: "bad_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        405: "method_not_allowed",
        422: "invalid_params",
        429: "rate_limited",
    }

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # A route that knows the precise reason raises ApiError (api/errors.py);
        # everything else keeps the status-derived code.
        code = getattr(exc, "api_code", None) or _HTTP_CODES.get(exc.status_code, "http_error")
        return _error_response(code, str(exc.detail), exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        parts = [
            f"{'.'.join(str(loc) for loc in err.get('loc', ()))}: {err.get('msg', 'invalid')}"
            for err in exc.errors()
        ]
        message = "; ".join(parts) if parts else "invalid request parameters"
        return _error_response("invalid_params", message, 422)

    @app.exception_handler(Exception)
    async def _internal_error(request: Request, exc: Exception) -> JSONResponse:
        # Never leak internals to the wire; the traceback stays in the log.
        return _error_response("internal_error", "internal server error", 500)


def _server_feed_factory(cfg: Config) -> Callable[[events.Subscribe], Feed]:
    """Server-path feed factory: realtime sim + live crypto/equity.

    Same routing as the test path (both go through ``feeds.router``); only the
    sim feed differs — ``realtime=True`` paces one interval per ``dt_ns`` of
    wall time, which keeps the event loop live and the demo stream watchable
    (4 columns/s at dt=250 ms).
    """
    return feed_factory(cfg, realtime_sim=True)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup background tasks + shutdown flush.

    On startup, the discovery cache's prewarm loop is started here — it used
    to be dead code with a docstring claiming ``create_app`` started it, so every
    cold ``/api/movers`` paid the full provider sweep.
    On shutdown the prewarm task is cancelled FIRST (no provider calls during
    teardown), then up to REC_FLUSH_COLS buffered columns plus trades per
    active session are flushed and awaited; failures inside the flush are
    logged and contained, never propagated into shutdown."""
    market_cache = getattr(app.state, "market_cache", None)
    run_background = getattr(market_cache, "run_background", None)
    prewarm: asyncio.Task | None = None
    preview_warm: asyncio.Task | None = None
    # Startup egress that no subscription drives. The movers prewarm refreshes
    # the crypto and equity sets every 30 s, and the preview catalog makes one
    # pass over the bundled symbols. Both reach the venue and equity-quote
    # endpoints listed in SECURITY.md ("Where it connects").
    if callable(run_background):
        prewarm = asyncio.create_task(
            run_background(("crypto", "equity"), 30.0), name="market-cache-prewarm"
        )
    run_catalog = getattr(market_cache, "run_preview_catalog", None)
    if callable(run_catalog):
        preview_warm = asyncio.create_task(run_catalog(), name="market-preview-catalog")
    cfg = getattr(app.state, "cfg", None)
    if getattr(cfg, "exit_on_stdin_eof", False):
        # The desktop shell holds our stdin; its EOF means it is gone.
        lifecycle.watch_stdin_eof(sys.stdin, lifecycle.request_shutdown)
    try:
        yield
    finally:
        warmups = [task for task in (prewarm, preview_warm) if task is not None]
        for task in warmups:
            task.cancel()
        if warmups:
            await asyncio.gather(*warmups, return_exceptions=True)
        close_cache = getattr(market_cache, "aclose", None)
        if callable(close_cache):
            await close_cache()
        manager = getattr(app.state, "manager", None)
        flush_all = getattr(manager, "flush_all", None)
        if flush_all is not None:
            # Bounded: the shell force-kills the sidecar after its grace, so a
            # flush that outlives this bound would be cut off silently. The
            # expiry is logged so a truncated shutdown is visible.
            try:
                async with asyncio.timeout(SHUTDOWN_FLUSH_DEADLINE_S):
                    await flush_all()
            except TimeoutError:
                logger.error(
                    "shutdown flush did not finish within %.0fs; unflushed rows may be lost",
                    SHUTDOWN_FLUSH_DEADLINE_S,
                )


def create_app(
    cfg: Config,
    manager: SessionManager | None = None,
    market_cache: MarketDataCache | None = None,
) -> FastAPI:
    if manager is None:
        recorder = Recorder(
            # expanduser defensively: from_env already expands, but a Config
            # constructed directly may carry the "~/..." default.
            Path(cfg.data_dir).expanduser(),
            cfg.recording_gb_cap,
            enabled=cfg.recording_enabled,
        )
        manager = SessionManager(
            cfg,
            feed_factory=_server_feed_factory(cfg),
            recorder=recorder,
            # First-launch history backfill. The network seam dispatches
            # crypto -> klines, equity -> Yahoo, sim -> no-op; tests inject their
            # own manager (no backfill).
            backfill_fn=default_backfill_fn,
        )
    # Discovery cache: all movers/quote network lives behind this
    # TTL-debounced cache. Tests inject a canned cache; the default wires the live
    # provider seams, called on /api/movers|/api/quote reads and by the lifespan
    # prewarm task (see _lifespan).
    if market_cache is None:
        from flowmap_server.data.universe import CRYPTO_MARKET, CRYPTO_SYMBOLS, EQUITY_TICKERS

        async def shared_quote(market: str, symbol: str):
            # Movers and hover previews share observation ownership; successful
            # workers warm previews before the complete ranking is available.
            cache = market_cache
            assert cache is not None  # bound below, before any request can run
            return await cache.quote(market, symbol, wait_for_refresh=True)

        async def shared_movers(market: str, limit: int):
            return await default_movers_fn(market, limit, quote_fn=shared_quote)

        market_cache = MarketDataCache(
            quote_fn=default_quote_fn, movers_fn=shared_movers,
            stale_while_revalidate=True,
            preview_catalog=tuple((CRYPTO_MARKET, symbol) for symbol in CRYPTO_SYMBOLS)
            + tuple(("equity", symbol) for symbol in EQUITY_TICKERS),
        )
    app = FastAPI(
        title="flowmap-server",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )
    app.state.cfg = cfg
    app.state.manager = manager
    app.state.market_cache = market_cache
    # Per-process WS connection cap counter (api/ws.py; per-app == per-process
    # under the single-app uvicorn sidecar).
    app.state.ws_live_connections = 0
    # /health uptime anchor (monotonic — immune to wall-clock adjustments).
    app.state.started_monotonic_ns = time.monotonic_ns()
    _install_error_handlers(app)
    # Added before the guard so the guard is the OUTERMOST layer: a Host or
    # token refusal never reaches CORS or a route.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_env.origin_regex(),
        allow_methods=["GET"],
        allow_headers=_CORS_ALLOW_HEADERS,
    )
    app.add_middleware(_LoopbackGuard)
    app.include_router(rest.router)
    app.include_router(discovery.router)
    app.include_router(export.router)
    app.include_router(ws.router)
    return app
