"""``python -m flowmap_server`` — run the app under uvicorn.

Config is env-first via :meth:`Config.from_env`; the loopback-only bind is
enforced twice: ``from_env`` raises on a non-loopback ``FLOWMAP_HOST``, and
the explicit check below keeps the invariant visible at the entrypoint
(and survives ``python -O``).
"""

from __future__ import annotations

import os
import sys
import threading
from typing import IO, Any

import uvicorn

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.core.session_common import SERVER_DRAIN_BOUND_S
from flowmap_server.logging_setup import configure_logging, shutdown_logging

__all__ = ["main", "configure_logging"]

# Set to "1" by the desktop shell. The shell keeps this process's stdin open
# for its whole life; EOF means the shell is gone (quit, crash, or a closed
# window), so the server must stop and run its lifespan flush.
EXIT_ON_STDIN_EOF_ENV = "FLOWMAP_EXIT_ON_STDIN_EOF"
BENCHMARK_PROVENANCE_ENV = "FLOWMAP_BENCHMARK_PROVENANCE"

# Inbound WebSocket message cap. uvicorn's default is 16 MiB, and every frame
# is copied and decoded in full before any check runs. The FlowMap client sends
# only small control messages, so 256 KiB is generous.
WS_MAX_MESSAGE_BYTES = 256 * 1024
# Upper bound on concurrent HTTP and WebSocket connections handled by uvicorn.
HTTP_WS_CONCURRENCY = 512


def _benchmark_provenance() -> None:
    """Benchmark-only hook. The module loads only when the env var is set."""
    if not os.environ.get(BENCHMARK_PROVENANCE_ENV):
        return
    from flowmap_server.benchmark_provenance import write_provenance

    write_provenance()


def _watch_stdin_eof(server: Any, stream: IO[Any]) -> threading.Thread:
    """Ask *server* to exit once *stream* reaches EOF (a read error counts too).

    A daemon thread blocks on the read, so the event loop is never touched from
    it. Setting ``should_exit`` is uvicorn's own graceful path: the lifespan
    shutdown runs, which flushes recordings before the process ends."""

    def _watch() -> None:
        try:
            while stream.read(1024):
                pass
        except (OSError, ValueError):
            pass  # a broken pipe is the same signal as EOF
        server.should_exit = True

    thread = threading.Thread(target=_watch, name="flowmap-stdin-eof", daemon=True)
    thread.start()
    return thread


def _run_server(app: Any, *, exit_on_stdin_eof: bool, **kwargs: Any) -> None:
    """``uvicorn.run`` unless the shell asked to exit with its stdin.

    The EOF watcher needs the ``Server`` object (its ``should_exit`` flag), which
    ``uvicorn.run`` does not expose. ``uvicorn.run`` is just ``Server(Config).run()``,
    so the two paths are the same server."""
    if not exit_on_stdin_eof:
        uvicorn.run(app, **kwargs)
        return
    server = uvicorn.Server(uvicorn.Config(app, **kwargs))
    if sys.stdin is not None:
        _watch_stdin_eof(server, sys.stdin)
    server.run()


def main() -> None:
    _benchmark_provenance()
    cfg = Config.from_env(os.environ)
    if cfg.host not in ("127.0.0.1", "localhost"):  # survives python -O, unlike assert
        raise SystemExit(f"loopback only: refusing to bind {cfg.host!r}")
    log_level = os.environ.get("FLOWMAP_LOG_LEVEL", "info")
    configure_logging(log_level, os.environ.get("FLOWMAP_LOG_FILE") or None)
    try:
        _run_server(create_app(cfg), exit_on_stdin_eof=cfg.exit_on_stdin_eof,
                    host=cfg.host, port=cfg.port,
                    log_level=log_level, log_config=None,
                    ws_max_size=WS_MAX_MESSAGE_BYTES,
                    limit_concurrency=HTTP_WS_CONCURRENCY,
                    timeout_graceful_shutdown=SERVER_DRAIN_BOUND_S)
    finally:
        shutdown_logging()


if __name__ == "__main__":
    main()
