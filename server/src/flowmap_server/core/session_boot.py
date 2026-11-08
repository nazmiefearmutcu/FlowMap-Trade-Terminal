"""Session boot work: overview prewarm, closed-history preparation, rehydration and backfill."""

from __future__ import annotations

import asyncio
import logging
import math

import msgspec

from flowmap_server.core.backfill import (
    columns_from_candles,
)
from flowmap_server.core.pyramid import pyramid_for
from flowmap_server.core.record import SessionRecorder, TailData
from flowmap_server.core.session_capability import recorded_capability
from flowmap_server.core.session_common import SESSION_LOGGER, SNAPSHOT_COLS
from flowmap_server.feeds.base import BarSample, BookState
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.proto import events

logger = logging.getLogger(SESSION_LOGGER)

# Closes of recorders whose boot was abandoned. Held here so the tasks are not
# garbage-collected before the writer is closed.
_ORPHAN_CLOSES: set[asyncio.Task] = set()


async def _close_orphaned_recorder(rec: SessionRecorder) -> None:
    """Close a recorder whose subscribe gave up, off the event loop."""
    try:
        await asyncio.to_thread(rec.close)
    except Exception:
        logger.exception("orphaned recorder close failed")


class BootMixin:
    """Boot-time work for a Session: overview prewarm, closed-history
    preparation, recording rehydration and backfill."""

    async def _prewarm_overview_index(self) -> None:
        # First live paint takes precedence. Only tiny scalar part metadata is
        # warmed later; no density scans or awaiting in subscribe/start.
        await asyncio.sleep(2.0)
        if self._closed or self._recorder_root is None:
            return
        try:
            store = await asyncio.to_thread(
                pyramid_for,
                self._recorder_root,
                self._feed.market,
                self._feed.symbol,
                self._recording_identity,
            )
            await asyncio.to_thread(
                store.prepare,
                dict(self._grid._epoch_params),
                list(self._legacy_history_segments),
                stop=lambda: self._closed,
            )
        except Exception:
            logger.exception(
                "optional overview index warmup failed for session %s", self.session_id
            )

    async def _boot(self) -> None:
        """Open the session recorder, rehydrate or backfill the grid.

        Any failure here is logged and degrades to a cold start (recording
        disabled on a recorder error) — never propagated into subscribe/attach.
        Precedence: a fresh Parquet tail wins; only a cold ring (no tail) is
        seeded from the first-launch candle backfill.
        """
        tail_applied = False
        if self._recorder_root is not None:
            try:
                rec, tail = await self._run_boot_blocking()
            except Exception:
                logger.exception(
                    "recording boot failed; recording disabled for session %s",
                    self.session_id,
                )
            else:
                if self._closed:
                    # Torn down while the writer was opening (grace expiry or a
                    # band replacement during boot). Teardown saw no recorder
                    # to close, so nothing else will close this one: close it
                    # here instead of attaching it to a dead session.
                    try:
                        await asyncio.to_thread(rec.close)
                    except Exception:
                        logger.exception(
                            "recorder close after teardown during boot failed for session %s",
                            self.session_id,
                        )
                    return
                self._rec = rec
                self._known_recording_id = rec.recording_id
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, True)
                if tail is not None:
                    # _apply_tail reports success: a tail that failed preload
                    # (grid shape changed, corrupt arrays) leaves the ring
                    # genuinely virgin, so the candle backfill below must run
                    # — otherwise the session gets NO history at all even
                    # though both sources were available.
                    tail_applied = self._apply_tail(tail)

        # Backfill only a genuinely cold ring — never on top of a rehydrated tail
        # (the grid is no longer virgin; preload would raise).
        if not tail_applied:
            await self._run_backfill()

        await self._prepare_closed_history()

        # Initial epoch params (cold: epoch 0; rehydrated/backfilled: the
        # seeded current epoch — duplicates across part files are fine, load
        # dedups by key). No-op without a recorder.
        params = self._grid.current_epoch_params()
        self._record(lambda r: r.record_epoch(params))

    async def _run_boot_blocking(self) -> tuple[SessionRecorder, TailData | None]:
        """Run :meth:`_boot_blocking` in the executor for the awaiting subscribe.

        The worker cannot be interrupted. A subscribe that is cancelled (its
        deadline, or the peer leaving) therefore abandons the open, and the
        recorder it returns would have no owner. The shield keeps the result
        reachable, and :meth:`_adopt_orphaned_boot` closes it once it lands.
        """
        future = asyncio.get_running_loop().run_in_executor(None, self._boot_blocking)
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # Adopted even when the open has already landed: its recorder still
            # needs a closer, and the done callback runs at once in that case.
            self._adopt_orphaned_boot(future)
            raise

    def _adopt_orphaned_boot(self, future: asyncio.Future) -> None:
        """Count an abandoned boot and close its recorder when the open lands."""
        logger.error(
            "recording boot abandoned for session %s; its writer is closed once the open completes",
            self.session_id,
        )
        if self._stats is not None:
            self._stats.inc_orphaned_work()

        def closed(done: asyncio.Future) -> None:
            if done.cancelled() or done.exception() is not None:
                return
            rec, _tail = done.result()
            task = asyncio.ensure_future(_close_orphaned_recorder(rec))
            _ORPHAN_CLOSES.add(task)
            task.add_done_callback(_ORPHAN_CLOSES.discard)

        future.add_done_callback(closed)

    async def _prepare_closed_history(self) -> None:
        if not (
            isinstance(self._feed, EquityFeed)
            and self._feed.tier == "keyless"
            and self._feed.is_closed_now()
        ):
            return
        # Closed warmup is a finite boot operation. During a retry existing
        # subscribers keep their old frame until a single bounded replacement
        # snapshot is ready; no historical packet flood enters their outboxes.
        self._preparing_closed_history = True
        try:
            try:
                initial_epoch = self._grid.current_epoch_params()
                self._record(lambda r: r.record_epoch(initial_epoch))
                async for ev in self._feed.closed_history_events():
                    if isinstance(ev, BookState):
                        if ev.ts_ns >= self._equity_warmup_before_ns:
                            self._on_book(ev)
                    elif isinstance(ev, BarSample):
                        if ev.ts_ns >= self._equity_warmup_before_ns:
                            self._grid.on_bar_sample(ev.ts_ns, ev.o, ev.h, ev.l, ev.c, ev.volume)
                            self._equity_warmup_before_ns = ev.ts_ns + 1
                    elif isinstance(ev, events.Marker):
                        self._markers.append(ev)
                        self._record(lambda r, m=ev: r.record_marker(m))
                self._emit_closed_if_needed()
                self._closed_history_prepared = True
            except Exception:
                # Closed-market warmup is an enhancement. A provider failure
                # degrades to a cold start and must not fail the subscribe
                # The session still serves its closed-market frame.
                logger.exception(
                    "closed-market history warmup failed; cold start for session %s",
                    self.session_id,
                )
        finally:
            self._preparing_closed_history = False
        # Existing clients (a second subscriber can trigger recovery) need the
        # same protected attach snapshot, with epoch parameters before bars.
        if self._clients:
            frames = self._snapshot_frames()
            for client in self._clients:
                for frame in frames:
                    client.offer(frame, col_msg=False, protected=True)

    async def _run_backfill(self) -> None:
        """Seed the ring with reconstructed candle history.

        Behind the injectable ``backfill_fn`` seam (pytest feeds canned candles;
        no network). Any failure degrades cleanly to cold start. Reconstructed
        columns are seeded but NOT recorded — only live columns persist to
        Parquet. On success, marks the session so Hello/Status advertise
        ``history: 'reconstructed'`` and emits a gap Marker to live.
        """
        if self._backfill_fn is None or self._backfill_max_cols <= 0:
            return
        # Banded geometry cannot consume candle backfill (converter contract).
        # Avoid blocking the first live quote on a network fetch we discard.
        if self._grid.cfg.band_up is not None or self._grid.cfg.band_down is not None:
            return
        try:
            candles = await self._backfill_fn(
                self._feed.market,
                self._feed.symbol,
                max_cols=self._backfill_max_cols,
                now_ns=self._wall_clock(),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "backfill fetch failed; cold start for session %s",
                self.session_id,
                exc_info=True,
            )
            return
        if not candles:
            return
        try:
            result = columns_from_candles(candles, self._grid.cfg, stretch=self._backfill_stretch)
            if result is None:
                return
            columns, epoch = result
            self._grid.preload(columns, [epoch])
        except Exception:
            logger.warning(
                "backfill conversion/preload failed; cold start for session %s",
                self.session_id,
                exc_info=True,
            )
            return
        self._history_reconstructed = True
        dt = self._grid.cfg.dt_ns
        end_ns = columns[-1].t0_ns + dt
        if isinstance(self._feed, EquityFeed) and self._feed.tier == "keyless":
            self._equity_warmup_before_ns = end_ns
        gap = events.Marker(
            ts_ns=end_ns - 1,
            kind="gap",
            text=(
                f"backfill: reconstructed history ends {end_ns}, live resumes ~{self._wall_clock()}"
            ),
        )
        self._markers.append(gap)
        # Record the gap marker (live provenance) but NOT the reconstructed
        # columns — only genuine live columns should persist for rehydration.
        self._record(lambda r: r.record_marker(gap))
        logger.info(
            "session %s backfilled %d reconstructed columns (t0 %d..%d)",
            self.session_id,
            len(columns),
            columns[0].t0_ns,
            columns[-1].t0_ns,
        )

    def _capability(self) -> dict[str, object]:
        """Feed capability, plus server-level badges: ``history:
        'reconstructed'`` when the ring was seeded from candle backfill, and
        ``replay: True`` — this build serves the replay engine, and the client
        gates its Replay toggle on that flag
        independent of the mode it is currently subscribed to.

        Always returns a fresh dict (never the feed's own object): the badges
        must not leak back into the feed descriptor."""
        cap: dict[str, object] = dict(self._feed.capability)
        cap["replay"] = True
        if isinstance(self._feed, ReplayFeed):
            cap["playback"] = self._feed.playback()
        if self._history_reconstructed:
            cap["history"] = "reconstructed"
        if self._recorder_root is not None:
            cap["retention"] = dict(self._recorder_root.retention_status)
        if self._recording_wedged:
            cap["recording_health"] = "wedged"
            cap["recording_degraded"] = True
        if self._overview_degraded:
            cap["overview_degraded"] = True
        return cap

    def _boot_blocking(self) -> tuple[SessionRecorder, TailData | None]:
        """Blocking recorder IO for :meth:`_boot` (runs in the executor)."""
        assert self._recorder_root is not None
        market, symbol = self._feed.market, self._feed.symbol
        rec = self._recorder_root.open_session(
            market, symbol, capability=recorded_capability(self._feed.capability)
        )
        cfg = self._grid.cfg
        tail = self._recorder_root.load_tail(
            market,
            symbol,
            max_age_ns=cfg.ring_columns * cfg.dt_ns,
            now_ns=self._wall_clock(),
            # Boot needs only the same active tail sent in the first attach.
            # Eagerly decoding/packing an entire 32k ring delays the first
            # live book and materializes a much larger, discarded tape. Keep
            # ring capacity/freshness unchanged; older genuine history pages
            # and overviews read the validated recording UUID on demand.
            limit_cols=min(cfg.ring_columns, SNAPSHOT_COLS),
        )
        return rec, tail

    def _apply_tail(self, tail: TailData) -> bool:
        """Seed grid/tape/markers from a recorded tail + emit the gap Marker.

        Returns True only when the grid actually took the tail; a False return
        (unusable recording) leaves the grid virgin so the caller still runs
        the candle backfill."""
        if (
            isinstance(self._feed, EquityFeed)
            and self._feed.tier == "keyless"
            and self._feed.capability.get("depth") == "SYNTH"
            and tail.columns
            and not any(math.isfinite(col.bar.c) and col.bar.c > 0.0 for col in tail.columns)
        ):
            # Old keyless recordings contain synthetic density but no sampled
            # prices. Regenerate that derived view, retaining the old files and
            # the new recorder UUID so restarted seq 0 cannot collide with it.
            logger.info("legacy equity tail has no price bars; rebuilding %s", self.session_id)
            return False
        try:
            self._grid.preload(tail.columns, tail.epochs)
        except Exception:
            # Unusable tail (e.g. grid shape changed between runs):
            # says cold start — never fail the session over it.
            logger.exception(
                "rehydration preload failed; cold start for session %s",
                self.session_id,
            )
            return False
        if tail.recording_id and self._rec is not None:
            # A validated warm restart continues this logical recording. Its
            # true timestamps may have a restart seam while col_seq continues.
            self._rec.recording_id = tail.recording_id
            self._known_recording_id = tail.recording_id
        elif not tail.recording_id:
            segments: list[tuple[int, int, int]] = []
            for col in tail.columns:
                origin = col.t0_ns - col.col_seq * self._grid.cfg.dt_ns
                if segments and segments[-1][0] == origin:
                    segments[-1] = (origin, segments[-1][1], col.col_seq)
                else:
                    segments.append((origin, 0 if not segments else col.col_seq, col.col_seq))
            self._legacy_history_segments = segments[-16:]
        # Recordings do not store the wire seq, so rehydrated prints are numbered
        # here, in order, before any live trade. A reconnect inside the grace
        # window re-delivers this tape, and the client drops repeats by seq.
        self._tape.extend(
            msgspec.structs.replace(trade, seq=self._next_trade_seq()) for trade in tail.trades
        )
        self._markers.extend(tail.markers)
        dt = self._grid.cfg.dt_ns
        end_ns = tail.newest_t0_ns + dt
        if isinstance(self._feed, EquityFeed) and self._feed.tier == "keyless":
            self._equity_warmup_before_ns = end_ns
        # ts is the last ns of the recorded range so the marker is inside the
        # snapshot's [first_t0, last_t0+dt) marker window from the very first
        # attach (live columns only ever extend that window rightward).
        gap = events.Marker(
            ts_ns=end_ns - 1,
            kind="gap",
            text=f"restart: recording ends {end_ns}, live resumes ~{self._wall_clock()}",
        )
        self._markers.append(gap)
        self._record(lambda r: r.record_marker(gap))
        logger.info(
            "session %s rehydrated %d columns (tail t0 %d..%d)",
            self.session_id,
            len(tail.columns),
            tail.columns[0].t0_ns,
            tail.newest_t0_ns,
        )
        return True
