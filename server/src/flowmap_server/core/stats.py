"""Server-side operational statistics producer.

Every drop/restart counter the server already maintained was write-only:
:class:`~flowmap_server.feeds.base.BoundedFeedQueue.dropped`,
``_BridgeSink.dropped_ts``, the ``ClientTx`` lag drops, feed restarts and
recording flush failures all happened silently. :class:`SessionStats` is the
single aggregate they feed, mounted as ``SessionManager.stats``; the API layer
surfaces ``stats.snapshot()`` verbatim (``/api/health`` v3) and the WS layer
feeds per-connection measurements through the hooks.

The snapshot shape is a stable wire contract: clients render it verbatim, so it
must not be reshaped::

    {
        "drops":       {"feed": int, "tx_lag": int, "snapshot": int},
        "restarts":    int,
        "sessions":    {"active": int, "rejected": int},
        "latency_ms":  float,          # EMA over measured connection RTT/2
        "staleness_ms": {key: float},  # per session, see below
        "clock_skew_ms": float,        # latest client-minus-server wall skew
        "recording":   {"enabled": bool, "flush_failures": int,
                        "last_flush_ts": int | None},
        "feeds":       {"poll_failures": int, "markers_dropped": int,
                        "quotes_dropped": int, "collectors": {name: str}},
    }

Additive fields: ``recording`` gains
``dropped_rows`` and ``wedged``, the top-level ``feeds`` block carries the
producer counters the feeds layer reports into, and ``orphaned_work`` counts
worker threads that outlived their request. Existing keys are unchanged.

Counter semantics (where each number comes from):

- ``drops.feed`` — drop-OLDEST evictions from the bounded connector->consumer
  fan-in queues (:class:`BoundedFeedQueue`): a stalled session consumer
  discarding live events.
- ``drops.tx_lag`` — whole finalized columns dropped oldest-first from a
  client send queue once their unsent age exceeded the lag bound
  (``ClientTx._evict_lagged``); counted per COLUMN (a depth+bar pair sharing
  ``t0_ns`` counts once), exactly what the gap Markers tell the client.
- ``drops.snapshot`` — live-ingest records discarded by the venue timestamp
  sanity gate (``_BridgeSink.dropped_ts`` / ``_EquitySink.dropped_ts``):
  implausible venue stamps (ms-in-ns, pre-2010, >24 h in the future).
- ``restarts`` — feed crash restarts (the exponential-backoff loop in
  ``Session.run``).
- ``sessions.active`` — live callback into the manager's session table;
  ``sessions.rejected`` — subscribes refused (session limit, replay
  unavailable/stale, invalid symbol).
- ``latency_ms`` — EMA (alpha 0.25, first sample seeds) of the WS-measured
  round-trip half-delay fed via :meth:`record_rtt`.
- ``staleness_ms`` — a DICT keyed by session id: age (wall-clock ms) of the
  last feed event arrival per active session. A session that has not received
  any event yet ages from its creation — a feed that died silently shows a
  growing age instead of looking fresh. Entries are removed when the session
  leaves the manager's table.
- ``clock_skew_ms`` — latest ``client_wall_ns - server_wall_ns`` measurement
  (positive = client ahead); latest-wins because re-subscribes legitimately
  reset it.
- ``recording.enabled`` — true while any active session has an open session
  recorder; ``flush_failures`` — Parquet write failures (transient disk/AV
  conditions, retried with backoff by the session); ``last_flush_ts`` — wall
  ns of the most recent successful recording flush.
- ``trades.out_of_interval`` (additive) — trades stamped
  outside the grid interval they were folded into, summed over the live
  sessions' grids. They stay in the bar, so this counts venue clock or ordering
  trouble; it is not lost volume.

Threading: every mutator runs on the event-loop thread (counters are plain
int increments, no locks on the hot path). ``snapshot()`` may be called from
a worker thread (the health handler runs in the FastAPI threadpool), so the
staleness dict is copied defensively — a dict growing during iteration is
retried rather than raced.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

__all__ = ["SessionStats"]

logger = logging.getLogger(__name__)

Clock = Callable[[], int]  # monotonic or wall ns

# EMA smoothing for the connection RTT. 0.25 ≈ a ~4-ping memory: responsive
# enough to catch a latency regression, smooth enough that one slow pong (AV
# scan, GC pause) does not dominate the headline number.
_RTT_EMA_ALPHA = 0.25


class SessionStats:
    """Aggregate server telemetry; mounted as ``SessionManager.stats``."""

    def __init__(
        self,
        *,
        clock: Clock = time.monotonic_ns,
        wall_clock: Clock = time.time_ns,
        active_sessions: Callable[[], int] | None = None,
    ) -> None:
        self._clock = clock
        self._wall_clock = wall_clock
        self._active_fn = active_sessions

        self._drops_feed = 0
        self._drops_tx_lag = 0
        self._drops_snapshot = 0
        self._restarts = 0
        self._rejected = 0
        self._flush_failures = 0
        self._flush_stalls = 0
        self._orphaned_work = 0

        self._latency_ms = 0.0
        self._clock_skew_ms = 0.0
        self._has_rtt = False

        # Per-session liveness: key -> last-event wall ns (and creation wall
        # ns for sessions that have not seen an event yet).
        self._last_sample_ns: dict[str, int] = {}
        self._started_ns: dict[str, int] = {}
        # Session ids with an open session recorder.
        self._recording: set[str] = set()
        self._last_flush_ts: int | None = None
        # Per recording session: wall ns of its last sign of life (opening, a
        # successful flush, or an idle heartbeat from its cadence check). The
        # stalled flag reads these per session, so a healthy quiet symbol
        # cannot hide a wedged writer on another one.
        self._healthy_ts: dict[str, int] = {}
        # Per recording session: the recorder's refused-row total (its
        # ``dropped_rows`` map summed), and the sessions whose in-flight write
        # is currently wedged (stalled past the watchdog, not yet landed).
        self._rec_dropped: dict[str, int] = {}
        self._wedged: set[str] = set()
        # Per session: the grid's out-of-interval trade total (running count).
        self._out_of_interval: dict[str, int] = {}
        # Feed-layer producer counters: the feeds report into these.
        self._poll_failures = 0
        self._markers_dropped = 0
        self._quotes_dropped = 0
        self._collectors: dict[str, str] = {}

    # -- counter increments (hot path: plain int adds) -------------------------

    def inc_feed_drops(self, n: int = 1) -> None:
        self._drops_feed += n

    def inc_tx_lag_drops(self, n: int = 1) -> None:
        self._drops_tx_lag += n

    def inc_snapshot_drops(self, n: int = 1) -> None:
        self._drops_snapshot += n

    def inc_restart(self) -> None:
        self._restarts += 1

    def inc_rejected(self) -> None:
        self._rejected += 1

    def inc_flush_failure(self) -> None:
        self._flush_failures += 1

    def inc_orphaned_work(self, n: int = 1) -> None:
        """A worker thread outlived the request that awaited it (see ``orphaned_work``)."""
        self._orphaned_work += n

    def inc_poll_failures(self, n: int = 1) -> None:
        """A keyless/keyed price poll failed (EquityFeed.poll_failures)."""
        self._poll_failures += n

    def inc_markers_dropped(self, n: int = 1) -> None:
        """A gap/session marker was discarded by a full bounded queue."""
        self._markers_dropped += n

    def inc_quotes_dropped(self, n: int = 1) -> None:
        """A live quote was discarded by the equity sink (venue stamp or overflow)."""
        self._quotes_dropped += n

    def note_collector_status(self, name: str, status: str) -> None:
        """Latest ``last_status`` of a background collector (macro, flows, ...)."""
        self._collectors[str(name)] = str(status)

    # -- per-connection measurement hooks (fed by the WS layer) ----------------

    def record_rtt(self, latency_ms: float) -> None:
        """Feed one measured connection round-trip half-delay (ms)."""
        ms = float(latency_ms)
        if ms != ms or ms in (float("inf"), float("-inf")) or ms < 0.0:
            return  # never let a hostile measurement poison the EMA
        if self._has_rtt:
            self._latency_ms += _RTT_EMA_ALPHA * (ms - self._latency_ms)
        else:
            self._latency_ms = ms
            self._has_rtt = True

    def record_clock_skew(self, skew_ms: float) -> None:
        """Feed the latest client-minus-server wall-clock skew (ms)."""
        ms = float(skew_ms)
        if ms != ms or ms in (float("inf"), float("-inf")):
            return
        self._clock_skew_ms = ms

    # -- session liveness -------------------------------------------------------

    def note_session(self, key: str) -> None:
        """Register a session for staleness tracking (at creation)."""
        self._started_ns[key] = self._wall_clock()
        self._last_sample_ns.pop(key, None)

    def forget_session(self, key: str) -> None:
        """Drop a session's staleness and recording entries (it left the manager's table)."""
        self._started_ns.pop(key, None)
        self._last_sample_ns.pop(key, None)
        self._recording.discard(key)
        self._healthy_ts.pop(key, None)
        self._rec_dropped.pop(key, None)
        self._wedged.discard(key)
        self._out_of_interval.pop(key, None)

    def note_live_sample(self, key: str) -> None:
        """Record a feed-event arrival for *key* (called per consumed event)."""
        self._last_sample_ns[key] = self._wall_clock()

    # -- recording --------------------------------------------------------------

    def note_recording(self, key: str, enabled: bool) -> None:
        if enabled:
            self._recording.add(key)
            # Opening is the first sign of life. A writer that never flushes or
            # heartbeats after this is a stall, not an unknown.
            self._healthy_ts.setdefault(key, self._wall_clock())
        else:
            self._recording.discard(key)
            self._healthy_ts.pop(key, None)

    def note_flush(self, key: str | None = None) -> None:
        """Record a successful recording flush (wall-clock stamped).

        ``key`` is the flushing session; without it only the global
        ``last_flush_ts`` moves and that session's stalled check is unchanged."""
        now = self._wall_clock()
        self._last_flush_ts = now
        if key is not None:
            self._healthy_ts[key] = now

    def note_recording_idle(self, key: str) -> None:
        """Heartbeat: session *key*'s open recorder found nothing to write and no
        write in flight.

        A quiet symbol buffers no rows, so no flush can land. Without this
        heartbeat the stalled flag would read a healthy idle writer as wedged."""
        self._healthy_ts[key] = self._wall_clock()

    def note_flush_stall(self, key: str | None = None) -> None:
        """Count a WEDGED recording flush (see ``_REC_STALL_S`` in session.py).

        A stall (an in-flight flush task that never completes) is the only
        silent recording-stop path; this counter + the snapshot's
        ``last_flush_age_s``/``stalled`` fields surface it on /api/health.
        ``key`` marks that session's writer as wedged until it clears."""
        self._flush_stalls += 1
        if key is not None:
            self._wedged.add(key)

    def clear_flush_wedged(self, key: str) -> None:
        """Session *key* has no write in flight any more: it is no longer wedged."""
        self._wedged.discard(key)

    def note_recording_dropped(self, key: str, total: int) -> None:
        """Latest refused-row total of session *key*'s recorder (its running count)."""
        self._rec_dropped[key] = max(0, int(total))

    def note_out_of_interval(self, key: str, total: int) -> None:
        """Latest out-of-interval trade total of session *key*'s grid (its running count)."""
        self._out_of_interval[key] = max(0, int(total))

    # -- snapshot -----------------------------------

    def snapshot(self) -> dict[str, object]:
        """The snapshot dict; rendered verbatim by ``/api/health``."""
        now = self._wall_clock()
        try:
            started = dict(self._started_ns)
            last = dict(self._last_sample_ns)
        except RuntimeError:  # pragma: no cover — dict mutated mid-copy
            started = {k: self._started_ns[k] for k in list(self._started_ns)}
            last = {k: self._last_sample_ns[k] for k in list(self._last_sample_ns)}
        staleness = {
            key: round((now - last.get(key, birth)) / 1e6, 1)
            for key, birth in started.items()
        }
        active = self._active_fn() if self._active_fn is not None else len(started)
        # A writer is healthy while it flushes OR reports idle at each cadence
        # check. Only a silent writer (no flush, no heartbeat for 60 s) stalls,
        # judged per open recorder. snapshot() may run on a worker thread.
        healthy = dict(self._healthy_ts)
        stalled = any(
            (now - healthy[key]) / 1e9 > 60.0
            for key in tuple(self._recording)
            if key in healthy
        )
        return {
            "drops": {
                "feed": self._drops_feed,
                "tx_lag": self._drops_tx_lag,
                "snapshot": self._drops_snapshot,
            },
            "restarts": self._restarts,
            "sessions": {"active": active, "rejected": self._rejected},
            "latency_ms": round(self._latency_ms, 3),
            "staleness_ms": staleness,
            "clock_skew_ms": round(self._clock_skew_ms, 3),
            "recording": {
                "enabled": bool(self._recording),
                "flush_failures": self._flush_failures,
                "last_flush_ts": self._last_flush_ts,
                "flush_stalls": self._flush_stalls,
                # Stall surfacing (2026-09-13): wall-clock age of the last
                # successful flush, and a coarse flag (>60 s with an open
                # recorder) so dashboards can see a wedged writer without
                # polling timestamps themselves.
                "last_flush_age_s": (
                    round((now - self._last_flush_ts) / 1e9, 1)
                    if self._last_flush_ts is not None
                    else None
                ),
                "stalled": bool(stalled),
                # Refused rows across the open recorders (buffer overflow) and
                # the count of writes currently wedged past the watchdog.
                "dropped_rows": sum(self._rec_dropped.values()),
                "wedged": len(self._wedged),
            },
            "trades": {
                "out_of_interval": sum(self._out_of_interval.values()),
            },
            # Worker threads (recorder open, overview steps) whose awaiting
            # request was cancelled or timed out. The thread cannot be stopped,
            # so it is counted until it finishes.
            "orphaned_work": self._orphaned_work,
            "feeds": {
                "poll_failures": self._poll_failures,
                "markers_dropped": self._markers_dropped,
                "quotes_dropped": self._quotes_dropped,
                "collectors": dict(self._collectors),
            },
        }
