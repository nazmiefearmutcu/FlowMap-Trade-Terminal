"""First-launch price history tests — canned candles, NO network.

Covers the two layers:

1. ``columns_from_candles`` — the pure candle -> FinalizedColumn conversion:
   one column per candle, contiguity/monotonicity that ``Grid.preload``
   requires, an epoch frame centered on the last close, zero depth on every
   column, bars carrying OHLC, the taker split as CVD, and a real
   ``Grid.preload`` round-trip. On a banded grid the history leaves the band
   frame to the first live mid, and live books continue after it.
2. ``Session`` wiring — a cold subscribe seeds the ring through the injectable
   ``backfill_fn`` seam, the first snapshot carries a gap marker, and the
   capability carries no history badge; a missing seam or a failing fetch
   degrades cleanly to a cold start; a keyless equity feed never fetches.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.backfill import Candle, columns_from_candles
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.core.session_manager import BANDS
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.proto import wire
from flowmap_server.proto.events import (
    MODE_L2,
    DepthColumn,
    Hello,
    Marker,
    Subscribe,
)

DT = 250_000_000  # 250 ms
_MINUTE = 60 * 10**9
BANDED = ("wide", "full", "deep")


def _cfg(rows: int = 256, ring_columns: int = 1024) -> GridCfg:
    return GridCfg(
        tick=0.5,
        tick_multiple=1,
        dt_ns=DT,
        p0=100.0 - rows * 0.5 / 2.0,
        rows=rows,
        ring_columns=ring_columns,
        mode=MODE_L2,
    )


def _banded_cfg(band: str, ring_columns: int = 1024) -> GridCfg:
    """A grid built the way the session manager builds a price-band grid."""
    spec = BANDS[band]
    assert spec is not None
    rows = spec.rows or 2048
    tick = 0.05
    return GridCfg(
        tick=tick,
        tick_multiple=1,
        dt_ns=DT,
        p0=100.0 - rows * tick / 2.0,
        rows=rows,
        ring_columns=ring_columns,
        mode=MODE_L2,
        band_up=spec.up,
        band_down=spec.down,
        band_hybrid=spec.hybrid,
        core_rows=spec.core_rows,
    )


def _candles(n: int, *, base_price: float = 100.0, with_split: bool = True) -> list[Candle]:
    base_ts = 1_700_000_000 * 10**9  # some real-ish wall ns, minute-aligned enough
    out: list[Candle] = []
    for i in range(n):
        c = base_price + (i % 5) * 0.5  # walk within the grid span
        lo, hi = c - 1.0, c + 1.0
        out.append(
            Candle(
                t0_ns=base_ts + i * _MINUTE,
                o=c,
                h=hi,
                l=lo,
                c=c,
                volume=100.0 + i,
                buy_volume=(60.0 if with_split else None),
                sell_volume=(40.0 if with_split else None),
            )
        )
    return out


def _book(mid: float, step: float, n: int = 5):
    """A book with ``n`` levels per side, ``step`` apart, around ``mid``."""
    offsets = step * np.arange(1, n + 1)
    sz = np.full(n, 100.0)
    return mid - offsets, sz, mid + offsets, sz


# --- 1. columns_from_candles ---------------------------------------------------


def test_columns_contiguous_and_monotonic():
    cfg = _cfg()
    result = columns_from_candles(_candles(8), cfg)
    assert result is not None
    cols, epoch = result
    assert len(cols) == 8
    # col_seq strictly contiguous from 0 (Grid.preload requires it).
    assert [c.col_seq for c in cols] == list(range(8))
    # t0 strictly increasing and dt-aligned.
    for a, b in zip(cols, cols[1:]):
        assert b.t0_ns > a.t0_ns
    assert all(c.t0_ns % DT == 0 for c in cols)
    # rows match cfg; density is float16 and finite.
    f16_max = float(np.finfo(np.float16).max)
    for c in cols:
        assert len(c.bid) == cfg.rows and len(c.ask) == cfg.rows
        assert c.bid.dtype == np.float16 and c.ask.dtype == np.float16
        assert np.isfinite(c.bid.astype(np.float64)).all()
        assert float(c.bid.astype(np.float64).max()) <= f16_max
    # epoch frame: linear params match cfg, p0 centered on the last close.
    assert (epoch.tick, epoch.tick_multiple, epoch.dt_ns, epoch.rows) == (
        cfg.tick,
        cfg.tick_multiple,
        cfg.dt_ns,
        cfg.rows,
    )
    ref = cols[-1].bar.c
    assert abs(epoch.p0 - (ref - cfg.rows * cfg.tick / 2.0)) <= cfg.tick


def test_one_column_per_candle():
    cfg = _cfg()
    for n in (1, 5, 40):
        cols, _ = columns_from_candles(_candles(n), cfg)
        assert len(cols) == n
        assert [c.col_seq for c in cols] == list(range(n))
        assert [c.bar.col_seq for c in cols] == list(range(n))


def test_every_column_has_zero_depth_even_for_large_volume():
    cfg = _cfg()
    candles = [
        Candle(t0_ns=i * _MINUTE, o=100.0, h=101.0, l=99.0, c=100.0, volume=1e9)
        for i in range(6)
    ]
    cols, _ = columns_from_candles(candles, cfg)
    assert len(cols) == 6
    for c in cols:
        assert len(c.bid) == cfg.rows and len(c.ask) == cfg.rows
        assert not c.bid.any()
        assert not c.ask.any()


def test_absurd_volume_candle_has_no_density_and_no_overflow():
    cfg = _cfg()
    # h == l == c with an absurd volume: a price-only column carries no size,
    # so nothing can overflow the float16 ring.
    candles = [Candle(t0_ns=0, o=100.0, h=100.0, l=100.0, c=100.0, volume=1e9)]
    cols, _ = columns_from_candles(candles, cfg)
    assert len(cols) == 1
    assert not cols[0].bid.any() and not cols[0].ask.any()
    assert cols[0].bar.c == 100.0


@pytest.mark.parametrize("band", BANDED)
def test_banded_grid_now_gets_price_history(band):
    cfg = _banded_cfg(band)
    candles = _candles(4)
    result = columns_from_candles(candles, cfg)
    assert result is not None
    cols, epoch = result
    assert len(cols) == 4
    assert [c.col_seq for c in cols] == list(range(4))
    assert all(not c.bid.any() and not c.ask.any() for c in cols)
    assert epoch.rows == cfg.rows and epoch.dt_ns == cfg.dt_ns


def test_bars_carry_ohlc_and_taker_split_as_cvd():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4, with_split=True), cfg)
    # buy 60 / sell 40 per candle -> cvd rises by 20 each column.
    assert [round(c.bar.cvd_cum, 6) for c in cols] == [20.0, 40.0, 60.0, 80.0]
    assert all(c.bar.vol_buy == 60.0 and c.bar.vol_sell == 40.0 for c in cols)
    candles = _candles(4, with_split=True)
    assert [c.bar.o for c in cols] == [cd.o for cd in candles]
    assert [c.bar.h for c in cols] == [cd.h for cd in candles]
    assert [c.bar.l for c in cols] == [cd.l for cd in candles]
    assert [c.bar.c for c in cols] == [cd.c for cd in candles]


def test_equity_no_split_leaves_cvd_flat():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4, with_split=False), cfg)
    assert all(c.bar.cvd_cum == 0.0 for c in cols)
    assert all(c.bar.vol_buy == 0.0 and c.bar.vol_sell == 0.0 for c in cols)
    # vwap sums still accumulate from candle typical price (both markets).
    assert cols[-1].bar.vwap_den_cum > 0.0


def test_preload_roundtrip_accepts_backfill_columns():
    cfg = _cfg()
    cols, epoch = columns_from_candles(_candles(10), cfg)
    grid = Grid(cfg)
    grid.preload(cols, [epoch])  # must not raise: contiguity contract honored
    served = grid.history(2**62, 100)
    assert len(served) == 10
    assert [c.col_seq for c in served] == list(range(10))
    # live continues in the SAME epoch (mid in range -> no immediate re-anchor).
    ref = cols[-1].bar.c
    params = grid.maybe_reanchor(ref)
    assert params is None
    assert grid.current_epoch_params().epoch == 0


@pytest.mark.parametrize("band", BANDED)
def test_banded_history_leaves_the_band_frame_to_the_first_live_mid(band):
    cfg = _banded_cfg(band)
    candles = _candles(6)
    cols, epoch = columns_from_candles(candles, cfg)
    mid = 101.0

    seeded = Grid(cfg)
    seeded.preload(cols, [epoch], band_frame_final=False)
    fresh = Grid(cfg)

    got = seeded.maybe_reanchor(mid)
    want = fresh.maybe_reanchor(mid)
    assert got is not None and want is not None
    assert (got.tick, got.tick_multiple, got.p0, got.scale_kind) == (
        want.tick,
        want.tick_multiple,
        want.p0,
        want.scale_kind,
    )


def test_linear_banded_history_with_default_frame_does_not_reanchor():
    cfg = _banded_cfg("wide")
    candles = _candles(6)
    cols, epoch = columns_from_candles(candles, cfg)
    grid = Grid(cfg)
    grid.preload(cols, [epoch])  # band_frame_final=True: a rehydrated recording
    assert grid.maybe_reanchor(candles[-1].c) is None


@pytest.mark.parametrize("band", BANDED)
def test_live_books_after_banded_history_continue_seq_with_depth(band):
    cfg = _banded_cfg(band)
    candles = _candles(6)
    cols, epoch = columns_from_candles(candles, cfg)
    grid = Grid(cfg)
    grid.preload(cols, [epoch], band_frame_final=False)
    mid = candles[-1].c
    assert grid.maybe_reanchor(mid) is not None  # the first live mid builds the band

    bids, sz, asks, _ = _book(mid, cfg.tick)
    t_live = cols[-1].t0_ns + 4 * DT
    assert grid.on_book(t_live, bids, sz, asks, sz) == []
    live = grid.on_book(t_live + 2 * DT, bids, sz, asks, sz)
    assert live
    n = len(cols)
    assert [c.col_seq for c in live] == list(range(n, n + len(live)))
    assert any(
        float(c.bid.astype(np.float64).max()) > 0.0 or float(c.ask.astype(np.float64).max()) > 0.0
        for c in live
    )

    served = grid.history(2**62, 1000)
    history = served[:n]
    assert [c.col_seq for c in history] == list(range(n))
    assert [c.bar.c for c in history] == [cd.c for cd in candles]
    assert history[-1].bar.cvd_cum == pytest.approx(20.0 * n)


def test_same_slot_candles_both_kept_with_forced_t0():
    """Two candles snapping onto one dt slot are BOTH kept (one column per
    candle): the later candle is forced onto ``prev_t0 + dt`` so the col_seq/t0
    sequence stays strictly increasing for ``Grid.preload`` — nothing is
    silently dropped."""
    cs = [
        Candle(t0_ns=0, o=100.0, h=101.0, l=99.0, c=100.0, volume=10.0),
        Candle(t0_ns=DT // 2, o=100.0, h=101.0, l=99.0, c=100.5, volume=5.0),
    ]
    out = columns_from_candles(cs, _cfg())
    assert out is not None
    cols, _epoch = out
    assert [c.t0_ns for c in cols] == [0, DT]
    assert [c.col_seq for c in cols] == [0, 1]
    # The forced slot still carries the second candle's real data.
    assert cols[1].bar.c == 100.5
    assert cols[1].bar.vwap_den_cum == 15.0


def test_empty_and_nonfinite_candles_return_none():
    cfg = _cfg()
    assert columns_from_candles([], cfg) is None
    bad = [Candle(t0_ns=0, o=float("nan"), h=1.0, l=1.0, c=1.0, volume=1.0)]
    assert columns_from_candles(bad, cfg) is None


# --- 2. Session wiring ---------------------------------------------------------


class _IdleFeed:
    """Feed that never yields; a capability donor for backfill wiring tests."""

    def __init__(self, market: str, symbol: str, capability: dict[str, object]) -> None:
        self.market = market
        self.symbol = symbol
        self.capability = capability

    async def events(self):
        await asyncio.sleep(3600)
        if False:  # pragma: no cover
            yield None


class _SpyRecorder:
    """Records the name of every recorder call the session makes."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __getattr__(self, name: str):
        def spy(*args, **kwargs) -> None:
            self.calls.append(name)

        return spy


