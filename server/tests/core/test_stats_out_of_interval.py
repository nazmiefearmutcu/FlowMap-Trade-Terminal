"""Out-of-interval trade totals reach the health snapshot.

The grid folds a print stamped outside its interval into the bar and counts it
in ``out_of_interval_trades``. Before this, that count never left the grid, so
an operator could not see venue clock or ordering trouble on /api/health.
"""

from __future__ import annotations

import numpy as np

from flowmap_server.core.stats import SessionStats


def test_out_of_interval_total_is_summed_across_sessions_in_the_snapshot():
    s = SessionStats()
    s.note_out_of_interval("a", 3)
    s.note_out_of_interval("b", 4)
    assert s.snapshot()["trades"] == {"out_of_interval": 7}


def test_latest_total_replaces_the_previous_one_and_negatives_are_clamped():
    s = SessionStats()
    s.note_out_of_interval("a", 2)
    s.note_out_of_interval("a", 5)  # running total: latest wins, never double counted
    s.note_out_of_interval("a", -9)
    assert s.snapshot()["trades"]["out_of_interval"] == 0


def test_forgotten_session_stops_contributing():
    s = SessionStats()
    s.note_out_of_interval("a", 3)
    s.note_out_of_interval("b", 4)
    s.forget_session("b")
    assert s.snapshot()["trades"]["out_of_interval"] == 3


def test_grid_counter_feeds_the_stats_total_from_a_real_grid():
    from flowmap_server.core.grid import Grid, GridCfg
    from flowmap_server.proto.events import SIDE_BUY

    cfg = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
                  ring_columns=128, mode=0)
    g = Grid(cfg)
    mid, sz = 100.0, 5.0
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    g.on_book(0, px, np.full(3, sz), px + 0.5, np.full(3, sz))
    g.on_trade(500_000_000, 100.0, 3.0, SIDE_BUY)
    g.on_trade(1_500_000_000, 101.0, 2.0, SIDE_BUY)  # stamped past the interval end

    s = SessionStats()
    s.note_out_of_interval("live", g.out_of_interval_trades)
    assert s.snapshot()["trades"]["out_of_interval"] == 1
