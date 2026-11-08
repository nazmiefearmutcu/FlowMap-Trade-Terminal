"""Keyed-tier translation: Crocodile equity records to canonical FeedEvents.

US tapes carry no aggressor side, so the side is inferred and marked
``side_src=inferred``. The quote rule runs when a streamed BBO is available, and the
tick rule runs otherwise.
"""

import logging
import math
import time
from collections.abc import Callable

import numpy as np

from crocodile.core.schema.records import Quote as EqQuote
from crocodile.core.schema.records import Trade as EqTrade

from flowmap_server.feeds.base import BookState, DropCounters, FeedEvent, ts_ns_sane
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    Trade,
)

logger = logging.getLogger(__name__)


class _EquitySink:
    """Translate Crocodile equity records -> canonical events (keyed tiers).

    US tapes carry no aggressor side, so it is inferred and stamped
    ``side_src=inferred``:

    - **quote rule** (alpaca, ``use_quote_rule=True``): trade above the last
      streamed BBO midpoint is a buy, below a sell, at the mid falls back to
      the tick rule;
    - **tick rule** (finnhub): up-tick buy, down-tick sell, flat carries the
      previous side; the first print defaults to buy (any fixed default is
      equally arbitrary — documented in the reference feed).

    Implements just enough of :class:`crocodile.core.sink.base.Sink` (``put`` /
    ``flush``) to run inside ``collect``'s TaskGroup; not a real Parquet sink.
    """

    def __init__(
        self,
        emit: Callable[[FeedEvent], None],
        *,
        use_quote_rule: bool,
        now_ns: Callable[[], int] | None = None,
        stats: DropCounters | None = None,
    ) -> None:
        self._emit = emit
        self._use_quote_rule = use_quote_rule
        # Server-wide telemetry aggregate (duck-typed).
        self._stats = stats
        # Live-ingest timestamp sanity gate: a provider clock in the
        # wrong unit or wedged in the far future must not enter the ring or the
        # recording. Injected for tests; production uses the wall clock.
        self._now_ns = now_ns or time.time_ns
        self.dropped_ts = 0
        # Quotes rejected for a non-positive or non-finite price/size (no BBO emitted).
        self.dropped_quotes = 0
        self._last_px: float | None = None
        self._last_side = SIDE_BUY
        self._bbo: tuple[float, float] | None = None  # (bid_px, ask_px)

    async def put(self, record: object) -> None:
        if isinstance(record, (EqTrade, EqQuote)):
            ts = _rec_ts(record)
            if not ts_ns_sane(ts, now_ns=self._now_ns()):
                self.dropped_ts += 1
                if self.dropped_ts == 1:
                    # One warning for the first bad stamp (a provider clock
                    # that slips back to sane must not be missed); the rest
                    # only count.
                    logger.warning(
                        "equity feed: dropped sample with implausible ts_ns=%r "
                        "(outside [2010, now+24h]); dropped_ts=%d",
                        ts,
                        self.dropped_ts,
                    )
                if self._stats is not None:
                    self._stats.inc_snapshot_drops()
                return
        if isinstance(record, EqTrade):
            # The record carries a `side` field, but every US equity provider fills
            # it with Side.UNKNOWN — the consolidated tape does not publish the
            # aggressor. Promoting a non-UNKNOWN side to `SIDE_SRC_EXCHANGE` would be
            # wrong twice over: it would read the field instead of the record's
            # `prov` block, so a provider-side inference would be laundered into
            # "exchange-true", and it would contradict this tier's own
            # `trade_side: "inferred"` badge. Inference is the honest answer here,
            # and it must run on EVERY print or the tick rule's `_last_px`/`_last_side`
            # go stale.
            self._emit(
                Trade(
                    ts_ns=_rec_ts(record),
                    price=float(record.price),
                    size=float(record.amount),
                    side=self._infer_side(float(record.price)),
                    side_src=SIDE_SRC_INFERRED,
                    venue=record.source,
                )
            )
        elif isinstance(record, EqQuote) and self._use_quote_rule:
            bid_px, ask_px = float(record.bid_px), float(record.ask_px)
            bid_sz, ask_sz = float(record.bid_sz), float(record.ask_sz)
            ts = _rec_ts(record)
            # Prices must be strictly positive: Alpaca sends a 0 price to mean "no
            # quote on this side" (at the open, on illiquid names, or during a
            # halt). Such a frame is no quote at all, so neither the BBO nor the
            # depth column may be emitted from it, and it must not replace the
            # last usable BBO that the quote rule classifies trades against.
            prices_ok = math.isfinite(bid_px) and bid_px > 0.0 and math.isfinite(ask_px) and ask_px > 0.0
            sizes_ok = math.isfinite(bid_sz) and bid_sz >= 0.0 and math.isfinite(ask_sz) and ask_sz >= 0.0
            if not (prices_ok and sizes_ok):
                self.dropped_quotes += 1
                if self.dropped_quotes == 1:
                    logger.warning(
                        "equity feed: dropped invalid quote (bid=%r ask=%r bid_sz=%r ask_sz=%r); "
                        "dropped_quotes=%d",
                        bid_px,
                        ask_px,
                        bid_sz,
                        ask_sz,
                        self.dropped_quotes,
                    )
                return
            self._bbo = (bid_px, ask_px)
            self._emit(
                BBO(ts_ns=ts, bid_px=bid_px, bid_sz=bid_sz, ask_px=ask_px, ask_sz=ask_sz)
            )
            # Real L1 top-of-book as a two-sided depth column (fills the keyed
            # depth channel; badge stays honest `L1`). Displayed sizes are round
            # lots, far under the grid's float16 ceiling — emitted raw so the
            # true bid/ask size imbalance survives.
            self._emit(
                BookState(
                    ts_ns=ts,
                    bid_px=np.array([bid_px], dtype=np.float64),
                    bid_sz=np.array([bid_sz], dtype=np.float64),
                    ask_px=np.array([ask_px], dtype=np.float64),
                    ask_sz=np.array([ask_sz], dtype=np.float64),
                )
            )
        # Bars/fundamentals/status/etc.: not part of the canonical tape dialect.

    async def flush(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def _infer_side(self, price: float) -> int:
        if self._use_quote_rule and self._bbo is not None:
            bid, ask = self._bbo
            if math.isfinite(bid) and math.isfinite(ask):
                mid = 0.5 * (bid + ask)
                if price > mid:
                    side = SIDE_BUY
                elif price < mid:
                    side = SIDE_SELL
                else:
                    side = self._flat_side(price)
            else:
                side = self._flat_side(price)
        else:
            side = self._flat_side(price)
        self._last_px = price
        self._last_side = side
        return side

    def _flat_side(self, price: float) -> int:
        prev = self._last_px
        if prev is None or price > prev:
            return SIDE_BUY
        if price < prev:
            return SIDE_SELL
        return self._last_side


def _rec_ts(record: EqTrade | EqQuote) -> int:
    return int(record.source_ts if record.source_ts is not None else record.local_ts)
