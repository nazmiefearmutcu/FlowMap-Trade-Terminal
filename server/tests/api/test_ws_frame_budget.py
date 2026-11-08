"""Inbound budget applies per message, and a Subscribe run coalesces.

A frame batches several messages. Charging the budget per frame alone let one
256 KiB frame carry an unbounded number of Subscribe messages, each of which
tore down and rebuilt the session. These tests pin the per-message charge and
the coalescing of consecutive Subscribe messages, against a fake socket.
"""

from __future__ import annotations

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


class _FakeSocket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed: int | None = None

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = code


def _conn() -> tuple[ws_mod._Connection, _FakeSocket]:
    sock = _FakeSocket()
    return ws_mod._Connection(sock, manager=None), sock  # type: ignore[arg-type]


def _subscribe(symbol: str) -> events.Subscribe:
    return events.Subscribe(market="sim", symbol=symbol, mode="live")


async def test_a_frame_cannot_carry_more_messages_than_the_burst_allows() -> None:
    conn, sock = _conn()
    # Pongs for unknown pings are cheap no-ops, so only the budget can stop them.
    batch = b"".join(
        wire.encode(events.Pong(echo_ns=i + 1, client_recv_ns=0))
        for i in range(ws_mod.INBOUND_BURST_FRAMES * 2)
    )
    assert await conn._handle_frame(batch) is False
    assert sock.closed == ws_mod._CLOSE_POLICY


async def test_a_modest_batch_is_not_penalised() -> None:
    conn, sock = _conn()
    batch = b"".join(
        wire.encode(events.Pong(echo_ns=i + 1, client_recv_ns=0)) for i in range(20)
    )
    assert await conn._handle_frame(batch) is True
    assert sock.closed is None


async def test_consecutive_subscribes_in_one_frame_coalesce_to_the_last(monkeypatch) -> None:
    conn, sock = _conn()
    started: list[str] = []

    async def record(sub: events.Subscribe) -> None:
        started.append(sub.symbol)

    monkeypatch.setattr(conn, "_run_subscribe", record)
    batch = b"".join(wire.encode(_subscribe(s)) for s in ("AAA", "BBB", "CCC"))
    assert await conn._handle_frame(batch) is True
    task = conn._subscribe_task
    assert task is not None
    await task
    assert started == ["CCC"]
    assert sock.closed is None


async def test_a_subscribe_followed_by_other_work_is_still_dispatched(monkeypatch) -> None:
    conn, _sock = _conn()
    started: list[str] = []

    async def record(sub: events.Subscribe) -> None:
        started.append(sub.symbol)

    monkeypatch.setattr(conn, "_run_subscribe", record)
    batch = wire.encode(_subscribe("AAA")) + wire.encode(events.Pong(echo_ns=1, client_recv_ns=0))
    assert await conn._handle_frame(batch) is True
    assert conn._subscribe_task is not None
    await conn._subscribe_task
    assert started == ["AAA"]


async def test_a_subscribe_before_a_malformed_tail_is_not_lost(monkeypatch) -> None:
    conn, sock = _conn()
    started: list[str] = []

    async def record(sub: events.Subscribe) -> None:
        started.append(sub.symbol)

    monkeypatch.setattr(conn, "_run_subscribe", record)
    batch = wire.encode(_subscribe("AAA")) + b"\xff" * 7
    assert await conn._handle_frame(batch) is True
    assert conn._subscribe_task is not None
    await conn._subscribe_task
    assert started == ["AAA"]
    assert sock.closed is None
