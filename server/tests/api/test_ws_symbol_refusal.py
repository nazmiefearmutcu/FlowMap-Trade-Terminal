"""WS Subscribe symbol validation and refusal reasons.

- A malformed ``Subscribe.symbol`` is refused before it can join a SessionManager
  key (1003, reason ``invalid_symbol``); a padded one is stripped and shares
  its session.
- A symbol the provider says does not exist (``UnknownSymbolError``, a
  ``ValueError`` subclass) is a terminal refusal with the same reason, so the
  client parks instead of retrying.
- Only those two cases carry ``invalid_symbol``. Every other refusal, including
  a generic ``ValueError``, keeps an empty capability.
"""

from __future__ import annotations

import pytest

from flowmap_server.api import ws as ws_mod
from flowmap_server.feeds._yahoo import UnknownSymbolError
from flowmap_server.proto import events, wire


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed: tuple[int | None, str | None] | None = None

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.closed = (code, reason)


class FakeSession:
    def __init__(self) -> None:
        self.conn_stats = None


class FakeManager:
    """Records every subscribe that reaches the manager; optionally raises."""

    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error
        self.subscriptions: list[events.Subscribe] = []

    async def subscribe(self, sub: events.Subscribe, client) -> FakeSession:
        self.subscriptions.append(sub)
        if self.error is not None:
            raise self.error
        return FakeSession()


def _statuses(ws: FakeWS) -> list[events.Status]:
    out: list[events.Status] = []
    for frame in ws.sent:
        off = 0
        while off < len(frame):
            ev, off = wire.decode(frame, off)
            if isinstance(ev, events.Status):
                out.append(ev)
    return out


def _sub(symbol: str) -> events.Subscribe:
    return events.Subscribe(market="sim", symbol=symbol, mode="live")


@pytest.mark.parametrize(
    "symbol",
    ["", "   ", "BTC USDT", "../etc", "BTC;rm -rf", "BTC\x00", "x" * 65, "-LEADING"],
)
async def test_malformed_symbol_is_refused_before_it_reaches_the_manager(symbol):
    ws = FakeWS()
    manager = FakeManager()
    conn = ws_mod._Connection(ws, manager)

    assert not await conn._subscribe(_sub(symbol))
    assert manager.subscriptions == []
    assert ws.closed == (ws_mod._CLOSE_UNSUPPORTED, None)
    [status] = _statuses(ws)
    assert status.feed_state == "degraded"
    assert status.capability == {"reason": "invalid_symbol"}


@pytest.mark.parametrize(
    "symbol",
    ["BRK.B", "^GSPC", "ES=F", "BTC/USDT:USDT", "tBTCUSD", "BTC-PERP", "1000PEPEUSDT"],
)
async def test_real_venue_spellings_pass_the_symbol_gate(symbol):
    manager = FakeManager()
    conn = ws_mod._Connection(FakeWS(), manager)

    assert await conn._subscribe(_sub(symbol))
    assert [s.symbol for s in manager.subscriptions] == [symbol]


async def test_padded_symbol_is_stripped_so_both_spellings_share_one_key():
    manager = FakeManager()
    conn = ws_mod._Connection(FakeWS(), manager)

    assert await conn._subscribe(_sub("  BTCUSDT "))
    assert [s.symbol for s in manager.subscriptions] == ["BTCUSDT"]


async def test_unknown_symbol_from_the_provider_is_a_terminal_invalid_symbol_refusal():
    ws = FakeWS()
    conn = ws_mod._Connection(ws, FakeManager(error=UnknownSymbolError("Yahoo has no ticker 'NOPE'")))

    assert not await conn._subscribe(_sub("NOPE"))
    assert ws.closed == (ws_mod._CLOSE_UNSUPPORTED, None)
    [status] = _statuses(ws)
    assert status.capability == {"reason": "invalid_symbol"}


async def test_other_value_errors_from_the_manager_stay_unreasoned():
    """Only a provider-confirmed unknown symbol earns reason=invalid_symbol. A
    generic ValueError (a recording-unsafe name, a config fault) keeps the
    empty-capability refusal it had before, so the client's retry path is
    unchanged for it."""
    ws = FakeWS()
    conn = ws_mod._Connection(ws, FakeManager(error=ValueError("recording-unsafe symbol")))

    assert not await conn._subscribe(_sub("BTCUSDT"))
    assert ws.closed == (ws_mod._CLOSE_UNSUPPORTED, None)
    assert _statuses(ws)[0].capability == {}


async def test_unexpected_failure_stays_an_unreasoned_internal_refusal():
    ws = FakeWS()
    conn = ws_mod._Connection(ws, FakeManager(error=RuntimeError("feed factory exploded")))

    assert not await conn._subscribe(_sub("BTCUSDT"))
    assert ws.closed == (ws_mod._CLOSE_INTERNAL, None)
    assert _statuses(ws)[0].capability == {}


async def test_session_limit_refusal_carries_no_reason():
    from flowmap_server.core.session import SessionLimitError

    ws = FakeWS()
    conn = ws_mod._Connection(ws, FakeManager(error=SessionLimitError("full")))

    assert not await conn._subscribe(_sub("BTCUSDT"))
    assert ws.closed == (ws_mod._CLOSE_TRY_AGAIN_LATER, None)
    assert _statuses(ws)[0].capability == {}
