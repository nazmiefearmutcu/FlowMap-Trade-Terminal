"""Bounded, nonblocking production logging; only the output thread touches sinks.

Shutdown stops admission and drains the queue. ``stop`` waits at most its timeout;
an unresponsive OS stream cannot be interrupted, so the daemon may finish later
or lose pending diagnostics at process exit. Sink objects deliberately are not
logging Handlers: logging.shutdown must not wait on their in-flight I/O locks.
The caller's stderr is borrowed and is never closed. Interpreter finalization
may itself flush stderr, so a bounded join is not a bound on process exit.
"""

from __future__ import annotations

import atexit
import copy
import logging
import os
import queue
import re
import sys
import threading
from typing import TextIO

_QUEUE_CAPACITY = 2048
_SHUTDOWN_TIMEOUT = 2.0
# The owned log file rolls at this size; ``_LOG_BACKUPS`` older generations are
# kept (flowmap-server.log.1 ... .N), so the file sink stays bounded.
_LOG_MAX_BYTES = 20 * 1024 * 1024
_LOG_BACKUPS = 3
_state: LogOutput | None = None
_configuration_lock = threading.Lock()


def _ensure_utf8(stream: TextIO) -> None:
    """Write UTF-8 to a redirected stdio stream.

    A redirected stream on Windows defaults to the ANSI code page (cp1254 on a
    Turkish system): Turkish letters survive only by luck and anything outside
    the page became a backslash escape in the crash log. Best effort: a stream
    without ``reconfigure`` (a StringIO, a replaced object) is left alone."""
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (ValueError, OSError):
            pass


# A session token in a URL query (``?token=<value>``) is a credential: uvicorn
# logs the raw WebSocket path on every handshake. Scrubbed before queueing.
_TOKEN_PARAM_RE = re.compile(r"(?i)(\btoken=)[^\s&\"'#)\]]+")


def redact_secrets(text: str) -> str:
    """Replace the value of every ``token=`` URL parameter in ``text``."""
    return _TOKEN_PARAM_RE.sub(r"\1***", text)


def _redact_arg(value: object) -> object:
    return redact_secrets(value) if isinstance(value, str) else value


def redact_record(record: logging.LogRecord) -> None:
    """Scrub credentials from a record in place, WITHOUT rendering it.

    The message template and its string arguments are rewritten separately so
    the producer never formats a message (see ``_Admission``). Exception text
    is not rewritten; no code path logs a credential inside an exception.
    """
    if isinstance(record.msg, str):
        record.msg = redact_secrets(record.msg)
    if isinstance(record.args, tuple):
        record.args = tuple(_redact_arg(a) for a in record.args)
    elif isinstance(record.args, dict):
        record.args = {k: _redact_arg(v) for k, v in record.args.items()}


class TokenRedactionFilter(logging.Filter):
    """Scrubs ``token=`` URL parameters from each record before admission.

    The admission handler installs it, so every record on the root, uvicorn,
    uvicorn.error and uvicorn.access loggers passes through it. It returns a
    redacted copy (Python 3.12+ handler filters may replace the record), so the
    caller's record is left as created and nothing is rendered on the producer.
    """

    def filter(self, record: logging.LogRecord) -> logging.LogRecord:
        redacted = copy.copy(record)
        redact_record(redacted)
        return redacted


class _Admission(logging.Handler):
    def __init__(self, output: LogOutput) -> None:
        super().__init__()
        self.output = output
        self.addFilter(TokenRedactionFilter())

    def emit(self, record: logging.LogRecord) -> None:
        # Do not use QueueHandler.prepare: it formats messages/exceptions on
        # the producer. Keep exc_info and args for formatting on the worker.
        # ``record`` is the private redacted copy the filter returned.
        self.output.enqueue(record)


