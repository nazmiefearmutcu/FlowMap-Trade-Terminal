"""Session fan-out: client attach and detach, snapshot frames and broadcast."""

from __future__ import annotations

import numpy as np

from flowmap_server.core.session_common import _T_MAX, SNAPSHOT_CHUNK_COLS, SNAPSHOT_COLS
from flowmap_server.core.session_queue import ClientTx
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.proto import events, wire


class FanoutMixin:
    """Client attach and detach, snapshot frames and broadcast."""

    def attach(self, client: ClientTx) -> list[bytes]:
        """Register a client and return the pre-encoded snapshot frames.

        The caller delivers the frames (SessionManager enqueues them; the WS
        layer may send them directly). No await happens between snapshot
        capture and registration, so live broadcasts cannot interleave.
        """
        if self._closed:
            raise RuntimeError(f"session {self.session_id} is torn down")
        if self._grace_handle is not None:
            self._grace_handle.cancel()
            self._grace_handle = None
        # Route this client's lag drops into the server-wide stats aggregate.
        # Overwritten on every attach — a resubscribe moves the
        # client (and its counter) to the new session's stats, which is the
        # same aggregate for manager-built sessions.
        client.on_lag_drop = self._stats.inc_tx_lag_drops if self._stats is not None else None
        self._clients.add(client)
        # A new subscriber must receive the forming column even when nothing
        # changed since the last broadcast, so forget what was sent.
        self._last_partial_depth = None
        self._last_partial_bar = None
        return self._snapshot_frames()

    @property
    def client_count(self) -> int:
        """Attached clients (the session's refcount)."""
        return len(self._clients)

    def detach(self, client: ClientTx) -> None:
        # Idempotent: the refcount IS len(_clients), so a double-detach of the
        # same client cannot decrement twice and orphan a live subscriber.
        if client not in self._clients:
            return
        self._clients.discard(client)
        if not self._clients and not self._closed:
            if self._grace_handle is not None:
                self._grace_handle.cancel()
            self._grace_handle = self._timer(self._grace_s, self._teardown)

    def _cache_encoded(self, col_seq: int, data: bytes) -> None:
        """LRU-store one finalized column's joined wire bytes (see
        ``_enc_cache``); capped at the snapshot window so entries evicted from
        the ring age out of the cache too."""
        enc = self._enc_cache
        enc[col_seq] = data
        enc.move_to_end(col_seq)
        while len(enc) > SNAPSHOT_COLS:
            enc.popitem(last=False)

    def _broadcast(
        self,
        frame: bytes,
        *,
        col: bool,
        t0_ns: int | None = None,
        is_partial: bool = False,
        partial_kind: str = "",
    ) -> None:
        if self._preparing_closed_history:
            return
        for client in self._clients:
            client.offer(
                frame, col_msg=col, t0_ns=t0_ns, is_partial=is_partial, partial_kind=partial_kind
            )

    # -- snapshot / history ----------------------------------------------------

    def _norm_seed(self) -> float:
        """Percentile hint for client normalization: p99 of the nonzero
        densities over the most recent ≤64 columns, or 1.0 when empty.

        Memoised on the retained window and the live epoch: a new column, a
        ring wrap, a preload or a re-anchor changes one of them, and an attach
        to an unchanged window reuses the last percentile."""
        key = (self._grid.retained_sequence_range(), self._grid.current_epoch_params().epoch)
        memo = self._norm_seed_memo
        if memo is not None and memo[0] == key:
            return memo[1]
        seed = self._compute_norm_seed()
        self._norm_seed_memo = (key, seed)
        return seed

    def _compute_norm_seed(self) -> float:
        """Non-finite values are filtered before the percentile: a ``+inf``
        texel rehydrated from a pre-clamp recording would otherwise make the
        p99 — and with it the wire ``norm_seed`` — infinite."""
        cols = self._grid.history(_T_MAX, 64)
        if not cols:
            return 1.0
        vals = np.concatenate([c.bid for c in cols] + [c.ask for c in cols]).astype(np.float64)
        vals = vals[np.isfinite(vals) & (vals > 0.0)]
        if vals.size == 0:
            return 1.0
        return float(np.percentile(vals, 99.0))

    def _epoch_start_msgs(self, epochs: set[int]) -> list[bytes]:
        """One encoded EpochStart per epoch, ascending. Duplicate EpochStarts
        across snapshot/history responses are harmless: the client's epoch
        table is idempotent."""
        return [
            wire.encode(events.EpochStart(epoch=e, epoch_params=self._grid.epoch_params_for(e)))
            for e in sorted(epochs)
        ]

    def _snapshot_meta(self, n: int) -> list[tuple[int, int, int, int]]:
        """(slot_seq, col_seq, t0_ns, epoch) of the newest ``n`` retained columns.

        Same window as ``grid.history(_T_MAX, n)``, but no density is copied:
        an attach that hits the encode cache never materializes the column.
        Oldest first. The ring read lives on the grid
        (:meth:`Grid.snapshot_meta`), so this module never touches its
        private ring arrays."""
        return self._grid.snapshot_meta(n)

    def _snapshot_frames(self) -> list[bytes]:
        ep = self._grid.current_epoch_params()
        meta = self._snapshot_meta(SNAPSHOT_COLS)
        hello = events.Hello(
            protocol_version=wire.PROTO_VER,
            session_id=self.session_id,
            grid_epoch=ep.epoch,
            epoch_params=ep,
            capability=self._capability(),
            norm_seed=self._norm_seed(),
        )
        # Hello first, then EpochStart for EVERY distinct epoch appearing in
        # the snapshot's columns (plus the current one), ascending — the
        # client must hold params for each epoch before decoding its columns.
        announce = self._epoch_start_msgs({epoch for _, _, _, epoch in meta} | {ep.epoch})
        frames = [b"".join([wire.encode(hello), *announce])]
        for i in range(0, len(meta), SNAPSHOT_CHUNK_COLS):
            chunk = meta[i : i + SNAPSHOT_CHUNK_COLS]
            # Served from the finalize-time encode cache where available (the
            # live path): zero re-encode, byte-identical (the cache holds the
            # exact bytes this session's finalize step produced). A miss
            # (rehydrated tail, backfill/replay seed, ring wrap) encodes once
            # with the SAME encoder calls and warms the cache.
            parts: list[bytes] = []
            for slot_seq, col_seq, _t0, _epoch in chunk:
                enc = self._enc_cache.get(col_seq)
                if enc is None:
                    batch = self._grid.history_sequence_batch(slot_seq, slot_seq, 1)
                    if not batch:
                        continue
                    c = batch[0]
                    enc = wire.encode(self._grid.to_depth(c)) + wire.encode(c.bar)
                    self._cache_encoded(col_seq, enc)
                parts.append(enc)
            frames.append(b"".join(parts))

        tail: list[bytes] = []
        partial = None
        if (
            isinstance(self._feed, EquityFeed)
            and self._feed.tier == "keyless"
            and self._feed_state == "closed"
        ):
            partial = self._grid.current_partial()
            if partial is not None:
                tail.extend((wire.encode(partial), wire.encode(self._grid.bar_partial())))
            latency_ms, skew_ms = self._conn_latency_skew()
            tail.append(wire.encode(events.Status(
                feed_state="closed", capability=self._capability(),
                latency_ms=latency_ms, clock_skew_ms=skew_ms,
                next_open_ts=self._feed.next_open_ts,
            )))
        if meta or partial is not None:
            lo = meta[0][2] if meta else partial.t0_ns
            hi = meta[-1][2] + ep.dt_ns if meta else lo + ep.dt_ns
            if partial is not None:
                hi = max(hi, partial.t0_ns + ep.dt_ns)
            tail.extend(wire.encode(m) for m in self._markers if lo <= m.ts_ns < hi)
        tail.extend(wire.encode(t) for t in self._tape)
        if self._instant_book is not None:
            tail.append(self._instant_book)
        if self._bbo is not None:
            tail.append(wire.encode(self._bbo))
        if tail:
            frames.append(b"".join(tail))
        return frames
