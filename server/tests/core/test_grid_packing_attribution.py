"""Grid fixes: small-peak packing, trade attribution, ring metadata, epochs.

A column whose peak is tiny must keep its relative precision, not
fall into the float16 subnormal range. A print stamped outside the
current interval is counted, and still folded so bar volume matches session
CVD. The
epoch table can drop entries that neither the live epoch nor a resident column
uses. snapshot_meta replaces the session's private ring-field reads.
"""

import msgspec
import numpy as np

from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.proto.events import SIDE_BUY

CFG = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
              ring_columns=128, mode=0)


def book(mid, sz):
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return (px - 0.0, np.full(3, sz), px + 0.5, np.full(3, sz))


def _roundtrip(density):
    packed, scale = Grid._pack_density(density)
    return Grid._unpack_density(packed, scale)


def test_small_peak_keeps_relative_precision():
    # Without up-scaling, values around 1e-7 sit in float16's subnormal range
    # (absolute step ~6e-8) and quantize to a handful of levels or to zero.
    density = np.array([[1.0e-7, 3.3e-7, 0.0], [2.5e-7, 9.0e-8, 4.0e-7]])
    back = _roundtrip(density)
    nonzero = density > 0
    np.testing.assert_allclose(back[nonzero], density[nonzero], rtol=2e-3)
    assert back[0, 2] == 0.0


def test_large_peak_still_fits_float16_range():
    density = np.array([[1.0e6, 3.0e5], [2.0, 7.5e5]])
    packed, scale = Grid._pack_density(density)
    assert float(np.max(packed)) <= 60000.0
    np.testing.assert_allclose(_roundtrip(density), density, rtol=2e-3)


def test_ordinary_peak_is_unscaled():
    _packed, scale = Grid._pack_density(np.array([[3.0, 12.0]]))
    assert scale == 1.0


def test_print_stamped_past_the_interval_is_counted_and_still_folded():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))  # current interval is idx 0 ([0, 1s))
    g.on_trade(500_000_000, 100.0, 3.0, SIDE_BUY)  # in-interval
    g.on_trade(1_500_000_000, 101.0, 2.0, SIDE_BUY)  # stamped past the interval end
    bar = g.bar_partial()
    # Folded as before, so the bar volume and the session CVD agree.
    assert bar.vol_buy == 5.0
    assert bar.cvd_cum == 5.0
    assert g.out_of_interval_trades == 1


def test_in_interval_prints_are_not_counted_as_out_of_interval():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_trade(100_000_000, 100.0, 1.0, SIDE_BUY)
    g.on_trade(999_000_000, 100.5, 1.0, SIDE_BUY)
    assert g.out_of_interval_trades == 0


def test_snapshot_meta_reports_newest_retained_columns_oldest_first():
    g = Grid(CFG)
    assert g.snapshot_meta(3) == []
    for i in range(4):
        g.on_book(i * 1_000_000_000, *book(100.0, 5.0))
    meta = g.snapshot_meta(2)
    assert [m[1] for m in meta] == [1, 2]  # col_seq
    assert [m[2] for m in meta] == [1_000_000_000, 2_000_000_000]  # t0_ns
    assert all(m[3] == 0 for m in meta)  # epoch
    assert g.snapshot_meta(0) == []


def test_prune_epoch_params_keeps_live_and_resident_epochs_only():
    g = Grid(CFG)
    base = g._epoch_params[0]
    g._epoch_params[5] = msgspec.structs.replace(base, epoch=5)
    g._epoch_params[7] = msgspec.structs.replace(base, epoch=7)
    for i in range(4):
        g.on_book(i * 1_000_000_000, *book(100.0, 5.0))
    g._ring_epoch[2] = 7  # the column at seq 2 still lives in epoch 7
    removed = g.prune_epoch_params()
    assert removed == 1
    assert set(g._epoch_params) == {0, 7}
    assert g.epoch_params_for(7).epoch == 7


def test_prune_with_empty_ring_keeps_only_the_live_epoch():
    g = Grid(CFG)
    base = g._epoch_params[0]
    g._epoch_params[3] = msgspec.structs.replace(base, epoch=3)
    assert g.prune_epoch_params() == 1
    assert set(g._epoch_params) == {0}
