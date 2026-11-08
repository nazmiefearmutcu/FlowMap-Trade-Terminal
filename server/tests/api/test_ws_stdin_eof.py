"""FLOWMAP_EXIT_ON_STDIN_EOF: the desktop shell owns the server's lifetime.

The shell holds the sidecar's stdin open for its whole life. EOF on stdin means
the shell is gone, so the server must stop through uvicorn's graceful path (its
lifespan flush then runs before exit). Without this a quit waited out the
3 s grace and an orphaned sidecar outlived its window.
"""

from __future__ import annotations

import io
import sys
import threading
import time
import types

import pytest

from flowmap_server import __main__ as entry


class _Server:
    def __init__(self) -> None:
        self.should_exit = False


class _GatedStream:
    """Blocks in read() like an open pipe until released, then reports EOF."""

    def __init__(self) -> None:
        self.release = threading.Event()

    def read(self, size: int = -1) -> str:
        self.release.wait(5)
        return ""


class _BrokenStream:
    def read(self, size: int = -1) -> str:
        raise OSError("broken pipe")


def test_eof_asks_the_server_to_exit():
    server = _Server()
    thread = entry._watch_stdin_eof(server, io.StringIO(""))
    thread.join(5)
    assert not thread.is_alive()
    assert server.should_exit is True


def test_output_before_eof_is_drained_and_still_ends_in_exit():
    server = _Server()
    stream = io.StringIO("heartbeat\n" * 500)
    thread = entry._watch_stdin_eof(server, stream)
    thread.join(5)
    assert server.should_exit is True
    assert stream.read() == ""  # the watcher consumed the whole pipe


def test_an_open_stdin_never_stops_the_server():
    server = _Server()
    gate = _GatedStream()
    thread = entry._watch_stdin_eof(server, gate)
    thread.join(0.05)
    assert thread.is_alive() and server.should_exit is False
    gate.release.set()
    thread.join(5)
    assert server.should_exit is True


def test_a_broken_pipe_counts_as_eof():
    server = _Server()
    thread = entry._watch_stdin_eof(server, _BrokenStream())
    thread.join(5)
    assert server.should_exit is True


def test_the_watcher_is_a_daemon_so_it_never_blocks_interpreter_exit():
    gate = _GatedStream()
    thread = entry._watch_stdin_eof(_Server(), gate)
    try:
        assert thread.daemon is True
    finally:
        gate.release.set()
        thread.join(5)


def _patch_entry(monkeypatch) -> None:
    monkeypatch.setattr(entry, "_benchmark_provenance", lambda: None)
    monkeypatch.setattr(entry, "create_app", lambda cfg: object())
    monkeypatch.setattr(entry, "configure_logging", lambda *a, **k: None)
    monkeypatch.setattr(entry, "shutdown_logging", lambda: None)


def test_main_runs_a_server_it_can_stop_when_the_flag_is_set(monkeypatch):
    _patch_entry(monkeypatch)
    monkeypatch.setenv(entry.EXIT_ON_STDIN_EOF_ENV, "1")
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))  # the shell has already gone
    seen: dict[str, object] = {}

    class FakeServer:
        def __init__(self, config) -> None:
            seen["config"] = config
            self.should_exit = False

        def run(self) -> None:
            # The EOF watcher runs on its own thread; wait for its verdict the
            # way uvicorn's main loop would notice should_exit.
            deadline = time.monotonic() + 5
            while not self.should_exit and time.monotonic() < deadline:
                time.sleep(0.005)
            seen["stopped"] = self.should_exit

    monkeypatch.setattr(entry.uvicorn, "Config", lambda app, **kw: types.SimpleNamespace(app=app, **kw))
    monkeypatch.setattr(entry.uvicorn, "Server", FakeServer)
    monkeypatch.setattr(entry.uvicorn, "run", lambda *a, **k: pytest.fail("plain uvicorn.run used"))

    entry.main()
    assert seen["stopped"] is True
    assert seen["config"].log_config is None


def test_main_keeps_plain_uvicorn_run_without_the_flag(monkeypatch):
    _patch_entry(monkeypatch)
    monkeypatch.delenv(entry.EXIT_ON_STDIN_EOF_ENV, raising=False)
    calls: list[dict] = []
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kw: calls.append(kw))
    monkeypatch.setattr(entry.uvicorn, "Server", lambda *a, **k: pytest.fail("Server built"))

    entry.main()
    assert calls and calls[0]["log_config"] is None
