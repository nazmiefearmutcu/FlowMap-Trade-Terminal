"""Entrypoint limits for the WebSocket server.

uvicorn's default inbound WebSocket message cap is 16 MiB, copied and decoded
in full before any check. The entrypoint must set an explicit, smaller cap and
a concurrency bound.
"""

from __future__ import annotations

from flowmap_server import __main__ as entry


def test_entrypoint_caps_inbound_frames_and_concurrency(monkeypatch):
    seen: dict[str, object] = {}
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kwargs: seen.update(kwargs))
    monkeypatch.setattr(entry, "create_app", lambda cfg: object())
    monkeypatch.setattr(entry, "configure_logging", lambda *args, **kwargs: None)
    monkeypatch.setattr(entry, "shutdown_logging", lambda: None)
    monkeypatch.delenv("FLOWMAP_BENCHMARK_PROVENANCE", raising=False)

    entry.main()

    assert seen["ws_max_size"] == entry.WS_MAX_MESSAGE_BYTES == 256 * 1024
    assert seen["limit_concurrency"] == entry.HTTP_WS_CONCURRENCY
    assert seen["log_config"] is None