class LogOutput:
    def __init__(
        self,
        stream: TextIO,
        log_file: str | None,
        capacity: int,
        *,
        max_bytes: int = _LOG_MAX_BYTES,
        backups: int = _LOG_BACKUPS,
    ) -> None:
        self.queue: queue.Queue[logging.LogRecord] = queue.Queue(maxsize=capacity)
        self.stream = stream
        self.log_file = log_file
        self.max_bytes = max(1, int(max_bytes))
        self.backups = max(0, int(backups))
        self.formatter = logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"
        )
        self._file: TextIO | None = None
        self._file_bytes = 0
        # A roll that failed (file held open elsewhere) is retried only after
        # another full budget of writes, not once per record.
        self._roll_after = 0
        # Consecutive identical messages (same logger, level and rendered text)
        # collapse into one line plus a repeat count, so a noisy client cannot
        # fill the log with the same warning. Worker-thread state only.
        self._last_key: tuple[str, int, str] | None = None
        self._last_record: logging.LogRecord | None = None
        self._repeats = 0
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self.finished = threading.Event()
        self.dropped = 0
        self.reported_drops = 0
        self.sink_errors = 0
        self.reported_errors = 0
        self.saved: list[tuple[logging.Logger, list[logging.Handler], int, bool, bool]] = []
        self.handler = _Admission(self)
        self.thread = threading.Thread(target=self._run, name="flowmap-log-output", daemon=True)

    def enqueue(self, record: logging.LogRecord) -> None:
        # This lock guards only admission/counters, never formatting or I/O.
        with self._lock:
            if self._stopping.is_set():
                self.dropped += 1
                return
            try:
                self.queue.put_nowait(record)
            except queue.Full:
                self.dropped += 1

    def _write(self, record: logging.LogRecord) -> bool:
        try:
            text = self.formatter.format(record) + "\n"
        except Exception:
            self.sink_errors += 1
            return False
        succeeded = False
        try:
            self.stream.write(text)
            self.stream.flush()
            succeeded = True
        except Exception:
            self.sink_errors += 1
        if self.log_file:
            try:
                self._write_file(text)
                succeeded = True
            except Exception:
                self.sink_errors += 1
        return succeeded

    def _open_log(self) -> None:
        path = self.log_file
        assert path is not None  # only reached for a configured file sink
        self._file = open(path, "a", encoding="utf-8")
        try:
            self._file_bytes = os.path.getsize(path)
        except OSError:
            self._file_bytes = 0

    def _write_file(self, text: str) -> None:
        """Append to the owned log file, rolling it at ``max_bytes``.

        Reopens the path when it was removed or moved underneath us, so the
        writer never keeps appending to an unlinked inode that no reader sees."""
        path = self.log_file
        assert path is not None  # only reached for a configured file sink
        if self._file is not None and not os.path.exists(path):
            self._file.close()
            self._file = None
        if self._file is None:
            self._open_log()
        data = len(text.encode("utf-8"))
        if (
            self._file_bytes > 0
            and self._file_bytes + data > self.max_bytes
            and self._file_bytes >= self._roll_after
        ):
            self._rotate()
        file = self._file
        assert file is not None  # _open_log or _rotate always leaves a file open
        file.write(text)
        file.flush()
        self._file_bytes += data

    def _rotate(self) -> None:
        """Roll ``log`` to ``log.1`` (and so on up to ``log.<backups>``).

        A rename can fail while another process holds the file open (Windows).
        That is counted as a sink error and the record is written to the file
        as it is, so logging never stops and no line is lost. The next roll
        is then attempted only after another full ``max_bytes`` of output."""
        assert self._file is not None
        path = self.log_file
        assert path is not None  # rotation only runs for a configured file sink
        self._file.close()
        self._file = None
        rolled = True
        try:
            if self.backups == 0:
                # No generations kept: drop the old text rather than grow forever.
                if os.path.exists(path):
                    os.remove(path)
            for index in range(self.backups, 0, -1):
                source = path if index == 1 else f"{path}.{index - 1}"
                if os.path.exists(source):
                    os.replace(source, f"{path}.{index}")
        except OSError:
            rolled = False
            self.sink_errors += 1
        finally:
            # Re-measures the (fresh or unrolled) file, so the size budget
            # always matches what is actually on disk.
            self._open_log()
        self._roll_after = 0 if rolled else self._file_bytes + self.max_bytes

    def _collapse_key(self, record: logging.LogRecord) -> tuple[str, int, str] | None:
        """Identity of a record for repeat collapsing, or None when it must be
        written as-is (exception or stack text, or an unrenderable message)."""
        if record.exc_info or record.exc_text or record.stack_info:
            return None
        try:
            message = record.getMessage()
        except Exception:
            return None
        return (record.name, record.levelno, message)

    def _emit(self, record: logging.LogRecord) -> bool:
        """Write one record, collapsing a run of identical messages."""
        key = self._collapse_key(record)
        if key is not None and key == self._last_key:
            self._repeats += 1
            return True
        succeeded = self._flush_repeats()
        if self._write(record):
            succeeded = True
        self._last_key = key
        self._last_record = record
        return succeeded

    def _flush_repeats(self) -> bool:
        """Write the "repeated N times" line for a collapsed run, if any."""
        if not self._repeats or self._last_record is None:
            return True
        last = self._last_record
        marker = logging.LogRecord(
            last.name, last.levelno, last.pathname, last.lineno,
            "previous message repeated %d more times", (self._repeats,), None,
        )
        self._repeats = 0
        return self._write(marker)

    def _report_pending(self) -> None:
        with self._lock:
            dropped = self.dropped
        errors = self.sink_errors
        if dropped == self.reported_drops and errors == self.reported_errors:
            return
        marker = logging.LogRecord(
            "flowmap_server.logging", logging.WARNING, __file__, 0,
            "Logging output recovered: dropped %d records (queue capacity %d, total %d); "
            "%d output/format errors since last report",
            (dropped - self.reported_drops, self.queue.maxsize, dropped,
             errors - self.reported_errors), None,
        )
        if self._write(marker):
            self.reported_drops = dropped
            self.reported_errors = errors

    def _run(self) -> None:
        try:
            if self.log_file:
                try:
                    # Preserve an empty configured log file even when level
                    # filtering admits no records; opening also stays off-loop.
                    self._open_log()
                except Exception:
                    self.sink_errors += 1
            while True:
                try:
                    record = self.queue.get(timeout=0.05)
                except queue.Empty:
                    if self._stopping.is_set():
                        break
                    continue
                try:
                    if self._emit(record):
                        self._report_pending()
                finally:
                    self.queue.task_done()
            self._flush_repeats()
            self._report_pending()
        finally:
            if self._file is not None:
                try:
                    self._file.close()
                except Exception:
                    self.sink_errors += 1
            self.finished.set()

    def stop(self, timeout: float = _SHUTDOWN_TIMEOUT) -> bool:
        """Stop admission; return whether the owned worker drained within timeout.

        An Event avoids QueueListener's full-queue sentinel failure. A later
        call may wait again for a previously blocked worker to finish.
        """
        with self._lock:
            self._stopping.set()
        self.thread.join(max(0.0, timeout))
        return self.finished.is_set()


