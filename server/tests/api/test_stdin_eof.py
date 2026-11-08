"""FLOWMAP_EXIT_ON_STDIN_EOF: stdin EOF stops the sidecar.

The desktop shell holds the write end of the sidecar's stdin. EOF on that pipe
means the shell is gone, so the sidecar must stop through uvicorn's graceful
path (lifespan flush included) instead of running on as an orphan. Nothing here touches the real process signal handlers: the stop
request is replaced with a recorder.
"""

from __future__ import annotations

import asyncio
import io
import os
import threading

import pytest

from flowmap_server.api import lifecycle
from flowmap_server.api.app import create_app
from flowmap_server.config import Config


class _RecordingStop:
    def __init__(self) -> None:
        self.called = threading.Event()
        self.calls = 0

    def __call__(self) -> None:
        self.calls += 1
        self.called.set()


class _NoPrewarmCache:
    async def run_background(self, markets, interval_s) -> None:
        await asyncio.sleep(3600)


def test_eof_on_a_pipe_fires_only_after_the_write_end_closes():
    read_fd, write_fd = os.pipe()
    stream = os.fdopen(read_fd, "rb")
    fired = threading.Event()
    try:
        os.write(write_fd, b"still alive\n")
        lifecycle.watch_stdin_eof(stream, fired.set)
        assert not fired.wait(0.3), "must not stop while the shell still holds the pipe"
        os.close(write_fd)
        write_fd = -1
        assert fired.wait(5.0), "EOF must stop the sidecar"
    finally:
        if write_fd != -1:
            os.close(write_fd)
        stream.close()


def test_text_stream_at_eof_fires_immediately():
    fired = threading.Event()
    lifecycle.watch_stdin_eof(io.StringIO(""), fired.set)
    assert fired.wait(5.0)


def test_broken_pipe_counts_as_eof():
    class _Broken:
        def read(self, n):
            raise OSError("pipe broken")

    fired = threading.Event()
    lifecycle.watch_stdin_eof(_Broken(), fired.set)
    assert fired.wait(5.0)


def test_no_stream_means_no_watch_and_no_stop():
    fired = threading.Event()
    assert lifecycle.watch_stdin_eof(None, fired.set) is None
    assert not fired.wait(0.1)


def test_config_flag_defaults_off_and_parses_switch(tmp_path):
    assert Config().exit_on_stdin_eof is False
    assert Config.from_env({}).exit_on_stdin_eof is False
    assert Config.from_env({"FLOWMAP_EXIT_ON_STDIN_EOF": "1"}).exit_on_stdin_eof is True
    with pytest.raises(ValueError, match="FLOWMAP_EXIT_ON_STDIN_EOF"):
        Config.from_env({"FLOWMAP_EXIT_ON_STDIN_EOF": "sometimes"})


async def test_lifespan_requests_stop_when_flag_set_and_stdin_closes(tmp_path, monkeypatch):
    stop = _RecordingStop()
    monkeypatch.setattr(lifecycle, "request_shutdown", stop)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))  # already at EOF
    cfg = Config(data_dir=str(tmp_path), exit_on_stdin_eof=True)
    app = create_app(cfg, market_cache=_NoPrewarmCache())
    async with app.router.lifespan_context(app):
        assert await asyncio.to_thread(stop.called.wait, 5.0)
    assert stop.calls == 1


async def test_lifespan_leaves_stdin_alone_when_flag_unset(tmp_path, monkeypatch):
    stop = _RecordingStop()
    monkeypatch.setattr(lifecycle, "request_shutdown", stop)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    cfg = Config(data_dir=str(tmp_path))
    app = create_app(cfg, market_cache=_NoPrewarmCache())
    async with app.router.lifespan_context(app):
        await asyncio.sleep(0.2)
    assert stop.calls == 0
