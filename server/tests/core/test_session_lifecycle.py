"""Session lifecycle regressions: bounded shutdown, boot failure,
concurrent creation, recorder fault tolerance, and disk history across epochs.

Each test pins one reliability finding:

- a wedged Parquet write must not hang flush_all, and cancellation
  must propagate instead of being absorbed by the drain loop.
- a disk page that straddles a re-anchor with a different p0 is served.
- a failed boot must not leave a zombie session holding a slot.
- concurrent subscribes for one key share one session.
- recorder and bookkeeping edge cases.
- the attach snapshot is served from the encode cache.
"""

from __future__ import annotations

import asyncio
import threading
import time

import numpy as np
import pytest

import flowmap_server.core.session as session_mod
import flowmap_server.core.session_boot as boot_mod
import flowmap_server.core.session_recording as rec_mod
from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.record import Recorder, SessionRecorder
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.feeds.base import BookState
from flowmap_server.proto import events, wire

DT = 250_000_000
START = 1_000_000_000_000
MARKET, SYMBOL = "sim", "LIFECYCLE"


# ---------------------------------------------------------------------------
# helpers


def _cfg(ring_columns: int = 1024) -> GridCfg:
    return GridCfg(
        tick=0.5, tick_multiple=1, dt_ns=DT, p0=84.0, rows=64,
        ring_columns=ring_columns, mode=events.MODE_L2,
    )


def _book(mid: float, sz: float = 5.0):
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return (px, np.full(3, sz), px + 0.5, np.full(3, sz))


class _FakeHandle:
    def __init__(self, delay_s, cb):
        self.delay_s, self.cb, self.cancelled = delay_s, cb, False

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.cb()


class FakeTimer:
    def __init__(self):
        self.entries: list[_FakeHandle] = []

    def __call__(self, delay_s, cb):
        handle = _FakeHandle(delay_s, cb)
        self.entries.append(handle)
        return handle


class DrivenFeed:
    """Feed driven by the test: push events, push None to end normally."""

    market = MARKET
    symbol = SYMBOL
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev


class IdleFeed:
    market = MARKET
    symbol = SYMBOL
    capability = {"depth": "L2"}


def _drive(grid: Grid, n: int, start: int = START):
    grid.on_book(start, np.array([99.5, 100.0]), np.full(2, 3.0),
                 np.array([100.5, 101.0]), np.full(2, 3.0))
    cols = []
    for i in range(1, n + 1):
        size = float(i % 7 + 1)
        cols.extend(grid.on_book(start + i * DT, np.array([99.5, 100.0]), np.full(2, size),
                                 np.array([100.5, 101.0]), np.full(2, size)))
    return cols


def _record(root: Recorder, grid: Grid, cols):
    rec = root.open_session(MARKET, SYMBOL)
    for epoch in sorted({c.epoch for c in cols}):
        rec.record_epoch(grid.epoch_params_for(epoch))
    for col in cols:
        rec.record_column(col)
    rec.flush()
    return rec


def _messages(frame: bytes) -> list:
    offset, out = 0, []
    while offset < len(frame):
        message, offset = wire.decode(frame, offset)
        out.append(message)
    return out


def _response(frame: bytes) -> events.HistoryResponse:
    messages = _messages(frame)
    assert isinstance(messages[-1], events.HistoryResponse)
    return messages[-1]


# ---------------------------------------------------------------------------
# Bounded drain and honest cancellation