def _decode(buf: bytes) -> list:
    out, off = [], 0
    while off < len(buf):
        ev, off = wire.decode(buf, off)
        out.append(ev)
    return out


def _flatten(frames: list[bytes]) -> list:
    return [m for f in frames for m in _decode(f)]


def _drain(client: ClientTx) -> list[bytes]:
    out: list[bytes] = []
    while True:
        frames = client.drain(1 << 30)
        if not frames:
            return out
        out.extend(frames)


def _backfill_fn(candles):
    async def fn(market, symbol, *, max_cols, now_ns):
        assert max_cols > 0
        return list(candles)

    return fn


async def test_session_backfill_seeds_ring_and_marks_the_gap():
    grid = Grid(_cfg())
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2", "cvd": "exchange"})
    sess = Session(
        "bf", feed=feed, grid=grid,
        backfill_fn=_backfill_fn(_candles(12)), backfill_max_cols=12,
    )
    await sess.start()
    try:
        flat = _flatten(sess.attach(ClientTx()))
        hello = flat[0]
        assert isinstance(hello, Hello)
        # price history carries no depth, so the capability has no history badge.
        assert "history" not in hello.capability
        # the history columns are in the snapshot.
        assert sum(isinstance(m, DepthColumn) for m in flat) > 0
        # a gap marker separates the price history from live.
        gaps = [m for m in flat if isinstance(m, Marker) and m.kind == "gap"]
        assert gaps and gaps[0].text.startswith("backfill: price history ends")
        # the ring holds one column per candle.
        assert len(grid.history(2**62, 500)) == 12
    finally:
        sess.teardown_now()


