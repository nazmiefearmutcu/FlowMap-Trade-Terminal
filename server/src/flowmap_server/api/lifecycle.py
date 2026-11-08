"""Process-lifetime hooks for the sidecar.

``FLOWMAP_EXIT_ON_STDIN_EOF=1`` is set by the desktop shell, which holds the
write end of the sidecar's stdin pipe. When the shell exits, or dies, the pipe
closes. EOF is the signal to stop through uvicorn's normal path, so the
lifespan flush runs before the process exits (on Windows, and for macOS orphan
protection) instead of being killed after the shell's grace period.
"""

from __future__ import annotations

import signal
import threading
from collections.abc import Callable
from typing import IO

__all__ = ["request_shutdown", "watch_stdin_eof"]


def request_shutdown() -> None:
    """Ask uvicorn to stop gracefully.

    uvicorn installs handlers for SIGINT and SIGTERM while it serves; the
    SIGTERM handler sets ``should_exit``, the lifespan shutdown then runs, and
    uvicorn re-raises the signal with the default handler once it has exited.
    """
    signal.raise_signal(signal.SIGTERM)


def watch_stdin_eof(stream: IO | None, on_eof: Callable[[], None]) -> threading.Thread | None:
    """Call ``on_eof`` once ``stream`` reaches end-of-file (or the pipe breaks).

    Runs on a daemon thread so a blocked read never holds the process open.
    Returns ``None`` when there is no stream to watch (no console and no
    redirected stdin), so such a launch is never shut down by mistake.
    """
    if stream is None:
        return None
    raw = getattr(stream, "buffer", stream)  # bytes: no text-decoding failures

    def _watch() -> None:
        try:
            while raw.read(1024):
                pass
        except (OSError, ValueError):
            pass  # a broken pipe is the same signal as EOF
        on_eof()

    thread = threading.Thread(target=_watch, name="flowmap-stdin-eof", daemon=True)
    thread.start()
    return thread
