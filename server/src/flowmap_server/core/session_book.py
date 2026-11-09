"""Session book path: finalized and partial column emission from the feed."""

from __future__ import annotations

import asyncio
import logging

import msgspec
import numpy as np

from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.core.session_common import SESSION_LOGGER
from flowmap_server.feeds.base import BookState
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.proto import events, wire

logger = logging.getLogger(SESSION_LOGGER)


class BookMixin:
    """Book path: finalized and partial column emission from the feed."""

    def _on_replay_book(self, ev: BookState, *, broadcast: bool = True) -> None:
        feed = self._feed
        assert isinstance(feed, ReplayFeed)
        if ev.revision != feed.generation:
            return
        i = feed.index_at(ev.ts_ns)
        source = feed._cols[i]
        ep = feed._epochs[source.epoch]
        old_epoch = self._grid._epoch
        col = self._grid.install_replay_column(source, ep, i)
        feed.acknowledge(i)
        self._last_col_seq = i
        self._bbo = None
        if len(ev.bid_px) and len(ev.ask_px):
            bi, ai = int(np.argmax(ev.bid_px)), int(np.argmin(ev.ask_px))
            if ev.ask_px[ai] >= ev.bid_px[bi] > 0:
                self._bbo = events.BBO(ts_ns=ev.ts_ns, bid_px=float(ev.bid_px[bi]),
                                      bid_sz=float(ev.bid_sz[bi]), ask_px=float(ev.ask_px[ai]),
                                      ask_sz=float(ev.ask_sz[ai]))
        depth = wire.encode(self._grid.to_depth(col))
        bar = wire.encode(col.bar)
        self._cache_encoded(i, depth + bar)
        self._instant_book = wire.encode(msgspec.structs.replace(self._grid.book_update(ev.ts_ns), col_seq=i))
        if broadcast:
            if old_epoch != ep.epoch:
                self._broadcast(wire.encode(events.EpochStart(epoch=ep.epoch, epoch_params=ep)), col=False)
            self._broadcast(depth, col=True, t0_ns=col.t0_ns)
            self._broadcast(bar, col=True, t0_ns=col.t0_ns)
            self._broadcast(self._instant_book, col=False)
            if self._bbo is not None:
                self._broadcast(wire.encode(self._bbo), col=False)
            # Periodic Status publishes playhead at <=4 Hz. End is immediate.
            if feed.ended:
                self._publish_status()

    async def _partial_flusher(self) -> None:
        """Clock-driven right-edge flush (FLUSH_INTERVAL_NS, ~60 Hz default).

        ``_consume`` only flushed partials while it was draining feed events,
        so a quiet or bursty feed (equity keyless polls every 10 s; sim/crypto
        burst every 250 ms and then sleep) froze the forming column between
        events — the heatmap right edge looked stalled even though the DOM
        board updated instantly. This task re-emits the in-progress column on a
        fixed cadence so the right edge animates continuously; it is a no-op
        while no client is attached and when the grid has no in-flight column.
        Cancelled by :meth:`run` on every exit (crash/restart keeps one task
        alive across feed restarts)."""
        interval_s = self._flush_interval_ns / 1e9
        while True:
            await asyncio.sleep(interval_s)
            # Event-independent recording cadence (2026-09-13): the time-based
            # flush used to ride `_consume` per consumed event, so a feed that
            # silently wedged stopped dropping parts altogether. This clock
            # tick flushes with zero events; `_flush_recording` itself guards
            # the retry cooldown and the single in-flight task.
            if self._rec is not None:
                try:
                    now = self._clock()
                    if self._recording_flush_due(now):
                        self._flush_recording()
                except Exception:  # a flush must never kill the session
                    logger.exception(
                        "periodic recording flush failed for session %s",
                        self.session_id,
                    )
            try:
                # A feed can report degraded without yielding (a quiet poll), so
                # the clock tick mirrors the flag too, not only the event loop.
                self._mirror_feed_degraded()
            except Exception:  # a broadcast must never kill the flusher
                logger.exception("feed degraded mirror failed for session %s", self.session_id)
            if not self._clients:
                continue
            try:
                self._publish_capability_status()
            except Exception:
                logger.exception(
                    "periodic capability Status failed for session %s", self.session_id
                )
            try:
                self._flush_partial()
            except Exception:  # a flush must never kill the session
                logger.exception("periodic partial flush failed for session %s", self.session_id)

    def _on_book(self, ev: BookState) -> None:
        if isinstance(self._feed, ReplayFeed):
            self._on_replay_book(ev)
            return
        # The inside quote comes from raw venue prices, never from a grouped
        # density row. Some connectors deliver depth before their ticker.
        if self._feed.market != "sim" and self._feed.capability.get("depth") in (
            "L2",
            "L2-snapshot",
        ):
            if len(ev.bid_px) and len(ev.ask_px):
                bi, ai = int(np.argmax(ev.bid_px)), int(np.argmin(ev.ask_px))
                quote = events.BBO(
                    ts_ns=ev.ts_ns,
                    bid_px=float(ev.bid_px[bi]),
                    bid_sz=float(ev.bid_sz[bi]),
                    ask_px=float(ev.ask_px[ai]),
                    ask_sz=float(ev.ask_sz[ai]),
                )
                if (
                    quote.bid_px > 0
                    and quote.ask_px >= quote.bid_px
                    and (self._bbo is None or quote.ts_ns >= self._bbo.ts_ns)
                ):
                    self._bbo = quote
                    self._broadcast(wire.encode(quote), col=False)
        cols = self._grid.on_book(ev.ts_ns, ev.bid_px, ev.bid_sz, ev.ask_px, ev.ask_sz)
        self._emit_finalized(cols)
        anchor = self._reanchor_ref(ev)
        if anchor is not None:
            params = self._grid.maybe_reanchor(anchor)
            if params is not None:
                # EpochStart FIRST: broadcast before any new-epoch column
                # message (the columns emitted above carry the old epoch).
                self._record(lambda r, p=params: r.record_epoch(p))
                start = events.EpochStart(epoch=params.epoch, epoch_params=params)
                self._broadcast(wire.encode(start), col=False)
        if self._feed.market != "sim" and self._feed.capability.get("depth") in (
            "L2",
            "L2-snapshot",
        ):
            self._instant_book = wire.encode(self._grid.book_update(ev.ts_ns))
            # A full book state supersedes the one still queued for a slow client.
            self._broadcast(self._instant_book, col=False, latest_key="instant-book")

    @staticmethod
    def _reanchor_ref(ev: BookState) -> float | None:
        """Price the grid re-anchors around for this book (None to skip).

        Two-sided books (L2 crypto/sim, and keyed L1_BAND equity) use the BBO
        mid — the exact expression the L2 path has always used, so crypto/sim
        stay byte-identical. A one-sided density (only bid, or — for a two-sided
        synthetic split whose reference price sits at/below every occupied bucket
        during a sustained decline — only ask) has no BBO, so it re-anchors around
        that side's price-span center instead: this is what lets an equity grid
        started at a nominal $100 p0 recentre on the symbol's real price (e.g. an
        AAPL profile near $180) regardless of which side the split leaves
        populated."""
        if len(ev.bid_px) and len(ev.ask_px):
            return (float(np.max(ev.bid_px)) + float(np.min(ev.ask_px))) / 2.0
        if len(ev.bid_px):
            return (float(np.min(ev.bid_px)) + float(np.max(ev.bid_px))) / 2.0
        if len(ev.ask_px):
            return (float(np.min(ev.ask_px)) + float(np.max(ev.ask_px))) / 2.0
        return None

    def _emit_finalized(self, cols: list[FinalizedColumn]) -> None:
        emitted = False
        if self._stats is not None:
            # Out-of-interval trades: the grid's running total, surfaced
            # on /api/health through SessionStats. Read once per book boundary.
            self._stats.note_out_of_interval(self.session_id, self._grid.out_of_interval_trades)
        for col in cols:
            # The grid re-returns the last column on a zero-span boundary
            # call — dedup by col_seq (grid docstring; test 6).
            if self._last_col_seq is not None and col.col_seq <= self._last_col_seq:
                continue
            self._last_col_seq = col.col_seq
            self._record(lambda r, c=col: r.record_column(c))
            self._cols_since_flush += 1
            # Encode ONCE here (finalize time) and reuse the bytes for both
            # the broadcast and the attach snapshot — the snapshot used to
            # re-encode every column (~8-16 MB) inline on the event loop per
            # attach.
            depth_b = wire.encode(self._grid.to_depth(col))
            bar_b = wire.encode(col.bar)
            self._cache_encoded(col.col_seq, depth_b + bar_b)
            self._broadcast(depth_b, col=True, t0_ns=col.t0_ns)
            self._broadcast(bar_b, col=True, t0_ns=col.t0_ns)
            emitted = True
        if self._cols_flush_due():
            self._flush_recording()
        if emitted:
            # Re-seed the right edge immediately after a column closes so the
            # client always has the in-progress column (plus the periodic
            # clock-based flush below).
            self._flush_partial()

    def _flush_partial(self, now_ns: int | None = None) -> None:
        partial = self._grid.current_partial()
        if partial is None:
            return
        self._last_flush_ns = self._clock() if now_ns is None else now_ns
        # Partials coalesce latest-wins per (t0, kind) in each ClientTx, so a
        # skipped unchanged depth partial leaves the queued bar partial alone.
        if self._partial_depth_changed(partial):
            self._broadcast(
                wire.encode(partial), col=True, t0_ns=partial.t0_ns,
                is_partial=True, partial_kind="depth",
            )
        bar = self._grid.bar_partial()
        if self._bar_partial_changed(bar):
            self._broadcast(
                wire.encode(bar),
                col=True,
                t0_ns=partial.t0_ns,
                is_partial=True,
                partial_kind="bar",
            )

    def _bar_partial_changed(self, bar: events.BarColumn) -> bool:
        """True when the forming bar differs from the last one sent.

        The bar moves only on trades, so on a quiet market the same frame would
        otherwise be encoded, fanned out and redrawn on every flush tick. The
        comparison is by value over every field of the column (epoch, sequence,
        interval, OHLC, volumes, cumulative CVD and VWAP sums).
        """
        if bar == self._last_partial_bar:
            return False
        self._last_partial_bar = bar
        return True

    def _partial_depth_changed(self, partial: events.DepthColumn) -> bool:
        """True when the forming depth column differs from the last one sent.

        The depth integral only moves on book updates, so re-sending an
        unchanged partial every flush tick costs an encode, a fan-out and a
        client redraw for identical pixels. The comparison is by content, so
        every path that moves the integral, the epoch or the column is covered
        without enumerating them. The bar partial is not affected and keeps
        its cadence.
        """
        last = self._last_partial_depth
        if (
            last is not None
            and last.epoch == partial.epoch
            and last.col_seq == partial.col_seq
            and last.t0_ns == partial.t0_ns
            and np.array_equal(last.bid, partial.bid)
            and (
                (last.ask is None and partial.ask is None)
                or (last.ask is not None and partial.ask is not None
                    and np.array_equal(last.ask, partial.ask))
            )
        ):
            return False
        self._last_partial_depth = partial
        return True

    def _next_trade_seq(self) -> int:
        """Next per-session trade sequence number: 1..65535, then 1 again.

        0 is reserved for an unknown sequence (see proto/wire.py TRADE)."""
        self._trade_seq = self._trade_seq % 0xFFFF + 1
        return self._trade_seq
