"""The entrypoint bounds uvicorn's connection drain, so the lifespan flush always starts.

uvicorn drains open connections and tasks before it runs the lifespan shutdown,
which is where recordings are flushed. Without a graceful-shutdown timeout that
drain is unbounded, and a slow in-flight request can keep the flush from ever
running before the shell kills the sidecar.
"""

from __future__ import annotations

from flowmap_server import __main__ as entry
from flowmap_server.core.session_common import SERVER_DRAIN_BOUND_S, SHUTDOWN_FLUSH_DEADLINE_S

# The shell kills the sidecar after its GRACEFUL_STOP (app/src-tauri/src/sidecar.rs).
SHELL_GRACEFUL_STOP_S = 12.0


def test_entrypoint_passes_a_graceful_shutdown_bound_shorter_than_the_flush(monkeypatch):
    seen: dict[str, object] = {}
    monkeypatch.setattr(entry, "_run_server", lambda app, **kwargs: seen.update(kwargs))
    monkeypatch.setattr(entry, "create_app", lambda cfg: object())
    monkeypatch.setattr(entry, "configure_logging", lambda *args, **kwargs: None)
    monkeypatch.setattr(entry, "shutdown_logging", lambda: None)
    monkeypatch.delenv("FLOWMAP_BENCHMARK_PROVENANCE", raising=False)

    entry.main()

    assert seen["timeout_graceful_shutdown"] == SERVER_DRAIN_BOUND_S
    assert 0 < SERVER_DRAIN_BOUND_S < SHUTDOWN_FLUSH_DEADLINE_S
    # uvicorn pauses 0.1 s before it applies the bound; the flush runs after the drain.
    assert SERVER_DRAIN_BOUND_S + 0.1 + SHUTDOWN_FLUSH_DEADLINE_S < SHELL_GRACEFUL_STOP_S
