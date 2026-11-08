"""The owned log file is bounded and its text is UTF-8.

Rotation and repeat-collapsing run on the output worker; these tests drive the
worker's own write path directly, without starting its thread.
"""

from __future__ import annotations

import io
import logging
import os

import pytest

from flowmap_server import logging_setup as setup


def _record(message: str, name: str = "flowmap_server.api.ws", level: int = logging.WARNING):
    return logging.LogRecord(name, level, __file__, 1, message, None, None)


def test_the_log_file_rolls_and_keeps_only_the_configured_generations(tmp_path):
    path = tmp_path / "flowmap-server.log"
    output = setup.LogOutput(io.StringIO(), str(path), 8, max_bytes=400, backups=2)
    for index in range(60):
        output._write(_record(f"line {index:03d} " + "x" * 40))
    output._file.close()
    assert path.exists() and (tmp_path / "flowmap-server.log.1").exists()
    assert (tmp_path / "flowmap-server.log.2").exists()
    assert not (tmp_path / "flowmap-server.log.3").exists()  # bounded: no third generation
    for generation in (path, tmp_path / "flowmap-server.log.1"):
        assert generation.stat().st_size <= 400 + 200  # one record of slack
    newest = path.read_text(encoding="utf-8")
    assert "line 059" in newest  # the newest lines stay in the live file


def test_zero_backups_truncates_instead_of_growing(tmp_path):
    path = tmp_path / "flowmap-server.log"
    output = setup.LogOutput(io.StringIO(), str(path), 8, max_bytes=300, backups=0)
    for index in range(40):
        output._write(_record(f"row {index:03d} " + "y" * 40))
    output._file.close()
    assert not (tmp_path / "flowmap-server.log.1").exists()
    assert path.stat().st_size <= 300 + 200


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot unlink a file held open by the writer")
def test_a_removed_log_file_is_reopened_not_appended_to_an_unlinked_inode(tmp_path):
    path = tmp_path / "flowmap-server.log"
    output = setup.LogOutput(io.StringIO(), str(path), 8, max_bytes=10_000, backups=1)
    output._write(_record("before removal"))
    path.unlink()
    output._write(_record("after removal"))
    output._file.close()
    assert "after removal" in path.read_text(encoding="utf-8")


def test_identical_consecutive_messages_collapse_into_one_line_and_a_count(tmp_path):
    stream = io.StringIO()
    output = setup.LogOutput(stream, None, 8)
    for _ in range(5):
        output._emit(_record("ws refused: origin not allowed -> 1008"))
    output._emit(_record("a different message"))
    output._flush_repeats()
    text = stream.getvalue()
    assert text.count("ws refused: origin not allowed") == 1
    assert "previous message repeated 4 more times" in text
    assert "a different message" in text


def test_records_with_tracebacks_are_never_collapsed(tmp_path):
    stream = io.StringIO()
    output = setup.LogOutput(stream, None, 8)
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        exc_info = sys.exc_info()
    for _ in range(3):
        output._emit(logging.LogRecord("x", logging.ERROR, __file__, 1, "same", None, exc_info))
    output._flush_repeats()
    assert stream.getvalue().count("ValueError: boom") == 3


def test_redirected_stdio_is_switched_to_utf8_when_it_supports_it():
    wrapper = io.TextIOWrapper(io.BytesIO(), encoding="cp1254")
    setup._ensure_utf8(wrapper)
    assert wrapper.encoding == "utf-8"
    # A stream without reconfigure() is left alone rather than failing startup.
    setup._ensure_utf8(io.StringIO())


def test_a_failed_roll_is_retried_after_a_full_budget_not_on_every_record(tmp_path, monkeypatch):
    # A file held open by another process (Windows) makes every rename fail.
    # Each failed roll used to be retried on the next record; now it waits for
    # another full budget of output, and no record is lost.
    path = tmp_path / "flowmap-server.log"
    attempts = []

    def locked_replace(source, target):
        attempts.append(source)
        raise PermissionError("held open by another process")

    monkeypatch.setattr(setup.os, "replace", locked_replace)
    output = setup.LogOutput(io.StringIO(), str(path), 8, max_bytes=400, backups=2)
    for index in range(100):
        output._write(_record(f"line {index:03d} " + "z" * 40))
    output._file.close()
    # About 7 KB of output over a 400-byte budget: roughly 18 attempts, not ~95.
    assert 1 <= len(attempts) <= 25
    assert output.sink_errors >= 1
    assert "line 099" in path.read_text(encoding="utf-8")
