"""Session lifecycle, subscriptions and per-client backpressure.

This module is the public face of the Session code. The implementation is
split by concern, and every name is re-exported here:

- ``session_core``: the :class:`Session` class (construction, run loop, feed
  consumption, status, teardown).
- ``session_boot``: boot work (overview prewarm, closed-history preparation,
  recording rehydration, backfill).
- ``session_recording``: the recording writer (buffers, cadence flushes, wedge
  detection, teardown, retention).
- ``session_fanout``: client attach and detach, snapshot frames, broadcast.
- ``session_book``: finalized and partial column emission from the feed.
- ``session_history``: history requests (overview, disk and in-memory).
- ``session_queue``: :class:`ClientTx`, the per-client bounded send queue.
- ``session_capability``: the capability a recording keeps and a replay reports.
- ``session_manager``: :class:`SessionManager`, band and source canonicalisation,
  subscription admission and replay construction.
- ``session_common``: tunables, the timer protocol, the logger name and the
  error types.

The load-bearing semantics:

- A :class:`Session` is one per ``(market, symbol, mode[, source])`` key. It
  owns the feed task and the :class:`~flowmap_server.core.grid.Grid`; send
  queues, lag and drop state are strictly per-client (:class:`ClientTx`).
- **Snapshot on attach**: ``Hello`` first, then an ``EpochStart`` for every
  distinct epoch present in the snapshot's columns (plus the current one,
  ascending), then the last columns (at most 512) finalized depth and bar
  columns, chunked into frames of at most 64 columns, then the Markers in that
  column range, then the last trades (at most 500, the tape warm-up), then the
  current BBO if known. All frames are pre-encoded bytes; a frame is the
  ``b"".join`` of its messages. History responses announce their epochs the
  same way.
- **Backpressure**: FINALIZED depth and bar column frames are never coalesced.
  PARTIAL right-edge re-emissions coalesce latest-wins per ``t0_ns``. When the
  oldest queued column has sat unsent for more than 2 s (injectable monotonic
  clock), whole columns are dropped oldest-first and ONE ``Marker{kind=gap}`` is
  enqueued per contiguous drop run. Runs merge across offers while the drop
  point stays adjacent to the previous run's marker. The marker count is real
  COLUMNS: the depth and bar pair sharing a ``t0_ns`` counts once, and dropped
  stale partials never count (their final frame may still be delivered). Dropped
  columns remain in the grid ring and stay recoverable via ``HistoryRequest``.
  Non-column messages (tape, BBO, markers, status) are capped at 1000 with silent
  drop-oldest, because latest-wins is acceptable for them.
- **Lifecycle**: sessions are refcounted by subscribers. Teardown fires after the
  last detach plus a 60 s grace (injectable timer). A crashed feed restarts with
  exponential backoff (cap 30 s), slept with FULL JITTER (a uniform draw from
  ``[0, backoff)``), so sessions of a venue that died together do not restart in
  lockstep. Transitions are reported via ``Status``. Other sessions are unaffected.
- **Recording and rehydration**: a live-mode session with a
  :class:`~flowmap_server.core.record.Recorder` self-records epoch parameters
  (initial and every re-anchor), every finalized column, trades and markers.
  Buffers flush every ``REC_FLUSH_COLS`` recorded columns or once the time-based
  cadence is reached (default 10 s), so a Windows hard close loses about one
  cadence, not a whole part. They also flush when the feed loop exits and on
  teardown. A successful flush is followed by retention, which runs at most once
  per minute of wall clock. Cadence writes and retention walks run in executor
  threads, and only one flush is in flight at a time. The teardown close stays
  synchronous, so data is on disk before the session dies. Recording failures
  never kill the feed loop. A failed cadence flush restores its rows and retries
  after a cooldown (exponential backoff, 5 s to 300 s). Before the feed task
  starts, ``start()`` rehydrates the grid ring from the newest recording via
  ``load_tail``, and a ``Marker{kind=gap}`` separates the recorded tail from live
  data. A stale, absent or unusable tail means a cold start.
- **Telemetry**: every drop, restart and flush-failure counter on this path feeds
  the shared :class:`~flowmap_server.core.stats.SessionStats` aggregate, mounted
  as ``SessionManager.stats``. Per-connection latency and skew reach Status
  broadcasts through the ``Session.conn_stats`` hook that the WS layer installs.
  All hooks are optional, so a bare ``Session`` behaves the same without them.

Everything is asyncio, single-threaded, with no locks. The only lock serializes
``start()``'s boot phase. Attach, snapshot and broadcast never await between
observing grid state and enqueueing, so per-client frame order is exactly
stream order.
"""

from flowmap_server.core.session_capability import recorded_capability, replayed_capability
from flowmap_server.core.session_common import (
    _REC_APPEND_FAIL_LIMIT,
    _REC_DRAIN_TIMEOUT_S,
    _REC_RETRY_BASE_S,
    _REC_STALL_S,
    CAPABILITY_STATUS_INTERVAL_NS,
    FLUSH_INTERVAL_NS,
    GRACE_S,
    HISTORY_MAX_COLS,
    LAG_DROP_NS,
    NONCOL_CAP,
    REC_FLUSH_COLS,
    REPLAY_STALE_TOL_NS,
    SESSION_LOGGER,
    SNAPSHOT_CHUNK_COLS,
    SNAPSHOT_COLS,
    SNAPSHOT_TAPE,
    ReplayStaleError,
    ReplayUnavailableError,
    SessionLimitError,
)
from flowmap_server.core.session_core import Session
from flowmap_server.core.session_manager import (
    BANDS,
    DEFAULT_BAND,
    KNOWN_SOURCES,
    SessionManager,
    _crypto_tick_auto,
    _crypto_tick_for,
    canonical_band,
    canonical_source,
)
from flowmap_server.core.session_queue import ClientTx

__all__ = [
    "BANDS",
    "CAPABILITY_STATUS_INTERVAL_NS",
    "DEFAULT_BAND",
    "FLUSH_INTERVAL_NS",
    "GRACE_S",
    "HISTORY_MAX_COLS",
    "KNOWN_SOURCES",
    "LAG_DROP_NS",
    "NONCOL_CAP",
    "REC_FLUSH_COLS",
    "REPLAY_STALE_TOL_NS",
    "SESSION_LOGGER",
    "SNAPSHOT_CHUNK_COLS",
    "SNAPSHOT_COLS",
    "SNAPSHOT_TAPE",
    "ClientTx",
    "ReplayStaleError",
    "ReplayUnavailableError",
    "Session",
    "SessionLimitError",
    "SessionManager",
    "_REC_APPEND_FAIL_LIMIT",
    "_REC_DRAIN_TIMEOUT_S",
    "_REC_RETRY_BASE_S",
    "_REC_STALL_S",
    "_crypto_tick_auto",
    "_crypto_tick_for",
    "canonical_band",
    "canonical_source",
    "recorded_capability",
    "replayed_capability",
]