@pytest.mark.parametrize("band", BANDED)
async def test_session_backfill_seeds_a_banded_grid(band):
    grid = Grid(_banded_cfg(band))
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2", "cvd": "exchange"})
    sess = Session(
        "bf-band", feed=feed, grid=grid,
        backfill_fn=_backfill_fn(_candles(12)), backfill_max_cols=12,
    )
    await sess.start()
    try:
        flat = _flatten(sess.attach(ClientTx()))
        assert "history" not in flat[0].capability
        assert any(isinstance(m, Marker) and m.kind == "gap" for m in flat)
        assert len(grid.history(2**62, 500)) == 12
    finally:
        sess.teardown_now()


async def test_seeded_history_is_not_recorded():
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2"})
    sess = Session(
        "bf-rec", feed=feed, grid=Grid(_cfg()),
        backfill_fn=_backfill_fn(_candles(5)), backfill_max_cols=5,
    )
    spy = _SpyRecorder()
    sess._rec = spy
    await sess._run_backfill()
    assert len(sess._grid.history(2**62, 100)) == 5
    # Only the gap marker reaches the recorder; the history columns do not.
    assert spy.calls == ["record_marker"]


async def test_keyless_equity_session_never_calls_backfill():
    calls: list[object] = []

    async def fetch(*args, **kwargs):
        calls.append(args)
        return _candles(5)

    async def no_bars() -> list:
        return []

    async def no_sleep(_s: float) -> None:
        return None

    feed = EquityFeed(
        "AAPL", Config(), now_ns_fn=lambda: 0, bars_fn=no_bars, sleep_fn=no_sleep
    )
    assert feed.tier == "keyless"
    sess = Session(
        "eq-no-bf", feed=feed, grid=Grid(_cfg()),
        backfill_fn=fetch, backfill_max_cols=512,
    )
    await sess._run_backfill()
    assert calls == []
    assert sess._grid.history(2**62, 100) == []


