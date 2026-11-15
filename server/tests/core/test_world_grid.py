"""World-market grid shape: the tick, the origin and the depth mode a GlobalEquityFeed gets.

A world listing's price scale is unknown until its first book, so the grid starts from a
deliberately coarse tick at origin zero and re-anchors on the first real ladder, adopting the
fifth significant digit of that price. The depth mode follows the feed's stated capability,
never the market's name. A plain US equity keeps the cent tick it always had.

The feed is built with an injected calendar that is open at every instant, so no test depends on
the wall clock or on a real exchange calendar, and nothing touches the network.
"""

from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from crocodile.equity.universal.live.model import LiveTier

from flowmap_server.config import Config
from flowmap_server.core.session_manager import (
    _EQUITY_ADAPTIVE_FALLBACK_TICK,
    SessionManager,
)
from flowmap_server.feeds import global_equity
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.global_equity import GlobalEquityFeed
from flowmap_server.proto import events


class _OpenCalendar:
    """A calendar on which the market is open at every instant: the feed is never closed."""

    tz = ZoneInfo("Europe/Istanbul")

    def is_session(self, day: datetime.date) -> bool:
        return True

    def session_open_utc(self, day: datetime.date) -> datetime.datetime:
        return datetime.datetime(2000, 1, 1, tzinfo=datetime.UTC)

    def session_close_utc(self, day: datetime.date) -> datetime.datetime:
        return datetime.datetime(2100, 1, 1, tzinfo=datetime.UTC)


class _FakeTimer:
    """SessionManager only needs a clock seam for these tests."""

    def now_ns(self) -> int:  # pragma: no cover - name matches the real seam
        return 0


def _manager() -> SessionManager:
    return SessionManager(Config(recording_enabled=False), timer=_FakeTimer())


def _world_feed(symbol: str = "THYAO", mic: str = "XIST") -> GlobalEquityFeed:
    return GlobalEquityFeed(symbol, mic, Config(), calendar=_OpenCalendar())  # type: ignore[arg-type]


def test_world_grid_starts_at_the_adaptive_fallback_tick_and_origin_zero() -> None:
    grid = _manager()._grid_for(_world_feed())
    assert grid.cfg.auto_tick is True
    assert grid.cfg.tick == _EQUITY_ADAPTIVE_FALLBACK_TICK
    assert grid.cfg.p0 == 0.0


@pytest.mark.parametrize(
    ("tier", "depth", "mode"),
    [
        (LiveTier.L2, "L2-snapshot", events.MODE_L2),
        (LiveTier.L1, "L1", events.MODE_L1_BAND),
        (LiveTier.LAST, "SYNTH", events.MODE_L1_BAND),
    ],
    ids=["l2-snapshot", "l1", "synth"],
)
def test_grid_mode_follows_the_declared_depth(
    monkeypatch: pytest.MonkeyPatch, tier: LiveTier, depth: str, mode: int
) -> None:
    monkeypatch.setattr(global_equity, "_declared_tier", lambda mic: tier)
    feed = _world_feed()
    assert feed.capability["depth"] == depth
    assert _manager()._grid_for(feed).cfg.mode == mode


def test_plain_us_equity_keeps_the_cent_tick_and_no_auto_tick() -> None:
    feed = EquityFeed("AAPL", Config())
    grid = _manager()._grid_for(feed)
    assert grid.cfg.auto_tick is False
    assert grid.cfg.tick == pytest.approx(0.01)
    # The nominal $100 origin: rows * tick / 2 below it, on the cent grid.
    assert grid.cfg.p0 == pytest.approx(79.52)
    assert grid.cfg.mode == events.MODE_L1_BAND


@pytest.mark.parametrize(
    ("mid", "step", "expected"),
    [
        (207_000.0, 10.0, 10.0),
        (318.5, 0.01, 0.01),
        (0.052, 1e-6, 1e-6),
    ],
    ids=["krw-scale", "try-scale", "penny-scale"],
)
def test_first_real_book_adapts_the_tick_to_the_fifth_significant_digit(
    mid: float, step: float, expected: float
) -> None:
    grid = _manager()._grid_for(_world_feed())
    offsets = step * np.arange(1, 9)
    qty = np.full(8, 100.0)
    # The first book opens no column; the re-anchor on its mid adopts the adaptive tick.
    assert grid.on_book(0, mid - offsets, qty, mid + offsets, qty) == []
    ep = grid.maybe_reanchor(mid)
    assert ep is not None
    assert ep.tick == pytest.approx(expected)
    assert grid._step == pytest.approx(expected)
    assert grid.cfg.auto_tick is True
