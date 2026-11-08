"""The Hello norm_seed is memoised on the retained window and the live epoch.

Every attach used to re-read the last 64 columns and take their percentile.
An attach to an unchanged window must reuse it, and any change to the window
must recompute it.
"""

from __future__ import annotations

import numpy as np

from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import Session
from flowmap_server.proto.events import MODE_L2

DT = 250_000_000
_BOOK = (np.array([100.0]), np.array([2.0]), np.array([100.5]), np.array([3.0]))


class _IdleFeed:
    market = "sim"
    symbol = "MEMO"
    capability: dict[str, object] = {"depth": "L2"}


def _grid() -> Grid:
    return Grid(GridCfg(tick=0.5, tick_multiple=1, dt_ns=DT, p0=75.0, rows=64,
                        ring_columns=128, mode=MODE_L2))


def _advance(grid: Grid, cols: int, start: int = 0) -> None:
    for i in range(start, start + cols + 1):
        grid.on_book(i * DT, *_BOOK)


def test_unchanged_window_reuses_the_percentile(monkeypatch) -> None:
    grid = _grid()
    _advance(grid, 4)
    sess = Session("memo", feed=_IdleFeed(), grid=grid)
    reads: list[int] = []
    real_history = grid.history

    def counting_history(before_t_ns: int, n: int):
        reads.append(n)
        return real_history(before_t_ns, n)

    monkeypatch.setattr(grid, "history", counting_history)
    first = sess._norm_seed()
    second = sess._norm_seed()
    assert first == second
    assert len(reads) == 1, "an attach to an unchanged window re-read the columns"


def test_a_new_column_recomputes_the_percentile(monkeypatch) -> None:
    grid = _grid()
    _advance(grid, 4)
    sess = Session("memo-new", feed=_IdleFeed(), grid=grid)
    sess._norm_seed()
    reads: list[int] = []
    real_history = grid.history

    def counting_history(before_t_ns: int, n: int):
        reads.append(n)
        return real_history(before_t_ns, n)

    monkeypatch.setattr(grid, "history", counting_history)
    _advance(grid, 2, start=5)
    sess._norm_seed()
    assert reads, "the window changed but the memoised percentile was served"


def test_a_memo_from_another_epoch_is_never_served() -> None:
    grid = _grid()
    _advance(grid, 4)
    sess = Session("memo-epoch", feed=_IdleFeed(), grid=grid)
    fresh = sess._norm_seed()
    other_epoch = grid.current_epoch_params().epoch + 1
    sess._norm_seed_memo = ((grid.retained_sequence_range(), other_epoch), 42.0)
    assert sess._norm_seed() == fresh
