"""Volume-at-price profile behind the keyless SYNTH depth tier.

Each one-minute bar contributes its volume to one cent bucket at its typical price.
The profile is normalized to a bounded peak before it reaches the wire, so the grid's
float16 ring never overflows on a liquid name.
"""

import math

import numpy as np

from crocodile.core.schema.records import OHLCV as EqBar

from flowmap_server.feeds.base import BookState

__all__ = ["DEFAULT_PROFILE_TICK", "PROFILE_PEAK_TARGET"]


# SYNTH profile price granularity: US equities quote in cents. Bar volume is
# bucketed to this tick before the grid re-buckets to its own rows.
DEFAULT_PROFILE_TICK = 0.01
# SYNTH profile normalized peak. Each emitted volume-at-price column is rescaled
# so its densest bucket equals this: a bounded *relative* intensity, NOT a share
# count. A liquid name's raw cumulative shares (tens of millions) would overflow
# the grid's float16 ring/wire (max 65 504) to ``inf``. Normalizing per column
# keeps every texel ~1e3 (≈65× headroom) no matter how large the session's
# cumulative volume grows, and, unlike a fixed divisor on an unbounded cumulative
# sum, can never creep back into overflow. Between-bucket ratios (hence the
# point-of-control) are preserved.
PROFILE_PEAK_TARGET = 1000.0


def _bar_ts(bar: EqBar) -> int:
    """A bar's canonical UTC-ns timestamp (source over local)."""
    return int(bar.source_ts if bar.source_ts is not None else bar.local_ts)


def _bar_finite(bar: EqBar) -> bool:
    """True iff the bar's OHLCV are all finite and volume is non-negative.

    Yahoo bars can carry gaps (already dropped in the client), but NaN/inf can
    still slip through resampling — a poisoned typical price would scatter a
    non-finite density texel, so bad bars are skipped, never emitted."""
    vals = (bar.open, bar.high, bar.low, bar.close, bar.volume)
    return all(v is not None and math.isfinite(v) for v in vals) and bar.volume >= 0.0


def _typical_price(bar: EqBar) -> float:
    """Bar typical price ``(H+L+C)/3`` — the volume-at-price anchor and the
    same convention the approximate VWAP uses."""
    return (bar.high + bar.low + bar.close) / 3.0


class _ProfileBuilder:
    """Accumulates 1 m bars into a cumulative volume-at-price density.

    Each bar contributes its whole volume to exactly one cent bucket (its
    typical price), so the internal accumulation conserves volume
    (:meth:`total_volume` is the true summed share volume). Bucketing by integer
    index avoids float-key drift. :meth:`book_state` emits a *normalized* view of
    that profile — rescaled so the peak bucket == ``PROFILE_PEAK_TARGET`` — which
    keeps the wire/grid density bounded far below float16's ceiling for any
    cumulative total (the raw shares would overflow the grid's f16 ring to
    ``inf``)."""

    def __init__(self, tick: float = DEFAULT_PROFILE_TICK) -> None:
        if not (tick > 0.0):
            raise ValueError("profile tick must be positive")
        self._tick = tick
        self._buckets: dict[int, float] = {}

    def add_bar(self, bar: EqBar) -> bool:
        """Add one bar's volume at its typical price. Returns False (skipped)
        for non-finite/negative-volume bars or a non-positive typical price."""
        if not _bar_finite(bar):
            return False
        tp = _typical_price(bar)
        if not (tp > 0.0):
            return False
        idx = int(round(tp / self._tick))
        self._buckets[idx] = self._buckets.get(idx, 0.0) + float(bar.volume)
        return True

    def total_volume(self) -> float:
        return float(sum(self._buckets.values()))

    def has_profile(self) -> bool:
        """True once at least one finite bar contributed volume."""
        return bool(self._buckets)

    def book_state(self, ts_ns: int, ref: float | None = None) -> BookState:
        """The cumulative volume-at-price profile as a **two-sided** normalized
        :class:`BookState`, split at ``ref`` (engine ``split_ladder``
        semantics): buckets with ``price <= ref`` are the bid channel, ``price >
        ref`` the ask channel. The occupied buckets carry the profile's SHAPE
        rescaled so its **combined** (bid+ask) peak == ``PROFILE_PEAK_TARGET``.

        The single combined scale factor keeps between-bucket ratios — hence the
        point-of-control and the *cross-side* bid/ask intensity comparison —
        exact, while bounding every texel far below float16's ceiling for any
        cumulative total (a liquid name's raw cumulative shares, tens of millions,
        would overflow the grid's float16 ring to ``inf``). The ask
        side legitimately shrinks/vanishes when ``ref`` sits near the profile's
        top (little volume traded above the current price — an honest asymmetry).

        ``ref is None`` keeps the one-sided shape (everything on bid, ask
        empty) for callers that have no reference price."""
        if not self._buckets:
            empty = np.empty(0, dtype=np.float64)
            return BookState(
                ts_ns=int(ts_ns), bid_px=empty, bid_sz=empty, ask_px=empty, ask_sz=empty
            )
        idxs = np.fromiter(sorted(self._buckets), dtype=np.int64)
        px = idxs.astype(np.float64) * self._tick
        raw = np.array([self._buckets[int(i)] for i in idxs], dtype=np.float64)
        peak = float(raw.max())
        # Combined-peak normalization BEFORE the split: bounded by construction,
        # so a growing cumulative sum can never creep back into f16 overflow and
        # the bid/ask magnitudes stay directly comparable.
        sz = raw * (PROFILE_PEAK_TARGET / peak) if peak > 0.0 else raw
        empty = np.empty(0, dtype=np.float64)
        if ref is None:
            return BookState(
                ts_ns=int(ts_ns), bid_px=px, bid_sz=sz, ask_px=empty, ask_sz=empty
            )
        bid_mask = px <= float(ref)
        ask_mask = ~bid_mask
        return BookState(
            ts_ns=int(ts_ns),
            bid_px=px[bid_mask],
            bid_sz=sz[bid_mask],
            ask_px=px[ask_mask],
            ask_sz=sz[ask_mask],
        )
