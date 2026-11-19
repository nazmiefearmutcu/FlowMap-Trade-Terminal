"""Canonical trade accumulation for OHLC, directional volume, CVD and VWAP."""

from __future__ import annotations
import math
from typing import TYPE_CHECKING
from flowmap_server.proto.events import SIDE_BUY, SIDE_SELL

if TYPE_CHECKING:
    from flowmap_server.core.grid import Grid


def accumulate_trade(grid: Grid, ts_ns: int, price: float, size: float, side: int) -> None:
    """Feed a trade into the current interval's bar accumulators.

    Never advances intervals or finalizes columns — time advancement is
    driven by :meth:`on_book`. A trade arriving before any book update
    anchors the current interval at ``ts_ns // dt_ns``.

    A malformed print (non-finite or non-positive price, non-finite or
    negative size) is ignored ENTIRELY — not even time-anchoring:
    ``cvd_cum`` and the ``vwap_*`` sums are session-cumulative, so a
    single NaN or negative print would poison every later bar, and a
    ``+inf`` price would do the same through ``vwap_num_cum`` forever
    (``price > 0`` alone admits it). Same rationale as the finite
    filter in ``_map_levels``; the raw print still reaches the tape and
    the recording via the session, only the DERIVED aggregates are
    protected. A zero-size print is kept (some venues publish them at the
    real price; dropping them would skew OHLC away from venue truth).
    """
    if not (price > 0.0) or not math.isfinite(price) or not math.isfinite(size) or size < 0.0:
        return
    if grid._cur_idx is None:
        grid._cur_idx = ts_ns // grid._cfg.dt_ns
        grid._prev_ts = ts_ns
    # Interval boundaries advance only in on_book. A print stamped outside
    # the forming interval (already past its end, because the next book has
    # not arrived yet, or late) is tallied in out_of_interval_trades and
    # still folded into this bar as it always was: dropping it would remove
    # volume from the bars while session CVD kept it, breaking their sum.
    # Attributing it to its own bar needs held prints.
    if ts_ns // grid._cfg.dt_ns != grid._cur_idx:
        grid.out_of_interval_trades += 1

    if grid._bar_has_trade:
        grid._h = max(grid._h, price)
        grid._l = min(grid._l, price)
    else:
        grid._o = grid._h = grid._l = price
        grid._bar_has_trade = True
    grid._c = price

    if side == SIDE_BUY:
        grid._vol_buy += size
        grid._cvd_cum += size
    elif side == SIDE_SELL:
        grid._vol_sell += size
        grid._cvd_cum -= size
    # SIDE_UNKNOWN: neither volume bucket, cvd unchanged.
    grid._vwap_num_cum += price * size
    grid._vwap_den_cum += size
