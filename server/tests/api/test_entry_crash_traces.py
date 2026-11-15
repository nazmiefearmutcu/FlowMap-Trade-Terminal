"""The entrypoint turns on crash traces, so a native crash leaves a stack in the log.

An access violation inside an extension module (seen twice in python313.dll under
the desktop shell) ends the process with no Python traceback. With faulthandler
on, every thread's stack goes to stderr, which the shell copies into the log.
"""

from __future__ import annotations

import io

from flowmap_server import __main__ as entry


def test_crash_traces_cover_every_thread_and_go_to_stderr(monkeypatch):
    calls: list[dict[str, object]] = []
    stderr = io.StringIO()
    monkeypatch.setattr(entry.sys, "stderr", stderr)
    monkeypatch.setattr(entry.faulthandler, "is_enabled", lambda: False)
    monkeypatch.setattr(entry.faulthandler, "enable", lambda **kwargs: calls.append(kwargs))

    entry._enable_crash_traces()

    assert calls == [{"file": stderr, "all_threads": True}]


def test_a_stderr_without_a_descriptor_does_not_stop_the_server(monkeypatch):
    def refuse(**kwargs):
        raise io.UnsupportedOperation("fileno")

    monkeypatch.setattr(entry.sys, "stderr", io.StringIO())
    monkeypatch.setattr(entry.faulthandler, "is_enabled", lambda: False)
    monkeypatch.setattr(entry.faulthandler, "enable", refuse)

    entry._enable_crash_traces()  # must not raise


def test_no_stderr_and_an_enabled_handler_are_left_alone(monkeypatch):
    calls: list[object] = []
    monkeypatch.setattr(entry.faulthandler, "enable", lambda **kwargs: calls.append(kwargs))

    monkeypatch.setattr(entry.sys, "stderr", None)
    monkeypatch.setattr(entry.faulthandler, "is_enabled", lambda: False)
    entry._enable_crash_traces()

    monkeypatch.setattr(entry.sys, "stderr", io.StringIO())
    monkeypatch.setattr(entry.faulthandler, "is_enabled", lambda: True)
    entry._enable_crash_traces()

    assert calls == []
