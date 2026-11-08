"""Public accessors the API layer relies on, and the wedged-recording Status.

The REST export and health probes read sessions through these accessors rather
than private attributes, so a rename fails here instead of turning into a
silent 404 or an empty health list.
"""

from __future__ import annotations

import asyncio

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.proto import events, wire

DT = 250_000_000


class _IdleFeed:
    market = "sim"
    symbol = "IDLE"
    capability: dict[str, object] = {"depth": "L2"}

    async def events(self):
        await asyncio.sleep(3600)
        if False:  # pragma: no cover - makes this an async generator
            yield None


def _grid() -> Grid:
    return Grid(GridCfg(tick=0.5, tick_multiple=1, dt_ns=DT, p0=90.0, rows=64,
                        ring_columns=128, mode=events.MODE_L2))


def _drain_statuses(client: ClientTx) -> list[events.Status]:
    out: list[events.Status] = []
    while True:
        frames = client.drain(1 << 30)
        if not frames:
            return out
        for frame in frames:
            off = 0
            while off < len(frame):
                ev, off = wire.decode(frame, off)
                if isinstance(ev, events.Status):
                    out.append(ev)


def test_session_exposes_feed_grid_and_state():
    feed, grid = _IdleFeed(), _grid()
    sess = Session("accessors", feed=feed, grid=grid)  # type: ignore[arg-type]
    assert sess.feed is feed
    assert sess.grid is grid
    assert sess.feed_state == "live"


def test_active_sessions_is_a_snapshot_copy():
    manager = SessionManager(Config())
    assert manager.active_sessions() == []
    sess = Session("k", feed=_IdleFeed(), grid=_grid())  # type: ignore[arg-type]
    manager._sessions[("sim", "IDLE", "live", None, "0")] = sess
    pairs = manager.active_sessions()
    assert pairs == [(("sim", "IDLE", "live", None, "0"), sess)]
    manager._sessions.clear()
    assert len(pairs) == 1


def test_wedged_recording_is_published_and_cleared():
    sess = Session("wedge", feed=_IdleFeed(), grid=_grid())  # type: ignore[arg-type]
    client = ClientTx()
    sess.attach(client)

    sess._set_recording_wedged(True)
    statuses = _drain_statuses(client)
    assert len(statuses) == 1
    assert statuses[0].capability["recording_health"] == "wedged"
    assert statuses[0].capability["recording_degraded"] is True
    # A client attaching during the wedge learns it from the capability too.
    assert sess._capability()["recording_health"] == "wedged"

    sess._set_recording_wedged(False)
    statuses = _drain_statuses(client)
    assert len(statuses) == 1
    assert "recording_health" not in statuses[0].capability
    assert "recording_degraded" not in statuses[0].capability

    sess._set_recording_wedged(False)  # no change, nothing published
    assert _drain_statuses(client) == []
