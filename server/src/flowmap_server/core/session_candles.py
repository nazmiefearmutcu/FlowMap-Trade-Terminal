"""Atomic candle-only viewport replacement; existing streaming grids are unchanged.

The source states only the minutes it published trades for. A missing minute is never
filled with a price: a short gap (at most ``GAP_FILL_MINUTES``) is drawn as empty columns, so
the hole is visible where it is, and a longer one (a session break, a weekend, a missing
stretch of files) is not drawn minute by minute but marked with a ``gap`` marker on the first
candle after it, naming the missing span.
"""
from __future__ import annotations

import datetime as dt
import math
from typing import TYPE_CHECKING

import msgspec
import numpy as np

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.feeds.base import CandleSample, CandleSnapshot
from flowmap_server.proto import events

if TYPE_CHECKING:
    from flowmap_server.core.session_core import Session


GAP_FILL_MINUTES = 120
"""The longest run of missing minutes drawn as empty columns; a longer one gets a marker."""

_MINUTE_NS = 60_000_000_000


def _utc(ns: int) -> str:
    return dt.datetime.fromtimestamp(ns / 1e9, dt.UTC).strftime("%Y-%m-%d %H:%M")


def _with_gaps(
    candles: tuple[CandleSample, ...],
) -> tuple[list[CandleSample | int], list[events.Marker]]:
    """The candles in time order with every short gap's missing minutes as their start time
    (an int), and one marker per long gap."""
    out: list[CandleSample | int] = []
    markers: list[events.Marker] = []
    previous: int | None = None
    for candle in candles:
        if previous is not None:
            missing = (candle.ts_ns - previous) // _MINUTE_NS - 1
            if 0 < missing <= GAP_FILL_MINUTES:
                out.extend(previous + k * _MINUTE_NS for k in range(1, missing + 1))
            elif missing > GAP_FILL_MINUTES:
                markers.append(events.Marker(
                    ts_ns=candle.ts_ns,
                    kind="gap",
                    text=(f"no published data {_utc(previous + _MINUTE_NS)} to "
                          f"{_utc(candle.ts_ns)} UTC ({missing} min)"),
                ))
        out.append(candle)
        previous = candle.ts_ns
    return out, markers


def candle_grid(*, rows: int, ring_columns: int) -> Grid:
    return Grid(GridCfg(tick=0.01, tick_multiple=1, dt_ns=60_000_000_000, p0=0,
                        rows=min(128, rows), ring_columns=ring_columns,
                        mode=events.MODE_SYNTH_PROFILE))


def apply_candle_snapshot(session: Session, snapshot: CandleSnapshot) -> None:
    """Rebuild cumulative values from the bounded snapshot, never add a revision."""
    session._set_feed_state('degraded' if getattr(session._feed, 'feed_state', None) == 'degraded' else 'live')
    candles = snapshot.candles[-session.grid.cfg.ring_columns:]
    # A byte comparison also treats missing-price NaNs as unchanged.
    signature = msgspec.msgpack.encode(candles)
    if getattr(session, '_candle_signature', None) == signature:
        session._publish_status()
        return
    session._candle_signature = signature
    cfg = session.grid.cfg
    prices = [p for c in candles for p in (c.l, c.h) if math.isfinite(p)]
    if prices:
        low, high = min(prices), max(prices)
        margin = max((high - low) * .1, abs(high) * .001, cfg.tick * 2)
        multiple = max(1, math.ceil((high - low + 2 * margin) / (cfg.rows * cfg.tick)))
        p0 = math.floor((low - margin) / (cfg.tick * multiple)) * (cfg.tick * multiple)
        cfg = msgspec.structs.replace(cfg, p0=p0, tick_multiple=multiple)
    epoch = session.grid.current_epoch_params().epoch + 1
    grid = Grid(cfg, initial_epoch=epoch)
    ep = grid.current_epoch_params()
    zero = np.zeros(cfg.rows, dtype=np.float32)
    columns = []
    num = den = 0.0
    nan = float("nan")
    entries, gap_markers = _with_gaps(tuple(sorted(candles, key=lambda c: c.ts_ns)))
    # The ring holds the newest columns, empty ones included.
    entries = entries[-cfg.ring_columns:]
    for seq, entry in enumerate(entries):
        if isinstance(entry, int):
            # A minute the source published nothing for: no price, no quantity.
            bar = events.BarColumn(epoch, seq, entry, nan, nan, nan, nan, 0, 0, 0, num, den)
            columns.append(FinalizedColumn(epoch, seq, entry, zero, zero, bar))
            continue
        candle = entry
        if candle.volume > 0 and math.isfinite(candle.vwap):
            num += candle.vwap * candle.volume
            den += candle.volume
        bar = events.BarColumn(epoch, seq, candle.ts_ns, candle.o, candle.h, candle.l,
                               candle.c, 0, 0, 0, num, den)
        columns.append(FinalizedColumn(epoch, seq, candle.ts_ns, zero, zero, bar))
    grid.preload(columns, [ep])
    # All mutable ring state is swapped before any client can observe it.
    session._grid = grid
    session._enc_cache.clear()
    session._norm_seed_memo = None
    from flowmap_server.core.overview import OverviewCache
    session._overview_cache = OverviewCache()
    session._last_col_seq = columns[-1].col_seq if columns else None
    session._last_partial_depth = session._last_partial_bar = None
    session._tape.clear()
    session._markers.clear()
    first = columns[0].t0_ns if columns else None
    session._markers.extend(m for m in gap_markers if first is not None and m.ts_ns >= first)
    session._bbo = session._instant_book = None
    frames = session._snapshot_frames()
    for client in session._clients:
        client.replace_snapshot(frames)
    session._publish_status()
