"""Session worker deadlines: a stuck boot or overview step cannot hold the session.

A worker thread cannot be interrupted, so the guarantees are these: the
awaiting request is released on time, the abandoned worker is counted in the
server statistics until it finishes, and a recorder it opens is closed once it
lands.
"""

from __future__ import annotations

import asyncio
import threading

import numpy as np
import pytest

import flowmap_server.core.session_history as history_mod
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import Session
from flowmap_server.core.session_common import OverviewUnavailableError
from flowmap_server.core.stats import SessionStats
from flowmap_server.proto import events

DT = 250_000_000
MARKET, SYMBOL = "sim", "DEADLINE"


def _cfg() -> GridCfg:
    return GridCfg(
        tick=0.5, tick_multiple=1, dt_ns=DT, p0=84.0, rows=64,
        ring_columns=256, mode=events.MODE_L2,
    )


class _Feed:
    market = MARKET
    symbol = SYMBOL
    capability = {"depth": "L2"}


class _FakeTimer:
    def __call__(self, delay_s, cb):
        return _Handle()


class _Handle:
    def cancel(self) -> None:
        pass


class _FakeRecorder:
    """Stands in for SessionRecorder: records that close ran."""

    recording_id = "orphan-recording"

    def __init__(self) -> None:
        self.closed = threading.Event()

    def close(self) -> None:
        self.closed.set()


def _session(stats: SessionStats | None = None) -> Session:
    return Session(
        "deadline-test",
        feed=_Feed(),
        grid=Grid(_cfg()),
        timer=_FakeTimer(),
        stats=stats,
        recorder=None,
    )


async def test_recording_boot_abandoned_by_cancellation_closes_its_recorder():
    stats = SessionStats()
    session = _session(stats)
    session._recorder_root = object()  # any non-None root selects the recorder boot path
    entered, release = threading.Event(), threading.Event()
    recorder = _FakeRecorder()

    def blocking():
        entered.set()
        assert release.wait(5)
        return recorder, None

    session._boot_blocking = blocking
    boot = asyncio.create_task(session._boot())
    assert await asyncio.to_thread(entered.wait, 2)
    boot.cancel()
    await asyncio.gather(boot, return_exceptions=True)
    assert not recorder.closed.is_set()  # the open is still running, nobody holds it
    assert stats.snapshot()["orphaned_work"] == 1
    release.set()
    assert await asyncio.to_thread(recorder.closed.wait, 3), "orphaned recorder never closed"


async def test_overview_step_over_its_deadline_is_answered_unavailable(monkeypatch):
    monkeypatch.setattr(history_mod, "OVERVIEW_STEP_TIMEOUT_S", 0.05)
    stats = SessionStats()
    session = _session(stats)
    release = threading.Event()

    def stuck():
        assert release.wait(5)
        return "late"

    try:
        try:
            await session._overview_call(stuck)
        except OverviewUnavailableError:
            pass
        else:
            raise AssertionError("an overrunning overview step must not return a result")
        assert session._overview_degraded is True
        assert session._capability().get("overview_degraded") is True
        assert stats.snapshot()["orphaned_work"] == 1
    finally:
        release.set()


async def test_overview_degraded_clears_once_a_step_completes(monkeypatch):
    monkeypatch.setattr(history_mod, "OVERVIEW_STEP_TIMEOUT_S", 0.05)
    session = _session()
    release = threading.Event()

    def stuck():
        assert release.wait(5)

    with pytest.raises(OverviewUnavailableError):
        await session._overview_call(stuck)
    assert session._overview_degraded is True
    # The abandoned step finishes first; the next step runs behind it and clears the flag.
    release.set()
    monkeypatch.setattr(history_mod, "OVERVIEW_STEP_TIMEOUT_S", 5.0)
    assert await session._overview_call(lambda: 41 + 1) == 42
    assert session._overview_degraded is False
    assert "overview_degraded" not in session._capability()


async def test_orphaned_work_stays_zero_for_steps_that_finish_in_time():
    stats = SessionStats()
    session = _session(stats)
    assert await session._overview_call(lambda: int(np.arange(3).sum())) == 3
    assert stats.snapshot()["orphaned_work"] == 0
    assert session._overview_degraded is False


async def test_boot_that_lands_as_its_subscribe_is_cancelled_still_closes_its_recorder(monkeypatch):
    session = _session(SessionStats())
    session._recorder_root = object()
    recorder = _FakeRecorder()
    session._boot_blocking = lambda: (recorder, None)

    async def landed_then_cancelled(future):
        await future  # the open has finished...
        raise asyncio.CancelledError  # ...but the subscribe is cancelled as it returns

    monkeypatch.setattr(asyncio, "shield", landed_then_cancelled)
    with pytest.raises(asyncio.CancelledError):
        await session._run_boot_blocking()
    monkeypatch.undo()
    assert await asyncio.to_thread(recorder.closed.wait, 3), "recorder that landed after cancel never closed"
