"""Tunables, the timer protocol, the shared logger name and the Session error types."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Protocol

SESSION_LOGGER = "flowmap_server.core.session"


# --- Snapshot and history limits --------------------------------------------------
SNAPSHOT_COLS = 512  # last N finalized columns in the attach snapshot

SNAPSHOT_CHUNK_COLS = 64  # ≤N columns per snapshot frame

SNAPSHOT_TAPE = 500  # tape warm-up depth

HISTORY_MAX_COLS = 256  # per-HistoryRequest clamp

HISTORY_MAX_DISK_PARTS = 16  # one scroll-back page must not walk an entire recording

LAG_DROP_NS = 2_000_000_000  # oldest-unsent column age that triggers drops

NONCOL_CAP = 1000  # bounded non-column queue (latest-wins)

GRACE_S = 60.0  # teardown grace after last detach

FLUSH_INTERVAL_NS = 16_000_000  # forming-column refresh (~60 Hz; no fabricated ticks)

CAPABILITY_STATUS_INTERVAL_NS = 1_000_000_000

REC_FLUSH_COLS = 64  # recording flush cadence (finalized columns)

_BACKOFF_CAP_S = 30.0

# Recording flush-failure retry (cooldown with exponential backoff). One
# transient failure (disk full, AV scan lock, USB hiccup) must NOT permanently
# disable recording: the failed snapshot's rows are restored to the buffers and
# the next attempt waits base * 2**(consecutive_failures-1) seconds, capped.
# Success resets the ladder. Failures are counted in stats.flush_failures.
_REC_RETRY_BASE_S = 5.0

_REC_RETRY_CAP_S = 300.0

# Stall watchdog. A flush task that never completes (a hung thread inside the
# Parquet write or the retention walk) would make the task gate in
# `_flush_recording` return forever while the recording still reads as
# enabled. Past this bound the stall is reported loudly once per task (one
# log.error and stats.flush_stalls, so /api/health shows it), and the session
# publishes capability recording_health='wedged' with recording_degraded=true
# to its clients. The flag clears by itself when the stalled write lands.
#
# Policy (ratified): the writer is never replaced while its thread is alive,
# and recording is never disabled automatically. Abandoning a live write would
# drop its rows, and disabling recording would silently drop data the user
# chose to keep. Recovery is therefore signal-only: the wedge stays visible
# until the write completes.
_REC_STALL_S = 30.0

# Bound on every wait for admitted recording disk work (a Parquet part, the
# writer close or a retention walk). The work runs in a thread that cannot be
# interrupted, so an unbounded wait would turn one wedged write into a hung
# shutdown and a hung teardown. Past this the work is logged and
# abandoned, not waited on.
_REC_DRAIN_TIMEOUT_S = 10.0

# Hard bound on the whole server-shutdown flush (the lifespan's flush_all).
# It must stay above _REC_DRAIN_TIMEOUT_S, so one slow final flush finishes
# inside it. The desktop shell waits for the sidecar to exit for at least this
# long before it force-kills the process (see app/src-tauri GRACEFUL_STOP).
SHUTDOWN_FLUSH_DEADLINE_S = _REC_DRAIN_TIMEOUT_S + 1.0

# Bound on uvicorn's connection and task drain, which runs before the lifespan
# flush. Open sockets get their close in well under a second once the peer is
# told to stop, so this only cuts a stuck request short. Past it uvicorn ends
# what is still open and the flush starts. uvicorn pauses 0.1 s before this
# bound, so the drain takes at most about 0.6 s; with the flush that keeps the
# total inside the shell's 12 s grace (app/src-tauri GRACEFUL_STOP).
SERVER_DRAIN_BOUND_S = 0.5

# Bound on one overview step (a disk aggregate, a scalar part read or a batch
# of RAM columns). The step runs on the session's single overview thread, which
# cannot be interrupted, so past this the request is answered as unavailable
# and the session reports ``overview_degraded`` until a step completes again.
# Set well above a legitimate wide read over a long recording (about 85 s for
# the widest test read on a loaded machine), so only a stuck read trips it.
OVERVIEW_STEP_TIMEOUT_S = 300.0

# Consecutive in-memory append failures tolerated before recording is disabled
# for the session. A single bad row drops only itself.
_REC_APPEND_FAIL_LIMIT = 5

# Backoff resets to base only once a restarted feed proves stable: it has run
# for >=5 s (injectable clock) or delivered >=100 events, whichever first. A
# yield-one-then-crash flapper therefore keeps escalating to the 30 s cap.
_STABLE_NS = 5_000_000_000

_STABLE_EVENTS = 100

_MARKERS_CAP = 1024  # bounded marker memory for snapshot/history

_T_MAX = 2**63 - 1

# Parked-replay freshness policy: a re-attach to an EXISTING
# replay session re-validates the recording on disk. Growth past the
# session's tail by more than this much RECORDED time is "stale" — a replay
# feed can never serve columns recorded after the tail it was built from, so
# accepting would present an outdated replay as current. 2 s absorbs the
# one-column flush race (any dt) between the tail load and the attach.
REPLAY_STALE_TOL_NS = 2_000_000_000

# big_trades note: HistoryResponse.big_trades stays [] until a rolling-
# percentile large-lot threshold selects them; the wire field and this serving
# path are already in place.

Clock = Callable[[], int]  # monotonic ns


class TimerHandle(Protocol):
    def cancel(self) -> None: ...


Timer = Callable[[float, Callable[[], None]], TimerHandle]


def _default_timer(delay_s: float, cb: Callable[[], None]) -> TimerHandle:
    return asyncio.get_running_loop().call_later(delay_s, cb)


# --- manager --------------------------------------------------------------------


class SessionLimitError(RuntimeError):
    """Raised when a new session key would exceed ``Config.max_sessions``."""


class OverviewUnavailableError(RuntimeError):
    """An overview step did not finish within :data:`OVERVIEW_STEP_TIMEOUT_S`.

    The request is answered with an empty history page, not left pending: the
    worker thread is still running and is counted as orphaned work."""


class ReplayUnavailableError(RuntimeError):
    """Raised for ``mode='replay'`` subscriptions.

    This build has no replay engine: no feed reads a recording and the
    Seek/SetSpeed/Pause/Resume controls are not consumed. Refusing explicitly
    (instead of silently serving the LIVE feed under a replay label) is the
    honest behaviour — the client hides its Replay toggle unless a server
    advertises ``capability.replay``."""


class ReplayStaleError(ReplayUnavailableError):
    """Re-attach to an existing replay session whose recording moved on.

    A replay session's feed is a SNAPSHOT of the recording taken when the
    session was created; it can never serve columns recorded after its tail.
    When the on-disk recording has grown past that tail by more than
    :data:`REPLAY_STALE_TOL_NS`, a re-attach to the same key is refused
    instead of presenting the outdated replay as current.

    Subclasses :class:`ReplayUnavailableError` deliberately: the WS layer's
    existing honest-replay refusal (``Status{degraded}`` + close 1003) covers
    it with no new wiring, and the message carries the machine-checkable
    ``replay_stale`` token plus both tail positions."""
