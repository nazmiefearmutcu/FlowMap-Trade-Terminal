"""Coarse-range footprints merge once per batch, with the same result.

The merge is a pointwise max over every range, so folding a batch in one call
must equal folding it column by column. Doing it per column re-sorted the whole
accumulated list for every source column of a coarse-scaled recording.
"""

from types import SimpleNamespace

import numpy as np
import pytest

from flowmap_server.core import overview
from flowmap_server.core.overview import OverviewBuilder, OverviewCache
from flowmap_server.proto.events import EpochParams

TARGET = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=10**9, p0=90.0, rows=64)
# Coarser source rows than the target: every source row is a coarse range.
SOURCE = EpochParams(epoch=1, tick=2.0, tick_multiple=1, dt_ns=10**9, p0=90.0, rows=64)
STRIDE = 1000


def _column(seq: int) -> SimpleNamespace:
    bid = np.zeros(SOURCE.rows)
    ask = np.zeros(SOURCE.rows)
    bid[: 4 + seq % 5] = 1.0 + seq  # a different active footprint per column
    ask[2:6] = 0.5
    bar = SimpleNamespace(col_seq=seq, h=2.0, l=1.0, vol_buy=1.0, vol_sell=0.0)
    return SimpleNamespace(
        col_seq=seq, t0_ns=seq, epoch=SOURCE.epoch, bid=bid, ask=ask, bar=bar
    )


def _builder() -> OverviewBuilder:
    return OverviewBuilder(TARGET, 0, 10**6, STRIDE, 10**6, 10**6, OverviewCache())


def _count_merges(monkeypatch) -> list[int]:
    calls = [0]
    original = overview._bounded_coarse_ranges

    def counting(ranges):
        calls[0] += 1
        return original(ranges)

    monkeypatch.setattr(overview, "_bounded_coarse_ranges", counting)
    return calls


def test_one_batch_merges_coarse_ranges_once_per_group(monkeypatch):
    columns = [_column(seq) for seq in range(10)]
    calls = _count_merges(monkeypatch)
    batched = _builder()
    batched.add(columns, {SOURCE.epoch: SOURCE})
    assert calls[0] == 1

    per_column = _builder()
    calls[0] = 0
    for col in columns:
        per_column.add([col], {SOURCE.epoch: SOURCE})
    assert calls[0] == 10

    assert batched.bins[0].coarse_ranges
    assert batched.bins[0].coarse_ranges == per_column.bins[0].coarse_ranges


def test_a_batch_that_raises_keeps_the_coarse_ranges_it_folded():
    good = [_column(seq) for seq in range(3)]
    bad = _column(3)
    bad.bar = None  # raises after this column's footprint was folded
    builder = _builder()
    with pytest.raises(AttributeError):
        builder.add([*good, bad], {SOURCE.epoch: SOURCE})
    expected = _builder()
    expected.add([*good, _column(3)], {SOURCE.epoch: SOURCE})
    assert builder.bins[0].coarse_ranges
    assert builder.bins[0].coarse_ranges == expected.bins[0].coarse_ranges
