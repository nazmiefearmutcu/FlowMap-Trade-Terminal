"""Translate Crocodile venue records into canonical FeedEvents.

:class:`_BridgeSink` is the testable translation seam between a Crocodile
connector and the crypto feed queue. The record-to-event table lives in
:mod:`flowmap_server.feeds.crypto`. :class:`_PolledCCXTConnector` brackets each
REST trade poll on its sink, so the sink knows where a poll window starts and ends.
"""

import logging
import math
import time
from bisect import bisect_left, insort
from collections.abc import Callable
from typing import Any

import numpy as np

from crocodile.core.schema.enums import Side
from crocodile.core.schema.records import (
    BookDelta,
    BookSnapshot,
    BookTicker,
    Level,
    Liquidation,
    Record,
)
from crocodile.core.schema.records import Trade as CTrade
from crocodile.core.sink.base import Sink
from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector

from flowmap_server.feeds.base import BookState, DropCounters, FeedEvent, ts_ns_sane
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

logger = logging.getLogger(__name__)


# Default cap per side on emitted BookState arrays; the closest-to-touch levels
# win. Overridable via Config.book_top_n / FLOWMAP_BOOK_TOP_N.
#
# This cap — not the grid — is what actually decides how far from the touch a
# resting order can be and still reach the client. At 2000 levels BTCUSDT is
# truncated a few hundred dollars from mid (well under 1%), so the wide/full
# price bands would render an empty far field no matter how tall the grid was.
# The sort below is over the FULL book either way, so raising the cap costs only
# a larger array build, not a bigger sort.
#
# Be honest about the remaining limit: venues also enforce order price-band
# filters (Binance PERCENT_PRICE / PERCENT_PRICE_BY_SIDE), so on the majors
# resting orders at +1000% of mid mostly cannot legally exist. A wide band shows
# what IS there; it cannot conjure liquidity the venue does not accept.
BOOK_TOP_N = 20_000


_SIDE_MAP = {Side.BUY: SIDE_BUY, Side.SELL: SIDE_SELL}


# Trade ids remembered per polled session for dedup. Comfortably larger than any
# venue's recent-trades window (ccxt returns at most a few hundred per fetch).
_SEEN_TRADE_IDS = 4096


def _count(metadata: dict[str, object], key: str) -> int:
    """An integer counter kept in connector metadata (absent or foreign -> 0)."""
    value = metadata.get(key, 0)
    return value if isinstance(value, int) else 0