def configure_logging(level: str = "info", log_file: str | None = None) -> LogOutput:
    """Configure root and Uvicorn once; preserve other named loggers' settings.

    Uvicorn must be started with log_config=None so its dictConfig cannot put
    synchronous handlers back on the access/error path.
    """
    global _state
    with _configuration_lock:
        if _state is not None:
            if not _state._stopping.is_set():
                return _state
            if not _state.finished.is_set():
                raise RuntimeError("Previous logging output is still draining")
            _state.handler.close()
            _state = None
        numeric_level = logging.getLevelNamesMapping().get(level.upper())
        if numeric_level is None:
            raise ValueError(f"Unknown logging level: {level!r}")
        _ensure_utf8(sys.stderr)
        _ensure_utf8(sys.stdout)
        output = LogOutput(sys.stderr, log_file, _QUEUE_CAPACITY)
        for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access"):
            logger = logging.getLogger(name)
            output.saved.append((logger, logger.handlers[:], logger.level,
                                 logger.propagate, logger.disabled))
            logger.handlers = [output.handler]
            logger.setLevel(numeric_level)
            logger.propagate = False
            logger.disabled = False
        output.thread.start()
        _state = output
        return output


def shutdown_logging(timeout: float = _SHUTDOWN_TIMEOUT) -> bool:
    """Restore borrowed logger state and wait for the owned output to drain."""
    global _state
    with _configuration_lock:
        output = _state
        if output is None:
            return True
        for logger, handlers, level, propagate, disabled in output.saved:
            logger.handlers = handlers
            logger.setLevel(level)
            logger.propagate = propagate
            logger.disabled = disabled
        # Retain a timed-out worker until drained; reconfiguration must not
        # start a second writer while the first still owns the file/stream.
        drained = output.stop(timeout)
        if drained:
            output.handler.close()
            _state = None
        return drained


atexit.register(shutdown_logging)
