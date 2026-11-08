"""Session history requests: overview, disk and in-memory history responses."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from flowmap_server.core.grid import EpochParams, FinalizedColumn
from flowmap_server.core.overview import (
    SOURCE_BATCH_COLS,
    OverviewBuilder,
    OverviewCache,
    add_recording,
    native_group_epochs,
)
from flowmap_server.core.pyramid import metadata_page, pyramid_for
from flowmap_server.core.record import TailData
from flowmap_server.core.session_common import (
    _T_MAX,
    HISTORY_MAX_COLS,
    HISTORY_MAX_DISK_PARTS,
    OVERVIEW_STEP_TIMEOUT_S,
    SESSION_LOGGER,
    OverviewUnavailableError,
)
from flowmap_server.proto import events, wire

logger = logging.getLogger(SESSION_LOGGER)


class HistoryMixin:
    """History requests: overview, disk and in-memory history responses."""

    def handle_history(self, req: events.HistoryRequest) -> bytes:
        """Serve a HistoryRequest from the grid ring as ONE encoded frame.

        The frame batches an EpochStart for every distinct epoch in the
        response (ascending) ahead of the HistoryResponse — batched messages
        per WS frame are protocol-valid, and this lets the client
        reconstruct columns of epochs it never saw live.
        """
        n = max(0, min(req.n_cols, HISTORY_MAX_COLS))
        cols = self._grid.history(req.before_t, n)
        return self._history_frame(req, cols, self._grid.oldest_retained_t0_ns() or 0)

    async def handle_history_async(self, req: events.HistoryRequest) -> bytes:
        """Extend RAM scroll-back with bounded, compatible recorded columns.

        The disk reader runs off the event loop so a history page cannot
        stall the live feed. A recording is usable only when its exact epoch
        geometry AND logical recording identity match this grid. A cold-start
        recording with a reused epoch/sequence number is a separate timeline;
        it belongs in Replay, never in this live ring. Legacy recordings have
        no identity, so their sequence-to-time origin must match exactly.
        """
        if req.start_col is not None or req.end_col is not None:
            try:
                return await self._handle_overview(req)
            except OverviewUnavailableError:
                # Answered, not left pending: an empty page ends the request
                # and the Status carries overview_degraded until a step lands.
                return self._history_frame(req, [], 0)
        n = max(0, min(req.n_cols, HISTORY_MAX_COLS))
        if self._recorder_root is None or n == 0:
            return self.handle_history(req)
        anchor = self._grid.history(_T_MAX, 1)
        if not anchor:
            return self.handle_history(req)
        dt = self._grid.cfg.dt_ns
        origin = anchor[0].t0_ns - anchor[0].col_seq * dt
        recording_id = self._recording_identity
        cols = self._grid.history(req.before_t, n)
        # The RAM edge is a cache boundary, not necessarily the beginning of
        # recorded history. Advertise the grid origin until an empty disk page
        # proves exhaustion; otherwise clients latch at the RAM edge forever.
        # A warm restart can add a real timestamp seam without resetting
        # col_seq. Its newest affine origin is not the true beginning: leave
        # the bound unknown for scoped recordings until seq zero/empty proves
        # exhaustion. The part/column caps still strictly bound each read.
        cutoff = 0 if recording_id else origin
        oldest = cutoff
        disk_markers: list[events.Marker] = []
        if len(cols) < n:
            upper = cols[0].t0_ns if cols else req.before_t
            upper_seq = cols[0].col_seq if cols else anchor[0].col_seq + 1
            legacy = self._legacy_segment_before(upper, upper_seq)
            legacy_only = legacy is not None and upper <= legacy[0] + (legacy[2] + 1) * dt
            primary_parts = HISTORY_MAX_DISK_PARTS // 2 if legacy else HISTORY_MAX_DISK_PARTS
            if upper > cutoff and not legacy_only:
                tail = await self._read_history_tail(
                    cutoff, upper, n - len(cols), recording_id, primary_parts
                )
                if tail is not None and self._history_tail_matches(
                    tail, origin, upper, upper_seq, recording_id
                ):
                    merged = {(c.col_seq, c.t0_ns): c for c in tail.columns}
                    merged.update({(c.col_seq, c.t0_ns): c for c in cols})
                    cols = sorted(merged.values(), key=lambda c: c.col_seq)[-n:]
                    disk_markers = tail.markers
            if len(cols) < n and legacy is not None:
                # Legacy reads use only an actually preloaded cadence segment.
                # Exact affine identity and geometry remain mandatory; no
                # unrelated cold run can donate a same-numbered depth column.
                legacy_origin, legacy_lo, legacy_hi = legacy
                upper = min(
                    cols[0].t0_ns if cols else req.before_t,
                    legacy_origin + (legacy_hi + 1) * dt,
                )
                upper_seq = min(cols[0].col_seq if cols else upper_seq, legacy_hi + 1)
                cutoff_legacy = legacy_origin + legacy_lo * dt
                parts = (
                    HISTORY_MAX_DISK_PARTS
                    if legacy_only
                    else HISTORY_MAX_DISK_PARTS - primary_parts
                )
                if upper > cutoff_legacy:
                    tail = await self._read_history_tail(
                        cutoff_legacy, upper, n - len(cols), "", parts
                    )
                    if tail is not None and self._history_tail_matches(
                        tail, legacy_origin, upper, upper_seq, ""
                    ):
                        merged = {(c.col_seq, c.t0_ns): c for c in tail.columns}
                        merged.update({(c.col_seq, c.t0_ns): c for c in cols})
                        cols = sorted(merged.values(), key=lambda c: c.col_seq)[-n:]
                        disk_markers.extend(tail.markers)
        return self._history_frame(req, cols, oldest, disk_markers)

    async def _overview_call(self, fn: Callable[..., object], *args: object) -> object:
        """Run one overview step on this session's single overview thread.

        Overview work is serialized behind ``_overview_lock``, but a cancelled
        request releases that lock while its worker thread keeps running.
        Routing every step through one worker makes the orphan finish before
        the next request starts, so the unlocked OverviewCache is never mutated
        from two threads.

        Each step is bounded by ``OVERVIEW_STEP_TIMEOUT_S``. A step that
        overruns is abandoned, not waited on: it is counted as orphaned work,
        the session reports ``overview_degraded``, and the request fails with
        :class:`OverviewUnavailableError`. The thread itself cannot be stopped,
        and it holds the only worker, so until it returns every later step
        fails at once with the same error instead of queuing behind it for
        another full deadline each.
        """
        wedged = self._overview_wedged
        if wedged is not None and not wedged.done():
            raise OverviewUnavailableError("overview worker is busy with a step that overran its deadline")
        future = asyncio.get_running_loop().run_in_executor(self._overview_executor, fn, *args)
        try:
            async with asyncio.timeout(OVERVIEW_STEP_TIMEOUT_S):
                # Shielded: the timeout or a cancelled request must not cancel
                # the thread's future, which is what keeps the cache consistent.
                result = await asyncio.shield(future)
        except TimeoutError:
            self._abandon_overview_step(future, "overran its deadline", wedged=True)
            raise OverviewUnavailableError(
                f"overview step exceeded {OVERVIEW_STEP_TIMEOUT_S:.0f}s"
            ) from None
        except asyncio.CancelledError:
            if not future.done():
                self._abandon_overview_step(future, "was cancelled", wedged=False)
            raise
        self._set_overview_degraded(False)
        return result

    def _abandon_overview_step(self, future: asyncio.Future, why: str, *, wedged: bool) -> None:
        """Count and surface an overview step whose request gave up on it.

        ``wedged`` marks a step that overran its deadline: its worker is still
        running, so later steps fail fast until it lands (see _overview_call).
        """
        logger.error(
            "overview step %s for session %s; the worker thread keeps running",
            why,
            self.session_id,
        )
        if self._stats is not None:
            self._stats.inc_orphaned_work()
        self._set_overview_degraded(True)
        if wedged:
            self._overview_wedged = future
        future.add_done_callback(self._overview_step_settled)

    def _overview_step_settled(self, future: asyncio.Future) -> None:
        """An abandoned step returned: free the worker and retrieve its outcome."""
        if self._overview_wedged is future:
            self._overview_wedged = None
        if not future.cancelled():
            future.exception()  # retrieved so the loop never logs it

    def _set_overview_degraded(self, degraded: bool) -> None:
        """Publish ``overview_degraded`` to attached clients on each change."""
        if degraded == self._overview_degraded:
            return
        self._overview_degraded = degraded
        if self._clients:
            self._publish_status()

    async def _handle_overview(self, req: events.HistoryRequest) -> bytes:
        """Explicit ranges use an independent aggregate cache, never RAM span.

        n_cols bounds output. IO, price projection, means and wire encoding
        run off the live loop. Only small native-ring snapshots run on-loop;
        no worker reads that mutable ring concurrently with feed writes.
        """
        async with self._overview_lock:
            target = self._grid.current_epoch_params()
            retained = self._grid.retained_sequence_range()
            n = max(0, min(req.n_cols, HISTORY_MAX_COLS))
            if (
                req.start_col is None
                or req.end_col is None
                or req.stride < 1
                or req.stride > 2**32
                or n == 0
                or retained is None
            ):
                return self._history_frame(req, [], 0)
            start = max(0, req.start_col)
            first_group = start // req.stride * req.stride
            end = min(req.end_col, retained[1], 2**32 - 1, (first_group + n * req.stride) - 1)
            if end < start:
                return self._history_frame(req, [], 0)
            epochs = dict(self._grid._epoch_params)
            ram_refs = self._overview_ram_refs(start, end, retained)
            parts = await self._overview_source_parts(start, end, epochs)
            group_targets = await self._overview_call(
                native_group_epochs,
                target,
                start,
                end,
                req.stride,
                req.before_t,
                self._overview_cache,
                ram_refs,
                self._recorder_root,
                self._feed.market,
                self._feed.symbol,
                self._recording_identity,
                epochs,
                list(self._legacy_history_segments),
                parts,
            )
            builder = OverviewBuilder(
                target,
                start,
                end,
                req.stride,
                req.before_t,
                retained[1],
                self._overview_cache,
                group_targets=group_targets,
            )
            await self._overview_fill_ram(builder, target, retained, epochs)
            if self._recorder_root is not None and builder.missing_source_ranges():
                await self._overview_fill_recording(builder, epochs, parts)
            markers = list(self._markers)
            mode = self._grid.cfg.mode
            return await self._overview_call(
                self._overview_frame, req, target, builder, markers, mode
            )

    def _overview_ram_refs(
        self, start: int, end: int, retained: tuple[int, int]
    ) -> list[tuple[int, int, int]]:
        """Scalar (seq, t0, epoch) of each retained column in range, read on-loop."""
        return [
            (
                seq,
                int(self._grid._ring_t0[seq % self._grid.cfg.ring_columns]),
                int(self._grid._ring_epoch[seq % self._grid.cfg.ring_columns]),
            )
            for seq in range(max(start, retained[0]), min(end, retained[1]) + 1)
        ]

    async def _overview_source_parts(self, start: int, end: int, epochs: dict) -> list:
        """Validate immutable part stamps once for this request.

        The scalar representative and density passes reuse this same snapshot;
        complete aggregate cache hits leave it empty and do no scan. A changed
        source generation drops the aggregate cache.
        """
        parts: list = []
        if self._recorder_root is not None:
            store = await self._overview_call(
                pyramid_for,
                self._recorder_root,
                self._feed.market,
                self._feed.symbol,
                self._recording_identity,
            )
            parts = await self._overview_call(store.parts, start, end)
            generation = await self._overview_call(store.generation, parts, start, end, epochs)
            if (
                self._overview_source_generation is not None
                and generation != self._overview_source_generation
            ):
                self._overview_cache = OverviewCache()
            self._overview_source_generation = generation
        return parts

    async def _overview_fill_ram(
        self,
        builder: OverviewBuilder,
        target: EpochParams,
        retained: tuple[int, int],
        epochs: dict,
    ) -> None:
        """Add the retained RAM columns the aggregate cache is still missing."""
        # RAM wins over any already-flushed duplicate. Its copies are
        # bounded at 2 MiB on the production grid, with a yield after each.
        batch_size = max(1, min(SOURCE_BATCH_COLS, (2 * 1024 * 1024) // (target.rows * 8)))
        for low, high in builder.missing_ranges():
            cursor = max(low, retained[0])
            stop = min(high, retained[1])
            while cursor <= stop:
                last = min(stop, cursor + batch_size - 1)
                columns = self._grid.history_sequence_batch(cursor, last, batch_size)
                await self._overview_call(builder.add, columns, epochs)
                cursor = last + 1
                await asyncio.sleep(0)

    async def _overview_fill_recording(
        self, builder: OverviewBuilder, epochs: dict, parts: list
    ) -> None:
        """Add the recorded columns the aggregate cache is still missing."""
        try:
            await self._overview_call(
                add_recording,
                builder,
                self._recorder_root,
                self._feed.market,
                self._feed.symbol,
                self._recording_identity,
                epochs,
                list(self._legacy_history_segments),
                parts,
            )
        except Exception:
            logger.exception("recorded overview read failed for session %s", self.session_id)
            # Do not silently render a recent-tail-only picture as a
            # completed overview. The client retries a failed request.
            raise

    def _overview_frame(
        self,
        req: events.HistoryRequest,
        target: EpochParams,
        builder: OverviewBuilder,
        markers: list[events.Marker],
        mode: int,
    ) -> bytes:
        """Encode one overview response. Runs on the overview worker."""
        columns = builder.finish()
        low_time = builder.first_time
        high_time = builder.last_time
        visible_markers = (
            []
            if low_time is None or high_time is None
            else [m for m in markers if low_time <= m.ts_ns < high_time + target.dt_ns]
        )
        visible_markers.extend(builder.gap_markers())
        visible_markers.extend(builder.resolution_markers())
        visible_markers.sort(key=lambda marker: marker.ts_ns)
        visible_markers = metadata_page(visible_markers, req, self._overview_source_generation or "")
        response = events.HistoryResponse(
            req_id=req.req_id,
            epoch=target.epoch,
            oldest_available_t_ns=0,
            depth_cols=[
                events.DepthColumn(
                    epoch=c.epoch,
                    col_seq=c.col_seq,
                    t0_ns=c.t0_ns,
                    mode=mode,
                    final=True,
                    bid=c.bid,
                    ask=None if mode == events.MODE_SYNTH_PROFILE else c.ask,
                )
                for c in columns
            ]
            if req.metadata_cursor is None
            else [],
            bar_cols=[c.bar for c in columns] if req.metadata_cursor is None else [],
            markers=visible_markers,
            big_trades=[],
        )
        # Existing wire format already carries per-column epochs.
        # Publish every used historical map, then the current map.
        # Historical IDs are older; the client's monotone live epoch
        # cannot move backwards when these params are registered.
        announcements = dict(builder.output_epochs)
        announcements[target.epoch] = target
        return b"".join(
            wire.encode(events.EpochStart(epoch=epoch, epoch_params=params))
            for epoch, params in sorted(announcements.items())
        ) + wire.encode(response)

    def _legacy_segment_before(self, upper: int, upper_seq: int) -> tuple[int, int, int] | None:
        dt = self._grid.cfg.dt_ns
        return next(
            (
                segment
                for segment in reversed(self._legacy_history_segments)
                if segment[1] < upper_seq and segment[0] + segment[1] * dt < upper
            ),
            None,
        )

    async def _read_history_tail(
        self, cutoff: int, upper: int, n: int, recording_id: str | None, parts: int
    ) -> TailData | None:
        assert self._recorder_root is not None
        try:
            return await asyncio.to_thread(
                self._recorder_root.load_tail,
                self._feed.market,
                self._feed.symbol,
                max_age_ns=upper - cutoff,
                now_ns=upper,
                limit_cols=n,
                end_ns=upper,
                max_column_parts=parts,
                recording_id=recording_id,
                include_events=False,
            )
        except Exception:
            logger.exception("recorded history read failed for session %s", self.session_id)
            return None

    def _history_tail_matches(
        self,
        tail: TailData,
        origin: int,
        upper: int,
        upper_seq: int,
        recording_id: str | None,
    ) -> bool:
        """Reject foreign timelines/geometry without reprojecting density."""
        epoch_map = {e.epoch: e for e in tail.epochs}
        if recording_id is not None and (tail.recording_id or "") != recording_id:
            return False
        previous: FinalizedColumn | None = None
        for col in tail.columns:
            params = epoch_map.get(col.epoch)
            try:
                expected = self._grid.epoch_params_for(col.epoch)
            except KeyError:
                return False
            # Each recorded epoch is checked against the grid's OWN table for
            # that epoch. Comparing it with the current epoch's params (only
            # the epoch number swapped) rejected every page that crossed a
            # re-anchor, because an older epoch carries its own p0.
            if (
                params != expected
                or not 0 <= col.col_seq < min(2**32, upper_seq)
                or (not recording_id and (col.t0_ns != origin + col.col_seq * expected.dt_ns))
                or not (0 if recording_id else origin) <= col.t0_ns < upper
                or len(col.bid) != expected.rows
                or len(col.ask) != expected.rows
                or (
                    previous is not None
                    and (col.col_seq <= previous.col_seq or col.t0_ns <= previous.t0_ns)
                )
            ):
                return False
            previous = col
        return bool(tail.columns)

    def _history_frame(
        self,
        req: events.HistoryRequest,
        cols: list[FinalizedColumn],
        oldest: int,
        disk_markers: list[events.Marker] | None = None,
    ) -> bytes:
        ep = self._grid.current_epoch_params()
        markers: list[events.Marker] = []
        if cols:
            lo, hi = cols[0].t0_ns, cols[-1].t0_ns + ep.dt_ns
            by_marker = {
                (m.ts_ns, m.kind, m.text, m.price, m.size): m
                for m in [*(disk_markers or []), *self._markers]
                if lo <= m.ts_ns < hi
            }
            markers = sorted(by_marker.values(), key=lambda m: m.ts_ns)
        resp = events.HistoryResponse(
            req_id=req.req_id,
            epoch=ep.epoch,
            oldest_available_t_ns=oldest,
            depth_cols=[self._grid.to_depth(c) for c in cols],
            bar_cols=[c.bar for c in cols],
            markers=markers,
            big_trades=[],  # see the big_trades note at module top
        )
        announce = self._epoch_start_msgs({c.epoch for c in cols})
        return b"".join([*announce, wire.encode(resp)])