async def test_wedged_recording_write_is_bounded_and_cancellation_propagates(tmp_path, monkeypatch):
    monkeypatch.setattr(rec_mod, "_REC_DRAIN_TIMEOUT_S", 0.2)
    root = Recorder(tmp_path / "wedge", 20.0)
    session = Session("wedge", feed=DrivenFeed(), grid=Grid(_cfg()), recorder=root,
                      timer=FakeTimer())
    await session._boot()
    entered, release = threading.Event(), threading.Event()
    real_flush = SessionRecorder.flush_buffers

    def stuck(self, buffers):
        entered.set()
        assert release.wait(5), "test watchdog: write was never released"
        return real_flush(self, buffers)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", stuck)
    try:
        session._on_book(BookState(0, *_book(100.0)))
        session._on_book(BookState(DT, *_book(100.0)))
        session._flush_recording()
        assert await asyncio.to_thread(entered.wait, 2)

        before = time.monotonic()
        await asyncio.wait_for(session.flush_recording_now(), 3)
        assert time.monotonic() - before < 2, "shutdown flush must not wait on a wedged write"
        # The wedged write still owns the in-flight gate.
        assert session._flush_task is not None and not session._flush_task.done()

        task = asyncio.create_task(session.flush_recording_now())
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
    finally:
        release.set()
        if session._flush_task is not None:
            await asyncio.wait_for(session._flush_task, 3)


async def test_flush_all_returns_within_bound_despite_a_wedged_write(tmp_path, monkeypatch):
    monkeypatch.setattr(rec_mod, "_REC_DRAIN_TIMEOUT_S", 0.2)
    root = Recorder(tmp_path / "shutdown", 20.0)
    timer = FakeTimer()
    manager = SessionManager(Config(max_rows=256, ring_columns=1024), recorder=root,
                             feed_factory=lambda sub: DrivenFeed(), timer=timer)
    from flowmap_server.proto.events import Subscribe

    session = await manager.subscribe(Subscribe(market=MARKET, symbol=SYMBOL, mode="live"), ClientTx())
    entered, release = threading.Event(), threading.Event()
    real_flush = SessionRecorder.flush_buffers

    def stuck(self, buffers):
        entered.set()
        assert release.wait(5), "test watchdog: write was never released"
        return real_flush(self, buffers)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", stuck)
    try:
        session._on_book(BookState(0, *_book(100.0)))
        session._on_book(BookState(DT, *_book(100.0)))
        session._flush_recording()
        assert await asyncio.to_thread(entered.wait, 2)
        before = time.monotonic()
        await asyncio.wait_for(manager.flush_all(), 3)
        assert time.monotonic() - before < 2
    finally:
        release.set()
        if session._flush_task is not None:
            await asyncio.wait_for(session._flush_task, 3)


# ---------------------------------------------------------------------------
# Disk pages across a re-anchor


async def test_disk_page_straddling_a_reanchor_with_different_p0_is_served(tmp_path):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg(ring_columns=4))
    old_cols = _drive(grid, n=8)
    assert grid.maybe_reanchor(160.0) is not None
    new_cols = _drive(grid, n=8, start=START + 40 * DT)
    epochs = {c.epoch for c in old_cols + new_cols}
    assert len(epochs) == 2
    assert grid.epoch_params_for(0).p0 != grid.current_epoch_params().p0

    sess = Session("straddle", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, old_cols + new_cols)
    # The RAM ring keeps the newest four columns, so this request is answered
    # from disk: epoch-1 columns the ring has already dropped plus all of epoch 0.
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=21, before_t=new_cols[-4].t0_ns, n_cols=24)
    ))
    served = {d.epoch for d in resp.depth_cols}
    # Before the fix the epoch-0 rows failed the comparison with the current
    # epoch's params and the whole disk page (both epochs) was discarded.
    assert served == epochs
    assert len(resp.depth_cols) >= len(old_cols) + 4


# ---------------------------------------------------------------------------
# Subscribe lifecycle


async def test_failed_boot_does_not_leave_a_zombie_session(monkeypatch):
    manager = SessionManager(Config(max_rows=256, ring_columns=1024, max_sessions=1),
                             feed_factory=lambda sub: DrivenFeed(), timer=FakeTimer())
    from flowmap_server.proto.events import Subscribe

    async def boom(self):
        raise RuntimeError("boot exploded")

    real_boot = Session._boot
    monkeypatch.setattr(Session, "_boot", boom)
    sub = Subscribe(market=MARKET, symbol="ZOMBIE", mode="live")
    # max_sessions is 1: a leaked session would make the second attempt a
    # SessionLimitError instead of the boot error.
    for _ in range(2):
        with pytest.raises(RuntimeError, match="boot exploded"):
            await manager.subscribe(sub, ClientTx())
    assert manager._sessions == {}
    assert manager.stats.snapshot()["sessions"]["active"] == 0

    monkeypatch.setattr(Session, "_boot", real_boot)
    session = await manager.subscribe(sub, ClientTx())
    assert manager._sessions and session.client_count == 1