async def test_session_without_backfill_is_unchanged():
    grid = Grid(_cfg())
    feed = _IdleFeed("sim", "SIM-DEMO", {"depth": "L2"})
    sess = Session("nobf", feed=feed, grid=grid)  # no backfill_fn
    await sess.start()
    try:
        hello = _flatten(sess.attach(ClientTx()))[0]
        assert isinstance(hello, Hello)
        assert "history" not in hello.capability
        # replay:True is a SERVER-level badge merged into every Hello.
        assert hello.capability == {**feed.capability, "replay": True}
        assert grid.history(2**62, 100) == []
    finally:
        sess.teardown_now()


async def test_session_backfill_failure_degrades_to_cold_start():
    async def boom(market, symbol, *, max_cols, now_ns):
        raise RuntimeError("provider down")

    grid = Grid(_cfg())
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2"})
    sess = Session("bf-fail", feed=feed, grid=grid, backfill_fn=boom, backfill_max_cols=12)
    await sess.start()  # must not raise
    try:
        hello = _flatten(sess.attach(ClientTx()))[0]
        assert "history" not in hello.capability  # cold start, no false badge
        assert grid.history(2**62, 100) == []
    finally:
        sess.teardown_now()


async def test_manager_threads_backfill_for_live_only():
    cfg = Config()
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2", "cvd": "exchange"})
    mgr = SessionManager(
        cfg, feed_factory=lambda sub: feed, backfill_fn=_backfill_fn(_candles(9))
    )
    # The manager builds the crypto grid; backfill recenters its epoch p0 on the
    # candles' last close, so the ~100-priced canned candles land in-range.
    sub = Subscribe(market="binance-spot", symbol="BTCUSDT", mode="live")
    client = ClientTx()
    sess = await mgr.subscribe(sub, client)
    try:
        hello = _flatten(_drain(client))[0]
        assert isinstance(hello, Hello)
        assert "history" not in hello.capability
        assert len(sess._grid.history(2**62, 100)) == 9
    finally:
        sess.teardown_now()
