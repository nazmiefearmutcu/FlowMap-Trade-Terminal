"""WS endpoint teardown: every end of a socket releases its session and returns normally.

The starlette test client cancels the endpoint task when a ``with
websocket_connect(...)`` block exits. Whether that cancel lands while the
endpoint still waits for the peer's close or during its teardown, the endpoint
must release the session and return without raising a CancelledError.
"""

from __future__ import annotations

import asyncio

from flowmap_server.api import ws as ws_mod

_DISCONNECT = {"type": "websocket.disconnect"}


class _Socket:
    """A fake socket: scripted inbound messages, then receive blocks until the test ends."""

    def __init__(self, messages: list[dict] | None = None) -> None:
        self._messages = list(messages or [])
        self._never = asyncio.Event()
        self.closed: tuple[int | None, str | None] | None = None

    async def receive(self) -> dict:
        if self._messages:
            return self._messages.pop(0)
        await self._never.wait()
        return _DISCONNECT

    async def send_bytes(self, data: bytes) -> None:
        return None

    async def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.closed = (code, reason)


class _Manager:
    """Records each release. With ``hold`` the release waits until the test lets it finish."""

    def __init__(self, hold: bool = False) -> None:
        self.released: list[object] = []
        self.entered = asyncio.Event()
        self.hold = asyncio.Event() if hold else None

    async def unsubscribe(self, session: object, client: object) -> None:
        self.entered.set()
        if self.hold is not None:
            await self.hold.wait()
        self.released.append(session)


async def test_peer_close_releases_the_session_and_returns():
    session = object()
    manager = _Manager()
    ws = _Socket([dict(_DISCONNECT)])
    conn = ws_mod._Connection(ws, manager)
    conn._session = session

    assert await conn.run() is None
    assert manager.released == [session]
    assert ws.closed is None


async def test_cancel_while_waiting_for_the_peer_returns_and_releases_the_session():
    session = object()
    manager = _Manager()
    conn = ws_mod._Connection(_Socket(), manager)
    conn._session = session

    task = asyncio.create_task(conn.run())
    await asyncio.sleep(0.01)
    task.cancel()

    assert await asyncio.wait_for(task, 5) is None
    assert manager.released == [session]


async def test_cancel_during_the_release_still_completes_the_release():
    session = object()
    manager = _Manager(hold=True)
    conn = ws_mod._Connection(_Socket([dict(_DISCONNECT)]), manager)
    conn._session = session

    task = asyncio.create_task(conn.run())
    await asyncio.wait_for(manager.entered.wait(), 5)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done(), "the teardown must not be interrupted by the cancel"

    manager.hold.set()
    assert await asyncio.wait_for(task, 5) is None
    assert manager.released == [session]
