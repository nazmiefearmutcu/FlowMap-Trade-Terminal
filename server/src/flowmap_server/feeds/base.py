"""Feed abstraction shared by all data sources (sim, crypto, ...).

A feed is an async stream of canonical events:

- :class:`BookState` — full L2 snapshot (price/size arrays per side). This is
  a feed-layer type only; the grid consumes it via ``Grid.on_book`` and the
  wire never carries it.
- :class:`~flowmap_server.proto.events.Trade` and
  :class:`~flowmap_server.proto.events.Marker` are reused from proto.events
  (NOT duplicated) so downstream code speaks one dialect.

The :class:`Feed` protocol is deliberately minimal: an ``events()`` async
iterator plus ``market`` / ``symbol`` / ``capability`` attributes. ``events()``
is declared as a plain ``def`` returning ``AsyncIterator`` — that is the shape
an ``async def`` generator method presents to callers.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator, Callable
from typing import Generic, Protocol, TypeVar, runtime_checkable

import msgspec
import numpy as np

from flowmap_server.proto.events import BBO, Marker, Trade

__all__ = [
    "BookState",
    "BarSample",
    "BoundedFeedQueue",
    "DropCounters",
    "FEED_QUEUE_MAXSIZE",
    "Feed",
    "FeedEvent",
    "TS_FLOOR_NS",
    "TS_HORIZON_NS",
    "ts_ns_sane",
]


logger = logging.getLogger(__name__)


class BookState(msgspec.Struct):
    """Full order-book snapshot observed at ``ts_ns``.

    ``bid_px``/``bid_sz`` and ``ask_px``/``ask_sz`` are parallel float64
    arrays; levels need not be contiguous or sorted (the grid scatters by
    price). Producers must emit finite values only.
    """

    ts_ns: int
    bid_px: np.ndarray
    bid_sz: np.ndarray
    ask_px: np.ndarray
    ask_sz: np.ndarray
    sequence_id: int | None = None
    prev_sequence_id: int | None = None
    source: str | None = None
    provenance: str | None = None
    observed_ns: int | None = None
    revision: int = 0


class BarSample(msgspec.Struct):
    """Published OHLCV sample for a display overlay, never a received print.

    Feed-only input: the session aggregates it into BarColumn and does not
    append it to tape, infer an aggressor, or record a fabricated Trade.
    """

    ts_ns: int
    o: float
    h: float
    l: float
    c: float
    volume: float


FeedEvent = BookState | BarSample | Trade | Marker | BBO


# -- live-ingest timestamp sanity (venue clocks are hostile) --------------------

# Conservative LOWER bound on a plausible market-data stamp: 2010-01-01 UTC.
# Real venue data is never older; anything below is a broken clock or a unit
# mixup (seconds/ms stamped into the ns field lands here), not history.
TS_FLOOR_NS = 1_262_304_000_000_000_000
# Conservative UPPER slack over our own clock: a venue clock skewed up to a
# day ahead is tolerated; beyond that the stamp is nonsense, not "future data".
TS_HORIZON_NS = 24 * 60 * 60 * 10**9


def ts_ns_sane(ts_ns: int, *, now_ns: int) -> bool:
    """True when *ts_ns* is plausible as a LIVE market-data timestamp.

    Rejects non-positive stamps, 1970-era stamps (the ms/ns mixup signature)
    via :data:`TS_FLOOR_NS`, and anything further than :data:`TS_HORIZON_NS`
    ahead of *now_ns*. Applied ONLY at the live ingestion boundaries
    (crypto/equity bridges) — recorded or replayed history is never re-gated.
    """
    return TS_FLOOR_NS <= ts_ns <= now_ns + TS_HORIZON_NS


# -- bounded feed fan-in ---------------------------------------------------------

# Cap on the connector->consumer queue inside a feed's ``events()``. Generous:
# it only fills when the consumer stalls, and then drop-oldest keeps the feed's
# RSS bounded instead of growing without limit on a stuck session.
FEED_QUEUE_MAXSIZE = 8192


_QueueItemT = TypeVar("_QueueItemT")


class DropCounters(Protocol):
    """The drop counters a feed reports into (``core.stats.SessionStats``).

    Duck-typed on purpose: the feeds layer does not import the core telemetry."""

    def inc_feed_drops(self, n: int = 1) -> None: ...

    def inc_snapshot_drops(self, n: int = 1) -> None: ...


class BoundedFeedQueue(Generic[_QueueItemT]):
    """A bounded ``asyncio.Queue`` with drop-OLDEST semantics for feed fan-in.

    The connector task produces via :meth:`put_nowait` (never blocks, never
    raises on overflow): when the queue is full the OLDEST unconsumed event is
    discarded and :attr:`dropped` counts it. A stalled consumer therefore
    degrades to a short tape rather than unbounded memory. The connector's
    terminal sentinel (enqueued as the producer's final act) can never be the
    item dropped — no put follows it — so end-of-stream delivery is intact.
    """

    def __init__(
        self,
        maxsize: int = FEED_QUEUE_MAXSIZE,
        on_drop: Callable[[], None] | None = None,
    ) -> None:
        self._items: deque[_QueueItemT] = deque()
        self._maxsize = max(1, maxsize)
        self._arrived = asyncio.Event()
        self.dropped = 0
        # Markers (gap, liquidation, session_break) are evicted only when nothing
        # else is left to evict; this counts the ones that were lost anyway.
        self.markers_dropped = 0
        # Optional telemetry hook: fired on every drop-OLDEST
        # eviction so the server-wide stats aggregate can count feed drops
        # without polling per-feed counters. Must never raise into the producer.
        self.on_drop = on_drop

    def put_nowait(self, item: _QueueItemT) -> None:
        items = self._items
        if len(items) >= self._maxsize:
            self._evict_one()
        items.append(item)
        self._arrived.set()

    def _evict_one(self) -> None:
        """Drop the oldest item, but keep a Marker when a non-Marker can go instead.

        A Marker is the only record of a gap or a halt, and the client is never
        told when one is lost, so trades (which a later tick replaces) are the
        cheaper thing to lose."""
        items = self._items
        victim = 0
        if isinstance(items[0], Marker):
            for index, candidate in enumerate(items):
                if not isinstance(candidate, Marker):
                    victim = index
                    break
        if victim == 0:
            dropped = items.popleft()
        else:
            dropped = items[victim]
            del items[victim]
        self.dropped += 1
        if isinstance(dropped, Marker):
            self.markers_dropped += 1
        if self.on_drop is not None:
            try:
                self.on_drop()
            except Exception:  # telemetry must not kill the feed
                logger.debug("drop telemetry hook failed", exc_info=True)

    async def get(self) -> _QueueItemT:
        items = self._items
        while not items:
            self._arrived.clear()
            await self._arrived.wait()
        return items.popleft()

    def qsize(self) -> int:
        return len(self._items)


@runtime_checkable
class Feed(Protocol):
    """Minimal contract every feed (sim, crypto, equity) implements.

    Restart contract: ``events()`` MUST be re-callable after a crash — the
    session layer restarts a crashed (or normally-ended) feed by calling
    ``events()`` again on the same instance. On re-call the feed SHOULD
    resume from current/live data, not replay history. SimFeed replays
    deterministically from ``start_ns``, which is acceptable for the sim;
    real feeds (crypto) must reconnect and resume live.

    Optional declaration (not part of the structural check): a feed MAY carry
    ``preferred_tick: float`` — the venue's price tick for its own symbols.
    The crypto grid honors it when present and finite (see
    ``core.session._crypto_tick_for``); absent means "no opinion".

    A feed whose symbols can be priced far below the fixed crypto fallback
    tick MAY additionally declare ``price_adaptive_tick: bool = True``: when
    NEITHER an explicit FLOWMAP_CRYPTO_TICK nor a ``preferred_tick`` answers,
    the grid then scales the tick to the instrument's price magnitude at the
    first real mid (``core.grid.adaptive_tick_for``) so sub-dollar symbols get
    a sane frame and a resolvable book. BTC/ETH keep the fallback (it is
    already fine for their price). Absent/False means "never".
    """

    market: str
    symbol: str
    capability: dict[str, object]

    def events(self) -> AsyncIterator[FeedEvent]: ...
