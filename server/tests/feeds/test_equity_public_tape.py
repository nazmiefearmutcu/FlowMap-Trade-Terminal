"""Direction fidelity, deduplication, fan-out and loss scopes; no network."""

import asyncio
from contextlib import asynccontextmanager
import json

import pytest
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from flowmap_server.feeds.equity_public_tape import (
    PublicEquityTapeHub,
    TapeState,
    parse_trade,
    retry_delay,
)
from flowmap_server.proto.events import SIDE_SRC_PROVIDER, SIDE_SRC_NA, Trade

NOW = 1_794_940_000_000_000_000


def row(identity="one", side="buy", quantity="10", price="155.1"):
    return {
        "id": identity,
        "side": side,
        "quantity": quantity,
        "price": price,
        "timestamp": NOW // 1_000_000,
    }


@pytest.mark.parametrize(
    "side, expected, source",
    [
        ("buy", 0, SIDE_SRC_PROVIDER),
        ("sell", 1, SIDE_SRC_PROVIDER),
        ("neutral", 2, SIDE_SRC_NA),
    ],
)
def test_provider_direction_is_preserved(side, expected, source):
    identity, trade = parse_trade(row(side=side), now_ns=NOW)
    assert identity == "one" and trade.side == expected and trade.side_src == source
    assert trade.size == 10 and trade.ts_ns == NOW


@pytest.mark.parametrize(
    "change",
    [
        {"quantity": "-1"},
        {"quantity": "NaN"},
        {"price": "Infinity"},
        {"price": "0"},
        {"side": "unknown"},
        {"timestamp": NOW // 1_000_000 + 2001},
        {"id": None},
    ],
)
def test_bad_values_cannot_poison_cvd(change):
    with pytest.raises(ValueError):
        parse_trade({**row(), **change}, now_ns=NOW)


def test_retry_after_is_respected():
    assert retry_delay({"Retry-After": "120"}, now_s=0) == 120
    assert retry_delay({}, now_s=0) == 60
    assert retry_delay({"Retry-After": "NaN"}, now_s=0) == 60
    assert retry_delay({"Retry-After": "Thu, 01 Jan 1970 00:02:00 GMT"}, now_s=0) == 120


class Socket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.sent = []

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def recv(self):
        return await self.messages.get()

    def publish(self, rows):
        self.messages.put_nowait(
            json.dumps({"cmd": "trade", "data": {"symbol": "NVDA.US", "trades": rows}})
        )


@pytest.mark.asyncio
async def test_two_consumers_share_socket_and_last_unsubscribe_closes_it():
    socket = Socket()
    opens = closes = keys = 0

    async def key():
        nonlocal keys
        keys += 1
        return "public-test-placeholder"

    @asynccontextmanager
    async def dial(*args, **kwargs):
        nonlocal opens, closes
        opens += 1
        try:
            yield socket
        finally:
            closes += 1

    hub = PublicEquityTapeHub(key_fn=key, connect_fn=dial, now_ns_fn=lambda: NOW)
    first = hub.stream("NVDA")
    second = hub.stream("NVDA")
    assert (await anext(first)).available is False
    assert (await anext(second)).available is False
    await asyncio.sleep(0)
    socket.publish([row("a"), row("a"), row("b", side="sell")])
    for stream in (first, second):
        anchor = await asyncio.wait_for(anext(stream), 1)
        assert isinstance(anchor, TapeState) and anchor.available and anchor.anchor_ns == NOW
        a = await anext(stream)
        b = await anext(stream)
        assert isinstance(a, Trade) and isinstance(b, Trade) and (a.side, b.side) == (0, 1)
    assert hub.duplicates == 1
    assert opens == keys == 1
    assert len(socket.sent) == 1
    await first.aclose()
    assert closes == 0
    await second.aclose()
    assert closes == 1 and hub._task is None


@pytest.mark.asyncio
async def test_changed_trade_identity_invalidates_scope():
    socket = Socket()

    async def key():
        return "public-test-placeholder"

    @asynccontextmanager
    async def dial(*args, **kwargs):
        yield socket

    hub = PublicEquityTapeHub(key_fn=key, connect_fn=dial, now_ns_fn=lambda: NOW)
    stream = hub.stream("NVDA")
    await anext(stream)
    socket.publish([row(), row(quantity="11")])
    assert (await anext(stream)).available
    assert isinstance(await anext(stream), Trade)
    state = await anext(stream)
    assert isinstance(state, TapeState) and not state.available and "validation" in state.reason
    await stream.aclose()


@pytest.mark.asyncio
async def test_consumer_overflow_emits_loss_then_a_new_anchor():
    socket = Socket()

    async def key():
        return "public-test-placeholder"

    @asynccontextmanager
    async def dial(*args, **kwargs):
        yield socket

    hub = PublicEquityTapeHub(key_fn=key, connect_fn=dial, now_ns_fn=lambda: NOW, queue_size=5)
    stream = hub.stream("NVDA")
    await anext(stream)
    socket.publish([row(str(i)) for i in range(8)])
    await asyncio.sleep(0.01)
    state = await anext(stream)
    assert isinstance(state, TapeState) and not state.available and "overflow" in state.reason
    anchor = await anext(stream)
    assert isinstance(anchor, TapeState) and anchor.available
    assert isinstance(await anext(stream), Trade)
    assert hub.dropped > 0
    await stream.aclose()


@pytest.mark.asyncio
async def test_non_trial_symbol_does_not_fetch_credentials_or_open_socket():
    def forbidden():
        raise AssertionError("network attempted")

    hub = PublicEquityTapeHub(key_fn=forbidden, connect_fn=forbidden)
    assert [x async for x in hub.stream("XYZ")] == [TapeState(False, "symbol outside public trial")]


@pytest.mark.asyncio
async def test_429_honors_retry_after_and_reuses_the_same_key():
    socket = Socket()
    attempts = keys = 0
    delays = []

    async def key():
        nonlocal keys
        keys += 1
        return "public-test-placeholder"

    async def sleep(seconds):
        delays.append(seconds)
        await asyncio.sleep(0)

    @asynccontextmanager
    async def dial(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise InvalidStatus(
                Response(
                    429,
                    "Too Many Requests",
                    Headers({"Retry-After": "120"}),
                    b'{"code":3003,"message":"connection limit"}',
                )
            )
        yield socket

    hub = PublicEquityTapeHub(key_fn=key, connect_fn=dial, sleep_fn=sleep, now_ns_fn=lambda: NOW)
    stream = hub.stream("NVDA")
    await anext(stream)
    state = await anext(stream)
    assert isinstance(state, TapeState) and state.reason == "provider HTTP 429; code 3003"
    socket.publish([row()])
    assert (await anext(stream)).available
    assert isinstance(await anext(stream), Trade)
    assert attempts == 2 and keys == 1 and delays == [120.0]
    await stream.aclose()
