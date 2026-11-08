"""WebSocket lifecycle regressions: honest refusals, inbound limits,
Pong validation, liveness during a busy subscribe, and the entrypoint limits.

- an unexpected subscribe failure is refused with Status + 1011.
- a flood is closed, a deep-nesting decode error keeps the connection,
  and the entrypoint caps frame size and concurrency.
- the silence clock does not abort a socket the server is busy with.
- only the echo of a ping we sent counts as a latency sample.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


class FakeWS:
    """Just enough of Starlette's WebSocket for _Connection internals."""

    def __init__(self, inbound: list[dict] | None = None) -> None:
        self.sent: list[bytes] = []
        self.closed: tuple[int | None, str | None] | None = None
        self._inbound = list(inbound or [])

    async def receive(self) -> dict:
        if self._inbound:
            return self._inbound.pop(0)
        return {"type": "websocket.disconnect"}

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.closed = (code, reason)


class BrokenSendWS(FakeWS):
    async def send_bytes(self, data: bytes) -> None:
        raise OSError("peer gone")


class RaisingManager:
    """Emulates a subscribe whose feed cannot be built or booted."""

    stats = None

    async def subscribe(self, sub, client):
        raise RuntimeError("feed construction failed")

    async def unsubscribe(self, session, client) -> None:
        pass


class QuietManager(RaisingManager):
    async def subscribe(self, sub, client):  # pragma: no cover - not reached here
        raise AssertionError("not used")


def _sub(symbol: str = "AAA") -> events.Subscribe:
    return events.Subscribe(market="sim", symbol=symbol, mode="live")


# --- Unexpected subscribe failures reach the client ----------------------


async def test_unexpected_subscribe_failure_is_refused_with_status_and_1011():
    ws = FakeWS()
    conn = ws_mod._Connection(ws, RaisingManager())
    assert not await conn._subscribe(_sub())
    assert ws.closed == (ws_mod._CLOSE_INTERNAL, None)
    status, _ = wire.decode(ws.sent[-1], 0)
    assert isinstance(status, events.Status)
    assert status.feed_state == "degraded"
    assert conn._session is None


async def test_refusal_closes_the_socket_even_when_the_status_cannot_be_sent():
    ws = BrokenSendWS()
    conn = ws_mod._Connection(ws, QuietManager())
    with pytest.raises(OSError):
        await conn._refuse("degraded", ws_mod._CLOSE_INTERNAL)
    assert ws.closed == (ws_mod._CLOSE_INTERNAL, None)


# --- Inbound limits and malformed input ----------------------------------


def test_token_bucket_bursts_then_refills_at_its_rate():
    now = [0.0]
    bucket = ws_mod._TokenBucket(burst=3, rate_per_s=2.0, clock=lambda: now[0])
    assert [bucket.take() for _ in range(4)] == [True, True, True, False]
    now[0] = 0.5  # one token refilled at 2/s
    assert bucket.take() is True
    assert bucket.take() is False


async def test_inbound_flood_closes_the_socket_with_policy_code():
    frames = [{"type": "websocket.receive", "bytes": b""} for _ in range(5)]
    ws = FakeWS(inbound=frames)
    conn = ws_mod._Connection(ws, QuietManager())
    conn._inbound = ws_mod._TokenBucket(burst=2, rate_per_s=0.0)
    await asyncio.wait_for(conn._receive_loop(), 2)
    assert ws.closed == (ws_mod._CLOSE_POLICY, "inbound rate limit exceeded")


async def test_nested_envelope_recursion_is_malformed_input_not_a_socket_error(monkeypatch):
    conn = ws_mod._Connection(FakeWS(), QuietManager())

    def deep(buf, offset):
        raise RecursionError("maximum recursion depth exceeded")

    monkeypatch.setattr(ws_mod.wire, "decode", deep)
    assert await conn._handle_frame(b"\x01\x02") is True


# --- Pong validation ------------------------------------------------------


async def test_pong_that_echoes_no_sent_ping_is_ignored():
    conn = ws_mod._Connection(FakeWS(), QuietManager())
    conn.latency_ms = 7.0
    await conn._dispatch(events.Pong(echo_ns=123_456_789, client_recv_ns=0))
    assert conn.latency_ms == 7.0


async def test_each_ping_yields_at_most_one_latency_sample():
    conn = ws_mod._Connection(FakeWS(), QuietManager())
    sent = time.monotonic_ns()
    conn._note_ping(sent)
    await conn._dispatch(events.Pong(echo_ns=sent, client_recv_ns=0))
    measured = conn.latency_ms
    assert conn._outstanding_pings == {}
    await conn._dispatch(events.Pong(echo_ns=sent, client_recv_ns=0))  # replay
    assert conn.latency_ms == measured


def test_outstanding_pings_are_bounded():
    conn = ws_mod._Connection(FakeWS(), QuietManager())
    for i in range(ws_mod.PING_OUTSTANDING_MAX + 10):
        conn._note_ping(i)
    assert len(conn._outstanding_pings) == ws_mod.PING_OUTSTANDING_MAX
    assert min(conn._outstanding_pings) == 10  # the oldest pings were dropped


# --- Liveness does not fire while the server is busy ----------------------


async def test_silence_clock_is_suspended_while_a_subscribe_is_in_flight(monkeypatch):
    monkeypatch.setattr(ws_mod, "PING_INTERVAL_S", 0.01)
    monkeypatch.setattr(ws_mod, "LIVENESS_TIMEOUT_S", 0.05)
    ws = FakeWS()
    conn = ws_mod._Connection(ws, QuietManager())
    conn._hello_sent = False  # keep the loop free of pings for this check
    conn._last_recv_ns = time.monotonic_ns() - 10**9
    conn._subscribing = True
    task = asyncio.create_task(conn._ping_loop())
    await asyncio.sleep(0.2)
    assert ws.closed is None and not task.done()
    conn._subscribing = False
    await asyncio.wait_for(task, 2)  # real silence is still detected afterwards
    assert ws.closed == (None, None)


async def test_subscribe_restarts_the_silence_clock_when_it_returns():
    conn = ws_mod._Connection(FakeWS(), RaisingManager())
    conn._last_recv_ns = 0
    await conn._dispatch(_sub())
    await asyncio.wait_for(conn._subscribe_task, 2)
    assert time.monotonic_ns() - conn._last_recv_ns < 10**9
    assert conn._subscribing is False
