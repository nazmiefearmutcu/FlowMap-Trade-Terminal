"""A cold subscribe keeps the client's handshake window open until its Hello.

Session preparation (venue discovery) can outlast the client's handshake
deadline. Only a Status frame sent before the Hello extends that window, so the
WS layer must emit progress Status frames while ``manager.subscribe`` is pending.
"""

from __future__ import annotations

import asyncio

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


class _Socket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code=None, reason=None) -> None:
        pass


class _FakeSession:
    session_id = "fake-session"
    conn_stats = None


class _SlowManager:
    """``subscribe`` stays pending until the test releases it."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.session = _FakeSession()

    async def subscribe(self, sub, client):
        await self.release.wait()
        return self.session

    async def unsubscribe(self, session, client) -> None:
        pass


async def _wait_until(predicate, timeout: float = 2.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


async def test_pending_subscribe_sends_progress_status_before_hello(monkeypatch):
    monkeypatch.setattr(ws_mod, "SUBSCRIBE_PROGRESS_S", 0.01)
    ws = _Socket()
    manager = _SlowManager()
    conn = ws_mod._Connection(ws, manager)  # type: ignore[arg-type]
    sub = events.Subscribe(market="sim", symbol="SIM-DEMO", mode="live")

    task = asyncio.create_task(conn._subscribe(sub))
    await _wait_until(lambda: len(ws.sent) >= 3)
    frames = [wire.decode(frame, 0)[0] for frame in ws.sent]
    assert all(isinstance(ev, events.Status) for ev in frames)
    assert all(ev.feed_state == "reconnecting" for ev in frames)

    manager.release.set()
    assert await task is True
    assert conn._session is manager.session
    # The per-connection latency hook is installed once the subscribe succeeds.
    assert manager.session.conn_stats == conn._conn_stats


async def test_progress_status_stops_when_subscribe_returns(monkeypatch):
    monkeypatch.setattr(ws_mod, "SUBSCRIBE_PROGRESS_S", 0.01)
    ws = _Socket()
    manager = _SlowManager()
    conn = ws_mod._Connection(ws, manager)  # type: ignore[arg-type]
    sub = events.Subscribe(market="sim", symbol="SIM-DEMO", mode="live")

    task = asyncio.create_task(conn._subscribe(sub))
    await _wait_until(lambda: len(ws.sent) >= 1)
    manager.release.set()
    assert await task is True

    settled = len(ws.sent)
    await asyncio.sleep(0.05)
    assert len(ws.sent) == settled, "progress frames kept coming after the subscribe"
