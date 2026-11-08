"""Per-client bounded send queue with lag and drop accounting (ClientTx)."""

from __future__ import annotations

import time
from collections.abc import Callable

from flowmap_server.core.session_common import LAG_DROP_NS, NONCOL_CAP, Clock
from flowmap_server.proto import events, wire


class _Frame:
    __slots__ = ("col", "data", "enq_ns", "is_partial", "partial_kind", "protected", "t0_ns")

    def __init__(
        self,
        data: bytes,
        col: bool,
        t0_ns: int | None,
        enq_ns: int,
        protected: bool = False,
        is_partial: bool = False,
        partial_kind: str = "",
    ) -> None:
        self.data = data
        self.col = col
        self.t0_ns = t0_ns
        self.enq_ns = enq_ns
        self.protected = protected
        self.is_partial = is_partial
        self.partial_kind = partial_kind


class _Gap:
    """Placeholder for a contiguous run of dropped columns; encoded lazily at
    drain time so a run growing across offers still yields ONE Marker.

    ``count`` is real COLUMNS, not frames: a finalized column arrives as two
    frames (depth+bar sharing ``t0_ns``) and is counted once, via the
    ``last_t0_ns`` dedup in ``_evict_lagged``. Partial re-emissions never
    reach a gap run at all."""

    __slots__ = ("count", "first_t0_ns", "last_t0_ns")

    def __init__(self, t0_ns: int) -> None:
        self.first_t0_ns = t0_ns
        self.last_t0_ns = t0_ns
        self.count = 1


class ClientTx:
    """Per-client bounded send queue with lag/drop state.

    Entries stay FIFO across column and non-column frames. FINALIZED column
    frames are never coalesced; they are dropped whole (oldest-first) once
    their unsent age exceeds ``lag_ns``, leaving one gap Marker per contiguous
    drop run whose count is real columns (a depth+bar pair sharing ``t0_ns``
    counts once). PARTIAL column frames (``is_partial=True``, the 20 Hz
    right-edge re-emissions) coalesce latest-wins per ``t0_ns``: at most one
    undrained depth+bar partial pair stays queued per column, and a
    lag-dropped partial is never counted as a lost column (its final frame
    may still be delivered).
    Non-column frames are capped at ``noncol_cap`` with silent drop-oldest.
    """

    def __init__(
        self,
        clock: Clock = time.monotonic_ns,
        *,
        lag_ns: int = LAG_DROP_NS,
        noncol_cap: int = NONCOL_CAP,
    ) -> None:
        self._clock = clock
        self._lag_ns = lag_ns
        self._noncol_cap = noncol_cap
        self._q: list[_Frame | _Gap] = []
        self._noncol = 0
        # Telemetry hook, installed by Session.attach: called
        # with the number of COLUMNs dropped by each lag eviction so the
        # server-wide stats aggregate can count tx lag drops at the source.
        # Public and default-None — the WS layer constructs ClientTx bare.
        self.on_lag_drop: Callable[[int], None] | None = None

    def __len__(self) -> int:
        return len(self._q)

    def offer(
        self,
        msg_bytes: bytes,
        *,
        col_msg: bool,
        t0_ns: int | None = None,
        protected: bool = False,
        is_partial: bool = False,
        partial_kind: str = "",
    ) -> None:
        now = self._clock()
        if col_msg:
            if t0_ns is None:
                raise ValueError("column frames must carry t0_ns")
            self._evict_lagged(now)
            if is_partial:
                # Latest-wins per (t0, kind): a re-emitted partial supersedes the
                # queued partial of its own kind for the same column, and no
                # other kind's frame. The depth partial is only re-sent when it
                # changed, so a bar-only tick must never evict a queued depth.
                for i, e in enumerate(self._q):
                    if (
                        isinstance(e, _Frame)
                        and e.is_partial
                        and e.t0_ns == t0_ns
                        and e.partial_kind == partial_kind
                    ):
                        del self._q[i]
                        break
            self._q.append(
                _Frame(msg_bytes, True, t0_ns, now, protected, is_partial, partial_kind)
            )
            return
        self._q.append(_Frame(msg_bytes, False, t0_ns, now, protected))
        if protected:
            # Snapshot frames: exempt from (and not counted toward) the
            # non-column cap — a tape/BBO flood must never evict Hello.
            return
        self._noncol += 1
        if self._noncol > self._noncol_cap:
            for i, e in enumerate(self._q):
                if isinstance(e, _Frame) and not e.col and not e.protected:
                    del self._q[i]
                    self._noncol -= 1
                    break

    def _evict_lagged(self, now_ns: int) -> None:
        """Drop whole columns whose unsent age exceeds ``lag_ns``.

        Entries are enqueue-ordered, so lagged frames form a prefix; the scan
        stops at the first fresh frame. A dropped column merges into an
        immediately preceding gap run (one Marker per contiguous run, even
        when the run grows across many offers); gap markers themselves and
        non-column frames are never lag-dropped.

        Gap accounting is per COLUMN, not per frame: consecutive finalized
        frames sharing ``t0_ns`` (the depth+bar pair) bump the run count once.
        Evicted PARTIAL frames are stale right-edge re-emissions — superseded
        data, not lost columns (the final may still be delivered) — so they
        are dropped silently and never counted toward a gap run.
        """
        threshold = now_ns - self._lag_ns
        q = self._q
        out: list[_Frame | _Gap] = []
        idx = 0
        dropped = False
        n_cols = 0  # real columns lost (depth+bar pair sharing t0 counts once)
        while idx < len(q):
            e = q[idx]
            if isinstance(e, _Frame):
                if e.enq_ns >= threshold:
                    break  # everything after is newer
                if e.col:
                    assert e.t0_ns is not None
                    dropped = True
                    idx += 1
                    if e.is_partial:
                        continue  # stale partial: drop, never a gap column
                    tail = out[-1] if out else None
                    if isinstance(tail, _Gap):
                        if tail.last_t0_ns != e.t0_ns:  # depth+bar: count once
                            tail.last_t0_ns = e.t0_ns
                            tail.count += 1
                            n_cols += 1
                    else:
                        out.append(_Gap(e.t0_ns))
                        n_cols += 1
                    continue
            out.append(e)
            idx += 1
        if dropped:
            self._q = out + q[idx:]
            if n_cols and self.on_lag_drop is not None:
                try:
                    self.on_lag_drop(n_cols)
                except Exception:  # telemetry must never kill the queue
                    pass

    def drain(self, max_bytes: int) -> list[bytes]:
        """Pop frames FIFO up to ``max_bytes`` total.

        Always returns at least one frame when the queue is non-empty, so a
        single frame larger than the budget cannot wedge the queue. Gap runs
        encode to their Marker frame here.
        """
        out: list[bytes] = []
        total = 0
        taken = 0
        for e in self._q:
            if isinstance(e, _Frame):
                data = e.data
            else:
                data = wire.encode(
                    events.Marker(
                        ts_ns=e.first_t0_ns,
                        kind="gap",
                        text=f"backpressure: dropped {e.count} columns",
                    )
                )
            if out and total + len(data) > max_bytes:
                break
            out.append(data)
            total += len(data)
            taken += 1
            if isinstance(e, _Frame) and not e.col and not e.protected:
                self._noncol -= 1
        del self._q[:taken]
        return out