async def test_cancelled_creator_frees_its_slot_but_a_cancelled_waiter_does_not(monkeypatch):
    from flowmap_server.proto.events import Subscribe

    boot_started = asyncio.Event()

    async def slow_boot(self):
        boot_started.set()
        await asyncio.sleep(30)

    monkeypatch.setattr(Session, "_boot", slow_boot)
    manager = SessionManager(Config(max_rows=256, ring_columns=1024, max_sessions=1),
                             feed_factory=lambda sub: DrivenFeed(), timer=FakeTimer())
    sub = Subscribe(market=MARKET, symbol=SYMBOL, mode="live")
    creator = asyncio.create_task(manager.subscribe(sub, ClientTx()))
    await asyncio.wait_for(boot_started.wait(), 2)
    waiter = asyncio.create_task(manager.subscribe(sub, ClientTx()))
    await asyncio.sleep(0.01)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    # The waiter never owned the session: the creator's boot is untouched.
    assert len(manager._sessions) == 1 and not creator.done()

    creator.cancel()
    with pytest.raises(asyncio.CancelledError):
        await creator
    assert manager._sessions == {}, "a cancelled creator must not keep its slot"


async def test_failed_closed_market_warmup_degrades_to_cold_start(monkeypatch):
    class ClosedKeylessFeed:
        market = "equity"
        symbol = "FAIL"
        tier = "keyless"
        capability = {"depth": "SYNTH"}

        def is_closed_now(self):
            return True

        def closed_history_events(self):
            raise RuntimeError("provider down")

    monkeypatch.setattr(boot_mod, "EquityFeed", ClosedKeylessFeed)
    session = Session("closed-fail", feed=ClosedKeylessFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    await session._prepare_closed_history()  # must not raise
    assert session._closed_history_prepared is False
    assert session._preparing_closed_history is False


async def test_concurrent_subscribes_for_one_key_share_one_session():
    from flowmap_server.proto.events import Subscribe

    created: list[Subscribe] = []

    class SlowPrepareFeed(DrivenFeed):
        async def prepare(self):
            await asyncio.sleep(0.05)

    def factory(sub):
        created.append(sub)
        return SlowPrepareFeed()

    manager = SessionManager(Config(max_rows=256, ring_columns=1024),
                             feed_factory=factory, timer=FakeTimer())
    sub = Subscribe(market=MARKET, symbol=SYMBOL, mode="live")
    first, second = await asyncio.gather(
        manager.subscribe(sub, ClientTx()), manager.subscribe(sub, ClientTx())
    )
    assert first is second
    assert len(created) == 1, "the second subscriber must not build a duplicate feed"
    assert len(manager._sessions) == 1
    assert first.client_count == 2
    assert manager._creating == {}


async def test_band_eviction_forgets_the_variant_in_stats():
    from flowmap_server.proto.events import Subscribe

    manager = SessionManager(Config(max_rows=256, ring_columns=1024),
                             feed_factory=lambda sub: DrivenFeed(), timer=FakeTimer())
    client = ClientTx()
    old = await manager.subscribe(Subscribe(market=MARKET, symbol=SYMBOL, mode="live", band="wide"), client)
    manager.stats.note_live_sample(old.session_id)
    # The variant is left idle, with no clients, as a band switch leaves it.
    await manager.unsubscribe(old, client)
    await manager.subscribe(Subscribe(market=MARKET, symbol=SYMBOL, mode="live", band="full"), ClientTx())
    snap = manager.stats.snapshot()
    assert old.session_id not in snap["staleness_ms"]


# ---------------------------------------------------------------------------
# recorder fault tolerance and teardown during boot


async def test_single_append_failure_drops_one_row_not_the_recording(tmp_path):
    root = Recorder(tmp_path / "append", 20.0)
    session = Session("append", feed=DrivenFeed(), grid=Grid(_cfg()), recorder=root,
                      timer=FakeTimer())
    await session._boot()
    assert session._rec is not None
    calls = {"n": 0}

    def flaky(rec):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("bad row")

    session._record(flaky)
    assert session._rec is not None
    session._record(flaky)
    assert session._rec is not None and session._rec_append_failures == 0

    def always(rec):
        raise ValueError("bad row")

    for _ in range(session_mod._REC_APPEND_FAIL_LIMIT):
        session._record(always)
    assert session._rec is None


async def test_teardown_during_boot_closes_the_recorder_it_opened(tmp_path, monkeypatch):
    root = Recorder(tmp_path / "boot-teardown", 20.0)
    session = Session("boot-teardown", feed=DrivenFeed(), grid=Grid(_cfg()), recorder=root,
                      timer=FakeTimer())
    entered, release = threading.Event(), threading.Event()
    opened, closed = [], []

    def blocking():
        rec = root.open_session(MARKET, SYMBOL)
        opened.append(rec)
        entered.set()
        assert release.wait(3)
        return rec, None

    real_close = SessionRecorder.close

    def close(self):
        closed.append(self.recording_id)
        return real_close(self)

    monkeypatch.setattr(SessionRecorder, "close", close)
    session._boot_blocking = blocking
    boot = asyncio.create_task(session._boot())
    assert await asyncio.to_thread(entered.wait, 2)
    session.teardown_now()
    release.set()
    await asyncio.wait_for(boot, 3)
    assert session._rec is None
    assert closed == [opened[0].recording_id]


async def test_recording_identity_survives_recorder_disable():
    session = Session("identity", feed=IdleFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    session._known_recording_id = "rec-abc"
    assert session._recording_identity == "rec-abc"


# ---------------------------------------------------------------------------
# overview serialization and the attach snapshot


async def test_overview_steps_never_overlap_after_a_cancelled_request():
    session = Session("overview", feed=DrivenFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    release = threading.Event()
    order: list[str] = []

    def slow():
        order.append("slow-start")
        assert release.wait(5)
        order.append("slow-end")

    def fast():
        order.append("fast")

    first = asyncio.create_task(session._overview_call(slow))
    await asyncio.sleep(0.05)
    first.cancel()
    second = asyncio.create_task(session._overview_call(fast))
    await asyncio.sleep(0.1)
    # The orphaned worker keeps running; the successor must wait for it.
    assert order == ["slow-start"]
    release.set()
    await asyncio.wait_for(second, 3)
    assert order == ["slow-start", "slow-end", "fast"]


async def test_attach_snapshot_is_byte_identical_and_skips_column_copies():
    grid = Grid(_cfg(ring_columns=1024))
    _drive(grid, n=600)
    session = Session("snapshot", feed=IdleFeed(), grid=grid, timer=FakeTimer())
    cold = session._snapshot_frames()  # first attach fills the encode cache

    calls = {"n": 0}
    real_column = grid._column_from_ring

    def counting(i):
        calls["n"] += 1
        return real_column(i)

    grid._column_from_ring = counting
    warm = session._snapshot_frames()
    grid._column_from_ring = real_column
    assert warm == cold
    # Only the scalar-free norm-seed window (64 columns) is materialized now,
    # not the 512-column snapshot window.
    assert calls["n"] <= 64


async def test_retention_walk_is_bounded_on_the_shutdown_path(monkeypatch):
    # The retention walk runs inside the shutdown flush and teardown. A stuck
    # disk walk must be bounded like a stuck Parquet write.
    monkeypatch.setattr(rec_mod, "_REC_DRAIN_TIMEOUT_S", 0.2)
    release = threading.Event()

    class StuckRoot:
        def enforce_retention(self):
            assert release.wait(5), "test watchdog: retention was never released"

    session = Session("retention", feed=IdleFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    session._recorder_root = StuckRoot()
    try:
        before = time.monotonic()
        await asyncio.wait_for(session._enforce_retention_async(), 3)
        assert time.monotonic() - before < 2
    finally:
        release.set()
