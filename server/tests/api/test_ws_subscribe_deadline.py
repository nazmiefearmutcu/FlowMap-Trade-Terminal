"""A subscribe is bounded, and the connection keeps reading while it waits.

Before these guarantees a subscribe that stalled in boot held its socket with
no deadline, and the receive loop was blocked inside it, so a peer close was
never read. Each test pins one of the guarantees.
"""

from __future__ import annotations

import asyncio

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


def _sub(symbol: str = "AAA") -> events.Subscribe:
    return events.Subscribe(market="sim", symbol=symbol, mode="live")


def _request(identity: int = 1) -> events.HistoryRequest:
    return events.HistoryRequest(req_id=identity, before_t=2**63 - 1, n_cols=64,
                                 start_col=None, end_col=None, stride=1)


class Socket:
    """Inbound messages come from a queue; every outbound frame is recorded."""

    def __init__(self, inbound=()) -> None:
        self.sent: list[bytes] = []
        self.messages: asyncio.Queue = asyncio.Queue()
        for message in inbound:
            self.messages.put_nowait(message)
        self.closed: tuple | None = None

    async def receive(self):
        return await self.messages.get()

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code=None, reason=None) -> None:
        self.closed = (code, reason)
        self.messages.put_nowait({"type": "websocket.disconnect"})


def _statuses(socket: Socket) -> list[events.Status]:
    out = []
    for data in socket.sent:
        message, _ = wire.decode(data, 0)
        if isinstance(message, events.Status):
            out.append(message)
    return out


class _Session:
    session_id = "deadline-session"
    conn_stats = None

    def __init__(self) -> None:
        self.calls: list[int] = []

    async def handle_history_async(self, req) -> bytes:
        self.calls.append(req.req_id)
        return wire.encode(events.HistoryResponse(
            req_id=req.req_id, epoch=0, oldest_available_t_ns=0, depth_cols=[],
            bar_cols=[], markers=[], big_trades=[]))

    def feed_control(self, ev) -> None:
        pass

    def detach(self, client) -> None:
        pass


class HungManager:
    """``subscribe`` never returns on its own; it records when it is cancelled."""

    def __init__(self) -> None:
        self.cancelled = False
        self.unsubscribed: list[object] = []

    async def subscribe(self, sub, client):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    async def unsubscribe(self, session, client) -> None:
        self.unsubscribed.append(session)


class QuickManager:
    """Attaches at once; ``subscribe`` returns the session it built."""

    def __init__(self, sessions: dict[str, _Session]) -> None:
        self.sessions = sessions
        self.unsubscribed: list[object] = []

    async def subscribe(self, sub, client):
        return self.sessions[sub.symbol]

    async def unsubscribe(self, session, client) -> None:
        self.unsubscribed.append(session)


async def test_subscribe_past_its_deadline_is_refused_with_a_reason_and_1011(monkeypatch):
    monkeypatch.setattr(ws_mod, "SUBSCRIBE_DEADLINE_S", 0.05)
    socket = Socket()
    conn = ws_mod._Connection(socket, HungManager())
    assert not await conn._subscribe(_sub())
    assert socket.closed == (ws_mod._CLOSE_INTERNAL, None)
    statuses = _statuses(socket)
    assert statuses and statuses[-1].feed_state == "degraded"
    assert statuses[-1].capability == {"reason": ws_mod.REASON_SUBSCRIBE_TIMEOUT}
    assert conn._session is None


async def test_peer_close_during_a_stuck_subscribe_is_seen_at_once(monkeypatch):
    # The deadline is far away: only the peer close can end this connection in time.
    monkeypatch.setattr(ws_mod, "SUBSCRIBE_DEADLINE_S", 600.0)
    manager = HungManager()
    socket = Socket(inbound=[{"type": "websocket.receive", "bytes": wire.encode(_sub())},
                             {"type": "websocket.disconnect"}])
    conn = ws_mod._Connection(socket, manager)
    await asyncio.wait_for(conn.run(), 2)
    assert manager.cancelled, "the stuck subscribe was not cancelled by the close"
    assert conn._subscribe_task is None
    assert conn._session is None


async def test_a_subscribe_that_attached_is_released_when_the_peer_leaves():
    session = _Session()
    manager = QuickManager({"AAA": session})
    socket = Socket(inbound=[{"type": "websocket.receive", "bytes": wire.encode(_sub())},
                             {"type": "websocket.disconnect"}])
    conn = ws_mod._Connection(socket, manager)
    await asyncio.wait_for(conn.run(), 2)
    assert manager.unsubscribed == [session]
    assert conn._session is None


async def test_frames_behind_a_subscribe_apply_to_the_new_session_in_order():
    session = _Session()
    manager = QuickManager({"AAA": session})
    socket = Socket()
    conn = ws_mod._Connection(socket, manager)
    # Subscribe and a HistoryRequest arrive in one frame: the request belongs
    # to the subscription, so it must be served by it once it is attached.
    await conn._handle_frame(wire.encode(_sub()) + wire.encode(_request(7)))
    await asyncio.wait_for(conn._subscribe_task, 2)
    for _ in range(50):
        if session.calls:
            break
        await asyncio.sleep(0.01)
    assert session.calls == [7]


async def test_keepalive_pong_is_not_held_behind_a_subscribe(monkeypatch):
    monkeypatch.setattr(ws_mod, "SUBSCRIBE_DEADLINE_S", 600.0)
    conn = ws_mod._Connection(Socket(), HungManager())
    conn._outstanding_pings[12345] = None
    await conn._handle_frame(wire.encode(_sub()))
    assert conn._subscribing
    await conn._handle_frame(wire.encode(events.Pong(echo_ns=12345, client_recv_ns=0)))
    assert 12345 not in conn._outstanding_pings
    assert conn.latency_ms >= 0.0
    await conn._drop_session()
    await conn._cancel_subscribe()
    assert not conn._subscribing