class _BridgeSink(Sink):
    """Translate Crocodile records into canonical FeedEvents.

    Maintains the live L2 book as price->size dicts (absolute exchange sizes,
    inherently aggregated per price level). Sequencing is NOT re-checked here
    — see the module docstring. A ``BookSnapshot`` arriving while the book is
    already initialized is the connector's resync signature: emit
    ``Marker{kind=gap}`` first, then snapshot-replace.
    """

    def __init__(
        self,
        emit: Callable[[FeedEvent], None],
        book_top_n: int = BOOK_TOP_N,
        *,
        snapshot_driven: bool = False,
        now_ns: Callable[[], int] | None = None,
        stats: DropCounters | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        self._emit = emit
        self._metadata = metadata if metadata is not None else {}
        self._record: BookSnapshot | BookDelta | None = None
        self._revision = 0
        self._book_top_n = max(1, book_top_n)
        # Server-wide telemetry aggregate (duck-typed —
        # ``SessionStats`` is not imported so feeds stay import-light).
        self._stats = stats
        # Live-ingest timestamp sanity gate. A venue clock in the wrong
        # unit (ms/s stamped into the ns field) or wedged far ahead must not
        # write 1970-era / absurdly-future columns into the ring or the
        # recording. Injected for tests; production uses the wall clock.
        self._now_ns = now_ns or time.time_ns
        self.dropped_ts = 0
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        # Incrementally-maintained ASCENDING price indexes, one per side. They
        # are kept in lockstep with the dicts by ``_apply_levels`` — the only
        # production mutation path — so a book DELTA costs a few O(log N)
        # bisects + C memmoves instead of a full O(N log N) sort per delta.
        # ``None`` means "dirty: rebuild at next emit" (snapshot
        # replace, out-of-band dict mutation). ``_emit_book`` re-checks
        # ``len()`` so any index/dict divergence degrades to a one-shot
        # re-sort, never to a stale book.
        self._bid_px: list[float] | None = None
        self._ask_px: list[float] | None = None
        self._initialized = False
        # On a delta venue a re-snapshot means the connector lost sequence, so
        # it earns a gap marker. On a snapshot-driven venue (the ccxt path has
        # no incremental diff — it re-reads the whole book every tick) a
        # snapshot IS the normal update, and marking each one a gap would
        # invent a stream of resyncs that never happened.
        self._snapshot_driven = snapshot_driven
        # The ccxt REST poll has no `since` cursor and no dedup of its own: it
        # re-reads the venue's recent-trades window every interval, so the same
        # print arrives once per poll. Left alone that multiplies tape volume
        # and CVD under a `tape: "tick"` badge. Only polled feeds need this, and
        # a bounded ring keeps it O(1) — a venue that reuses trade ids across a
        # long session would at worst drop one print, which is the safer error.
        self._seen_ids: dict[object, None] = {}
        # Identical id-less prints seen so far in the trade poll in progress, keyed
        # by content. None outside a poll window (see begin_poll).
        self._poll_counts: dict[tuple[object, ...], int] | None = None

    async def put(self, record: Record) -> None:
        if not ts_ns_sane(self._ts(record), now_ns=self._now_ns()):
            self.dropped_ts += 1
            if self.dropped_ts == 1:
                # First bad stamp is worth one warning (a clock that slips
                # back to sane must not be missed); the rest only count.
                logger.warning(
                    "crypto bridge: dropped sample with implausible ts_ns=%r "
                    "(outside [2010, now+24h]); dropped_ts=%d",
                    self._ts(record),
                    self.dropped_ts,
                )
            if self._stats is not None:
                self._stats.inc_snapshot_drops()
            return
        if isinstance(record, BookDelta):
            if not self._initialized:
                return  # pre-snapshot deltas carry no anchored state
            self._observe_book(record, snapshot=False)
            self._bid_px = self._apply_levels(record.bids, self._bids, self._bid_px)
            self._ask_px = self._apply_levels(record.asks, self._asks, self._ask_px)
            self._emit_book(self._ts(record))
        elif isinstance(record, BookSnapshot):
            self._observe_book(record, snapshot=True)
            if self._initialized and not self._snapshot_driven:
                self._emit(
                    Marker(
                        ts_ns=self._ts(record),
                        kind="gap",
                        text=f"book resync: snapshot seq={record.sequence_id}",
                    )
                )
            self._bids.clear()
            self._asks.clear()
            # Full replace: the incremental indexes are invalid wholesale —
            # mark dirty and rebuild once at emit (one sort, same as before).
            self._bid_px = None
            self._ask_px = None
            self._apply_levels(record.bids, self._bids, None)
            self._apply_levels(record.asks, self._asks, None)
            self._initialized = True
            self._emit_book(self._ts(record))
        elif isinstance(record, CTrade):
            # The side is exchange-true only when the venue actually published
            # one. ccxt's unified trade `side` is optional, and its normalizer
            # maps anything that is not "buy"/"sell" to Side.UNKNOWN — stamping
            # SIDE_SRC_EXCHANGE on that would tell the client an unknown
            # aggressor was venue-confirmed, and the grid drops those prints
            # from CVD anyway. Say NA and let the tape show it.
            key = self._trade_key(record) if self._snapshot_driven else None
            if key is not None and self._is_duplicate(key):
                return
            side = _SIDE_MAP.get(record.side)
            self._emit(
                Trade(
                    ts_ns=self._ts(record),
                    price=record.price,
                    size=record.amount,
                    side=side if side is not None else SIDE_UNKNOWN,
                    side_src=SIDE_SRC_EXCHANGE if side is not None else SIDE_SRC_NA,
                    venue=record.source,
                )
            )
        elif isinstance(record, BookTicker):
            self._emit(
                BBO(
                    ts_ns=self._ts(record),
                    bid_px=record.bid_px,
                    bid_sz=record.bid_sz,
                    ask_px=record.ask_px,
                    ask_sz=record.ask_sz,
                )
            )
        elif isinstance(record, Liquidation):
            self._emit(
                Marker(
                    ts_ns=self._ts(record),
                    kind="liquidation",
                    text=f"liquidation {record.side} {record.amount:g} @ {record.price:g}",
                    price=record.price,
                    size=record.amount,
                )
            )
        # Funding / DerivativeTicker / OpenInterest / ...: not part of the
        # canonical dialect — dropped silently by design.

    def _observe_book(self, record: BookSnapshot | BookDelta, *, snapshot: bool) -> None:
        changed = not self._initialized
        for levels, side in ((record.bids, self._bids), (record.asks, self._asks)):
            valid = {
                p: q
                for p, q in levels
                if math.isfinite(p) and math.isfinite(q) and p > 0 and q >= 0
            }
            if snapshot:
                changed |= {p: q for p, q in valid.items() if q > 0} != side
            else:
                changed |= any(side.get(p, 0.0) != q for p, q in valid.items())
        self._record = record
        self._metadata["source_book_events"] = _count(self._metadata, "source_book_events") + 1
        if changed:
            self._revision += 1
            self._metadata["unique_book_changes"] = (
                _count(self._metadata, "unique_book_changes") + 1
            )

    def begin_poll(self) -> None:
        """Open the window of one REST poll of the trade channel."""
        self._poll_counts = {}

    def end_poll(self) -> None:
        """Close the window opened by :meth:`begin_poll`."""
        self._poll_counts = None

    def _trade_key(self, record: CTrade) -> object | None:
        """Identity of a polled print, or ``None`` when it is not deduplicated.

        A print with a venue trade id is keyed by that id. Each poll re-reads the
        venue's recent-trades window, so a print from an earlier poll comes back
        unchanged. A venue that omits ids is keyed by content (time, price, size,
        side) plus how many identical prints this poll has already passed. Venue
        timestamps have millisecond resolution, so two genuine fills with the same
        content in one millisecond are common. Counting them keeps both, while the
        same window re-read on the next poll still matches the copies already
        emitted. Outside a poll window nothing is re-read, so an id-less print is
        kept as delivered.
        """
        if record.id:
            return record.id
        if self._poll_counts is None:
            return None
        content = (self._ts(record), record.price, record.amount, record.side)
        seen = self._poll_counts.get(content, 0)
        self._poll_counts[content] = seen + 1
        return (content, seen)

    def _is_duplicate(self, key: object) -> bool:
        """True when this polled feed already emitted the print identified by *key*."""
        if key in self._seen_ids:
            return True
        self._seen_ids[key] = None
        if len(self._seen_ids) > _SEEN_TRADE_IDS:
            # dicts preserve insertion order, so this evicts the oldest.
            del self._seen_ids[next(iter(self._seen_ids))]
        return False

    async def flush(self) -> None:
        return None

    @staticmethod
    def _ts(record: Record) -> int:
        # Record header: the venue clock is `source_ts` for both asset classes.
        # Still optional: a venue that stamps nothing falls back to our receive
        # clock.
        ts = record.source_ts
        return ts if ts is not None else record.local_ts

    def _apply_levels(
        self,
        levels: list[Level],
        side: dict[float, float],
        index: list[float] | None,
    ) -> list[float] | None:
        """Canonical level semantics (mirrors OrderBook._apply_levels):
        amount==0 removes the price level, amount>0 sets the absolute size.
        Malformed levels are skipped, never raised — one bad level must not
        DLQ a whole depth message and silently desync the book.

        When *index* is not ``None`` (the DELTA path) it is maintained
        incrementally: each inserted price is ``insort``-ed, each removed one
        bisect-popped — O(log N) search + a C memmove per level instead of
        re-sorting the whole side. A ``None`` index (snapshot replace) leaves
        the book dirty; ``_emit_book`` rebuilds the index with one sort."""
        for price, amount in levels:
            if (
                not math.isfinite(price)
                or not math.isfinite(amount)
                or not (price > 0.0)
                or amount < 0.0
            ):
                logger.debug("skipping malformed level (%r, %r)", price, amount)
                continue
            if amount == 0.0:
                if side.pop(price, None) is not None and index is not None:
                    i = bisect_left(index, price)
                    if i < len(index) and index[i] == price:
                        del index[i]
            else:
                if price not in side and index is not None:
                    insort(index, price)
                side[price] = amount
        return index

    def _emit_book(self, ts_ns: int) -> None:
        # Best-first, closest-to-touch BOOK_TOP_N levels per side. The price
        # ORDER comes from the incrementally-maintained indexes (rebuilt by a
        # single sort here when dirty); sizes are read from the dicts at emit
        # time, so the emitted arrays are exactly what sorting the whole dict on
        # every delta would produce — at delta rates that sort (up to
        # BOOK_TOP_N=20000 entries, twice per tick) is avoided.
        cap = self._book_top_n
        bid_index = self._bid_px
        if bid_index is None or len(bid_index) != len(self._bids):
            bid_index = sorted(self._bids)
            self._bid_px = bid_index
        ask_index = self._ask_px
        if ask_index is None or len(ask_index) != len(self._asks):
            ask_index = sorted(self._asks)
            self._ask_px = ask_index
        # Bids descend (reversed ascending tail = highest price first), asks
        # ascend — the exact ordering the full sort produced (dict keys are
        # unique, so no tie-breaking existed to preserve).
        top_bids = bid_index[-cap:] if cap < len(bid_index) else bid_index
        top_asks = ask_index[:cap]
        bids = [(p, self._bids[p]) for p in reversed(top_bids)]
        asks = [(p, self._asks[p]) for p in top_asks]
        bid = np.array(bids, dtype=np.float64).reshape(-1, 2)
        ask = np.array(asks, dtype=np.float64).reshape(-1, 2)
        self._emit(
            BookState(
                ts_ns=ts_ns,
                bid_px=bid[:, 0],
                bid_sz=bid[:, 1],
                ask_px=ask[:, 0],
                ask_sz=ask[:, 1],
                sequence_id=getattr(
                    self._record, "seq_id", getattr(self._record, "sequence_id", None)
                ),
                prev_sequence_id=getattr(self._record, "prev_seq_id", None),
                source=self._record.source if self._record else None,
                provenance=self._record.prov.value if self._record else None,
                observed_ns=self._record.local_ts if self._record else None,
                revision=self._revision,
            )
        )


class _PolledCCXTConnector(CCXTConnector):
    """The universal ccxt connector, with each trade poll bracketed on its sink.

    The sink dedupes id-less prints within one poll window, so it must know where
    a window starts and ends. The vendored connector reads a channel's window in
    ``_poll_one`` and only then puts the prints, so that call is the window.
    """

    async def _poll_one(self, ex: Any, channel: str, unified: str) -> int:
        out = self.out
        if channel != "trade" or not isinstance(out, _BridgeSink):
            return await super()._poll_one(ex, channel, unified)
        out.begin_poll()
        try:
            return await super()._poll_one(ex, channel, unified)
        finally:
            out.end_poll()
