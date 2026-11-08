"""Recording writer for a Session: buffers, cadence flushes, wedge detection,
teardown and retention."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from flowmap_server.core.record import SessionRecorder
from flowmap_server.core.session_common import (
    _REC_APPEND_FAIL_LIMIT,
    _REC_DRAIN_TIMEOUT_S,
    _REC_RETRY_BASE_S,
    _REC_RETRY_CAP_S,
    _REC_STALL_S,
    REC_FLUSH_COLS,
    SESSION_LOGGER,
)

logger = logging.getLogger(SESSION_LOGGER)



class _RecordingWriteWedged(RuntimeError):
    """An admitted recording write did not finish within ``_REC_DRAIN_TIMEOUT_S``."""


def _recorder_dropped_rows(rec: object) -> int:
    """Total rows a :class:`SessionRecorder` refused (its ``dropped_rows`` map)."""
    dropped = getattr(rec, "dropped_rows", None)
    if not isinstance(dropped, dict):
        return 0
    return sum(int(v) for v in dropped.values())

class RecordingMixin:
    """Recording writer for a Session: buffered rows, cadence flushes,
    wedge detection, teardown and retention."""

    # -- recording (all wrapped: failures disable recording, never the feed) ---

    @property
    def _recording_identity(self) -> str | None:
        """Logical recording id this session reads and writes.

        Remembered for the session's lifetime, not only while the recorder is
        open: if recording is disabled after a transient error, overview and
        scroll-back must keep selecting the same on-disk timeline. Otherwise
        its recorded history silently drops out of both."""
        if self._rec is not None:
            return self._rec.recording_id
        return self._known_recording_id

    def _cols_flush_due(self) -> bool:
        """True when a full cadence of finalized columns is buffered."""
        return self._rec is not None and self._cols_since_flush >= REC_FLUSH_COLS

    def _recording_flush_due(self, now_ns: int) -> bool:
        """True when a cadence flush is due by column count or by elapsed time."""
        return self._cols_flush_due() or (
            self._rec is not None and now_ns - self._rec_cadence_ns >= self._rec_flush_interval_ns
        )

    def _record(self, op: Callable[[SessionRecorder], None]) -> None:
        if self._rec is None:
            return
        try:
            op(self._rec)
        except Exception:
            # Drop only the failing row. Recording is disabled after several
            # consecutive failures, not on the first one.
            self._rec_append_failures += 1
            if self._rec_append_failures < _REC_APPEND_FAIL_LIMIT:
                logger.exception(
                    "recording append failed; row dropped, recording kept for session %s "
                    "(%d consecutive failures)",
                    self.session_id,
                    self._rec_append_failures,
                )
                return
            logger.exception("recording failed; disabled for session %s", self.session_id)
            self._rec = None
            if self._stats is not None:
                self._stats.note_recording(self.session_id, False)
            return
        self._rec_append_failures = 0

    def _flush_recording(self) -> None:
        """Cadence flush (every REC_FLUSH_COLS recorded columns, or once the
        time-based cadence is reached): hand the current buffers to a
        background flush task.

        The Parquet write runs in a thread (``asyncio.to_thread``) — the
        synchronous write used to stall the event loop for the whole part
        write, every 64 columns, per session. Buffers are swapped out HERE,
        on the loop thread, so rows recorded while the thread writes stay in
        the live buffers and land in the next flush; only one flush may be
        in flight (a tick that arrives mid-write is picked up by the next
        cadence check), so snapshots can never race each other.

        After a flush FAILURE the retry waits out a cooldown (exponential
        backoff, see _REC_RETRY_*): rows keep buffering and nothing is lost,
        so a transient disk/AV hiccup costs a delayed part, not the recording."""
        if self._rec is None or self._closed:
            return
        if self._stats is not None:
            # Rows the recorder refused (buffer overflow) are counted on
            # the recorder; surface the running total on /api/health.
            self._stats.note_recording_dropped(self.session_id, _recorder_dropped_rows(self._rec))
        if self._rec_retry_at is not None and self._clock() < self._rec_retry_at:
            return  # cooldown after a failed flush: keep buffering, retry later
        if self._flush_task is not None and not self._flush_task.done():
            # Stall watchdog (see _REC_STALL_S): a hung task never completes,
            # so this gate would block every future flush silently. Report it
            # loudly once per task; health gets stats.flush_stalls and the
            # per-session wedged count while the write stays hung.
            started = self._flush_started_ns
            if started is not None and self._clock() - started >= int(_REC_STALL_S * 1e9):
                if not self._flush_stall_logged:
                    self._flush_stall_logged = True
                    logger.error(
                        "recording flush WEDGED for session %s (in flight %.1fs; "
                        "no part lands until it completes)",
                        self.session_id,
                        (self._clock() - started) / 1e9,
                    )
                    if self._stats is not None:
                        self._stats.note_flush_stall(self.session_id)
                    self._set_recording_wedged(True)
            return  # previous flush still writing; next cadence catches up
        if self._stats is not None:
            # No write in flight (it finished, or never stalled): not wedged.
            self._stats.clear_flush_wedged(self.session_id)
        self._set_recording_wedged(False)
        rec, bufs = self._rec, self._rec.take_buffers()
        if bufs is None:
            # Nothing to write and no write in flight: a healthy idle writer.
            # Heartbeat for the stalled flag (a quiet symbol is not a wedge).
            if self._stats is not None:
                self._stats.note_recording_idle(self.session_id)
            return
        self._flush_started_ns = self._clock()
        self._flush_stall_logged = False
        self._flush_task = asyncio.get_running_loop().create_task(
            self._flush_buffers_async(rec, bufs)
        )

    async def _flush_buffers_async(
        self, rec: SessionRecorder, bufs: tuple[list, list, list, list]
    ) -> None:
        """Write one buffer snapshot in a thread (see :meth:`_flush_recording`).

        ``rec`` is captured at snapshot time on purpose: if the session tears
        down while this task is queued, the snapshot still lands instead of
        being dropped (teardown's close() can no longer see those rows).

        On failure the rows are restored to the live buffers (they never
        landed on disk) and a cooldown is armed — recording is NOT disabled
        for the session on a transient IO failure anymore; only a failure of
        the restore itself (a broken recorder) still disables."""
        try:
            await asyncio.to_thread(rec.flush_buffers, bufs)
        except Exception:
            if self._stats is not None:
                self._stats.inc_flush_failure()
            self._rec_failures += 1
            delay_s = min(
                _REC_RETRY_BASE_S * 2.0 ** (self._rec_failures - 1),
                _REC_RETRY_CAP_S,
            )
            self._rec_retry_at = self._clock() + int(delay_s * 1e9)
            logger.exception(
                "recording flush failed; will retry in %.0fs for session %s "
                "(%d consecutive failures)",
                delay_s,
                self.session_id,
                self._rec_failures,
            )
            try:
                rec.restore_buffers(bufs)
            except Exception:
                logger.exception(
                    "recording buffer restore failed; disabled for session %s",
                    self.session_id,
                )
                self._rec = None
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, False)
            self._flush_started_ns = None
            self._flush_stall_logged = False
            if self._stats is not None:
                self._stats.clear_flush_wedged(self.session_id)
            return
        self._flush_started_ns = None
        self._flush_stall_logged = False
        self._rec_failures = 0
        self._rec_retry_at = None
        self._cols_since_flush = 0
        self._rec_cadence_ns = self._clock()
        # The write landed: a wedge is over now, not at the next column.
        self._set_recording_wedged(False)
        if self._stats is not None:
            self._stats.clear_flush_wedged(self.session_id)
            self._stats.note_flush(self.session_id)
        await self._enforce_retention_async()
        self._schedule_summary_work()

    async def flush_recording_now(self) -> None:
        """Serialize durable flushes with recorder retirement and shutdown."""
        async with self._recording_finish_lock:
            await self._flush_recording_now()

    async def _flush_recording_now(self) -> None:
        """Flush buffered recording rows and WAIT for the Parquet write.

        Runs on every run-loop exit and from the server-shutdown flush
        (:meth:`SessionManager.flush_all`): buffered columns/trades must be
        on disk before the session counts as ended — the restart
        rehydrates from these files. Awaits any in-flight cadence flush
        first, so two flushes can never touch the recorder concurrently.

        A failure here (shutdown path — no time to wait out a cooldown)
        counts, restores the rows so the teardown close() retries them, and
        leaves the recorder open: recording is not permanently disabled by a
        transient write error."""
        task, self._flush_task = self._flush_task, None
        if task is not None and not task.done():
            try:
                await self._drain_recording_work(task)
            except _RecordingWriteWedged:
                # The wedged write still owns its rows and the in-flight gate.
                # Stay behind that gate: a second snapshot would race its writer.
                self._flush_task = task
                return
            except asyncio.CancelledError:
                if not task.done():
                    self._flush_task = task
                raise
        self._flush_started_ns = None
        self._flush_stall_logged = False
        if self._rec is None:
            return
        bufs = self._rec.take_buffers()
        if bufs is None:
            return
        try:
            await self._drain_recording_work(asyncio.create_task(
                asyncio.to_thread(self._rec.flush_buffers, bufs)
            ))
        except asyncio.CancelledError:
            raise
        except _RecordingWriteWedged:
            # These rows went to a write that is still running. Restoring them
            # could write them twice if that thread lands later, so they are
            # abandoned and counted instead.
            if self._stats is not None:
                self._stats.inc_flush_failure()
            logger.error(
                "recording flush wedged at close; its rows are abandoned for session %s",
                self.session_id,
            )
            return
        except Exception:
            if self._stats is not None:
                self._stats.inc_flush_failure()
            logger.exception(
                "recording flush failed at close; rows restored for session %s",
                self.session_id,
            )
            try:
                self._rec.restore_buffers(bufs)
            except Exception:
                logger.exception(
                    "recording buffer restore failed; disabled for session %s",
                    self.session_id,
                )
                self._rec = None
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, False)
            return
        self._rec_failures = 0
        self._rec_retry_at = None
        self._cols_since_flush = 0
        self._rec_cadence_ns = self._clock()
        if self._stats is not None:
            self._stats.note_flush(self.session_id)
        await self._enforce_retention_async()
        self._schedule_summary_work()

    def _schedule_summary_work(self) -> None:
        """One coalesced worker; raw writes have already atomically landed.

        A concurrent flush never adds another conversion task. A later flush
        retries missed/new parts; every source part remains authoritative.
        """
        if self._closed or self._recorder_root is None:
            return
        if self._overview_prewarm_task is None or self._overview_prewarm_task.done():
            self._overview_prewarm_task = asyncio.create_task(
                self._prewarm_overview_index(), name=f"history-summary-{self.session_id}"
            )

    @staticmethod
    async def _drain_recording_work(task: asyncio.Task):
        """Wait for admitted disk work, bounded by ``_REC_DRAIN_TIMEOUT_S``.

        A thread-backed write cannot be stopped, so it is never cancelled here.
        ``asyncio.wait`` does not cancel what it waits on, which is why no
        shield is needed. A write still running at the bound is logged and
        reported as :class:`_RecordingWriteWedged`, so shutdown and teardown
        cannot hang on it. A cancelled caller gets one bounded grace
        period for the in-flight write, then sees its CancelledError. The
        cancellation is never absorbed."""
        try:
            done, _ = await asyncio.wait({task}, timeout=_REC_DRAIN_TIMEOUT_S)
        except asyncio.CancelledError:
            if not task.done():
                await asyncio.wait({task}, timeout=_REC_DRAIN_TIMEOUT_S)
                if not task.done():
                    logger.error(
                        "recording work still in flight %.0fs after cancellation; not waiting longer",
                        _REC_DRAIN_TIMEOUT_S,
                    )
            raise
        if not done:
            logger.error(
                "recording work wedged: still in flight after %.0fs; not waiting longer",
                _REC_DRAIN_TIMEOUT_S,
            )
            raise _RecordingWriteWedged(
                f"recording work still in flight after {_REC_DRAIN_TIMEOUT_S:.0f}s"
            )
        return task.result()

    async def _close_recording(self) -> None:
        # Boot can be retired before run_task exists but after a cadence write
        # started. Share ownership with run-finally and shutdown flush_all.
        await self.flush_recording_now()
        async with self._recording_finish_lock:
            await self._close_recording_locked()

    async def _close_recording_locked(self) -> None:
        if self._rec is None:
            return
        rec, self._rec = self._rec, None
        try:
            await self._drain_recording_work(asyncio.create_task(asyncio.to_thread(rec.close)))
        except Exception:
            logger.exception("recording close failed for session %s", self.session_id)
            if self._stats is not None:
                self._stats.note_recording(self.session_id, False)
            return
        if self._stats is not None:
            self._stats.note_recording(self.session_id, False)
        await self._enforce_retention_async()

    async def _finish_recording_teardown(self) -> None:
        # The cancelled feed's finally owns the in-flight cadence write and
        # buffered final flush. Do not close its writer while that work runs.
        if self.run_task is not None and not self.run_task.done():
            try:
                await self._drain_recording_work(self.run_task)
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("feed exit failed during recording teardown")
        await self._close_recording()

    async def _enforce_retention_async(self) -> None:
        """Off-loop retention walk, gated by a wall-clock min-interval.

        The rglob/stat pass over the whole recording root used to run after
        EVERY cadence flush (~every 16 s per active session — continuous disk
        churn over a tree whose cap moves at GB scales). It now runs at most
        once per ``retention_min_interval_s`` (default 60, env-tunable; 0
        restores the walk-after-every-flush behavior), still in an executor
        thread; concurrent walks serialize inside
        ``Recorder.enforce_retention``."""
        if self._recorder_root is None:
            return
        now = self._clock()
        if (
            self._retention_min_interval_ns > 0
            and self._last_retention_ns is not None
            and now - self._last_retention_ns < self._retention_min_interval_ns
        ):
            return
        self._last_retention_ns = now
        try:
            # Bounded like every other admitted disk work: this walk runs on
            # the shutdown and teardown path, where an unbounded wait would
            # hold up flush_all.
            await self._drain_recording_work(
                asyncio.create_task(asyncio.to_thread(self._recorder_root.enforce_retention))
            )
        except Exception:
            logger.exception("recording retention enforcement failed")

    def _set_recording_wedged(self, wedged: bool) -> None:
        """Record a recording-writer wedge and tell attached clients at once.

        The flag is signal-only: it clears when the stalled write completes and
        never disables recording (see ``_REC_STALL_S``). A client attaching
        later gets it in its Hello.
        """
        if wedged == self._recording_wedged:
            return
        self._recording_wedged = wedged
        if self._clients:
            self._publish_status()
