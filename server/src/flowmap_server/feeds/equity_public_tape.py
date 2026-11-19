"""One account-free, provider-classified stock tape connection per event loop.

TickDB explicitly publishes anonymous trial access for the symbols below. This
is trial access, not a promise of permanent availability or consolidated-market
completeness. Keys stay in memory and are never rotated to evade a limit.

Cboe's independent book remains the depth source. This module supplies prints
only. A lost connection or consumer overflow starts a new observable CVD scope;
missing transactions are never inferred or stitched from incompatible REST IDs.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
import json
import logging
import math
import ssl
import time
from typing import Any
from urllib.parse import urlencode
from weakref import WeakKeyDictionary

import aiohttp
import certifi
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from flowmap_server.proto.events import (
    SIDE_BUY,
    SIDE_SELL,
    SIDE_UNKNOWN,
    SIDE_SRC_NA,
    SIDE_SRC_PROVIDER,
    Trade,
)

SUPPORTED_SYMBOLS = frozenset(
    {
        "AAPL",
        "TSLA",
        "NVDA",
        "MSFT",
        "GOOGL",
        "AMZN",
        "META",
        "AMD",
        "NFLX",
        "BABA",
    }
)
PUBLIC_KEYS_URL = "https://tickdb.ai/api/public/claw-keys"
STREAM_URL = "wss://api.tickdb.ai/v1/realtime"
_QUEUE_SIZE = 16_384
_IDENTITIES = 65_536
# The WebSocket library's debug handshake log includes the query-string key.
# Connection failures are surfaced below without exposing that URL.
_WS_LOG = logging.Logger("flowmap.public_equity_ws", level=logging.CRITICAL)


@dataclass(frozen=True)
class TapeState:
    available: bool
    reason: str = ""
    anchor_ns: int | None = None


TapeMessage = Trade | TapeState


def _find_public_key(value: object) -> str | None:
    children: Iterable[object]
    if isinstance(value, dict):
        key = value.get("apiKey")
        if isinstance(key, str) and key:
            return key
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return None
    for child in children:
        key = _find_public_key(child)
        if key:
            return key
    return None


async def _fetch_public_key() -> str:
    tls = ssl.create_default_context(cafile=certifi.where())
    async with aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=tls),
        timeout=aiohttp.ClientTimeout(total=20),
    ) as session:
        async with session.get(PUBLIC_KEYS_URL) as response:
            response.raise_for_status()
            key = _find_public_key(await response.json())
    if not key:
        raise ValueError("public trial key unavailable")
    return key


def parse_trade(row: dict[str, Any], *, now_ns: int) -> tuple[str, Trade]:
    """Keep the provider's direction; never apply a tick/quote heuristic."""
    try:
        raw_identity = row["id"]
        if not isinstance(raw_identity, (str, int)) or isinstance(raw_identity, bool):
            raise ValueError("invalid provider trade identity")
        identity = str(raw_identity)
        stamp = int(row["timestamp"]) * 1_000_000
        price = Decimal(str(row["price"]))
        size = Decimal(str(row["quantity"]))
        direction = row["side"]
    except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
        raise ValueError("invalid provider trade") from exc
    if not identity or direction not in ("buy", "sell", "neutral"):
        raise ValueError("invalid provider trade identity/direction")
    if not 1_262_304_000_000_000_000 <= stamp <= now_ns + 2_000_000_000:
        raise ValueError("invalid provider trade timestamp")
    if any(not x.is_finite() or x <= 0 or not math.isfinite(float(x)) for x in (price, size)):
        raise ValueError("invalid provider trade price/quantity")
    side = SIDE_BUY if direction == "buy" else SIDE_SELL if direction == "sell" else SIDE_UNKNOWN
    return identity, Trade(
        ts_ns=stamp,
        price=float(price),
        size=float(size),
        side=side,
        side_src=SIDE_SRC_PROVIDER if side != SIDE_UNKNOWN else SIDE_SRC_NA,
        venue="tickdb",
    )


def retry_delay(headers: Any, *, now_s: float) -> float:
    """Honor Retry-After; absent guidance uses a conservative minute."""
    raw = headers.get("Retry-After", "60")
    try:
        delay = float(raw)
    except (TypeError, ValueError):
        try:
            delay = parsedate_to_datetime(str(raw)).timestamp() - now_s
        except (TypeError, ValueError, OverflowError):
            delay = 60.0
    return max(30.0, delay) if math.isfinite(delay) else 60.0


class PublicEquityTapeHub:
    """Multiplex active symbol consumers on one permitted WebSocket."""

    def __init__(
        self,
        *,
        key_fn: Callable[..., Any] = _fetch_public_key,
        connect_fn: Callable[..., Any] = connect,
        now_ns_fn: Callable[[], int] = time.time_ns,
        sleep_fn: Callable[..., Any] = asyncio.sleep,
        queue_size: int = _QUEUE_SIZE,
    ) -> None:
        self._key_fn = key_fn
        self._connect = connect_fn
        self._now_ns = now_ns_fn
        self._sleep = sleep_fn
        self._queue_size = max(4, queue_size)
        self._listeners: dict[str, set[asyncio.Queue[TapeMessage]]] = {}
        self._pending: set[asyncio.Queue[TapeMessage]] = set()
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._changed = False
        self.dropped = 0
        self.duplicates = 0

    async def stream(self, symbol: str) -> AsyncIterator[TapeMessage]:
        symbol = symbol.upper()
        if symbol not in SUPPORTED_SYMBOLS:
            yield TapeState(False, "symbol outside public trial")
            return
        queue: asyncio.Queue[TapeMessage] = asyncio.Queue(self._queue_size)
        async with self._lock:
            self._listeners.setdefault(symbol, set()).add(queue)
            self._pending.add(queue)
            self._changed = True
            queue.put_nowait(TapeState(False, "connecting"))
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._run(), name="public-equity-tape")
        try:
            while True:
                yield await queue.get()
        finally:
            async with self._lock:
                listeners = self._listeners.get(symbol)
                if listeners is not None:
                    listeners.discard(queue)
                    if not listeners:
                        del self._listeners[symbol]
                self._pending.discard(queue)
                self._changed = True
                if not self._listeners and self._task is not None:
                    self._task.cancel()
                    await asyncio.gather(self._task, return_exceptions=True)
                    self._task = None

    def _unavailable(self, reason: str) -> None:
        for listeners in self._listeners.values():
            for queue in listeners:
                self._pending.add(queue)
                # Control events must reach the consumer even after a stall.
                while queue.full():
                    queue.get_nowait()
                    self.dropped += 1
                queue.put_nowait(TapeState(False, reason))

    def _publish(self, symbol: str, trade: Trade) -> None:
        for queue in self._listeners.get(symbol, ()):
            if queue.qsize() > self._queue_size - 3:
                while not queue.empty():
                    queue.get_nowait()
                    self.dropped += 1
                queue.put_nowait(TapeState(False, "consumer overflow; missing trades"))
                self._pending.add(queue)
            if queue in self._pending:
                queue.put_nowait(TapeState(True, anchor_ns=trade.ts_ns))
                self._pending.discard(queue)
            queue.put_nowait(trade)

    async def _run(self) -> None:
        try:
            key = await self._key_fn()
            url = STREAM_URL + "?" + urlencode({"api_key": key})
            attempts = 0
            while self._listeners:
                try:
                    async with self._connect(
                        url,
                        ssl=ssl.create_default_context(cafile=certifi.where()),
                        open_timeout=20,
                        close_timeout=5,
                        ping_interval=None,
                        max_size=8_000_000,
                        logger=_WS_LOG,
                    ) as ws:
                        attempts = 0
                        subscribed: set[str] = set()
                        seen: OrderedDict[tuple[str, str], Trade] = OrderedDict()
                        last_ping = time.monotonic()
                        awaiting_pong = False
                        while self._listeners:
                            wanted = set(self._listeners)
                            if self._changed or wanted != subscribed:
                                self._changed = False
                                for command, names in (
                                    ("unsubscribe", subscribed - wanted),
                                    ("subscribe", wanted - subscribed),
                                ):
                                    if names:
                                        await ws.send(
                                            json.dumps(
                                                {
                                                    "cmd": command,
                                                    "data": {
                                                        "channel": "trade",
                                                        "type": "stock",
                                                        "symbols": [
                                                            s + ".US" for s in sorted(names)
                                                        ],
                                                    },
                                                }
                                            )
                                        )
                                subscribed = wanted
                            now = time.monotonic()
                            if awaiting_pong and now - last_ping > 20:
                                raise TimeoutError("public tape heartbeat")
                            if not awaiting_pong and now - last_ping >= 60:
                                await ws.send('{"cmd":"ping"}')
                                last_ping = now
                                awaiting_pong = True
                            try:
                                raw = await asyncio.wait_for(ws.recv(), timeout=1)
                            except asyncio.TimeoutError:
                                continue
                            body = json.loads(raw)
                            for message in body if isinstance(body, list) else [body]:
                                command = message.get("cmd")
                                if command == "pong":
                                    awaiting_pong = False
                                elif command == "error":
                                    code = str(message.get("code", "unknown"))
                                    self._unavailable("provider subscription error " + code)
                                    return
                                elif command == "trade":
                                    data = message["data"]
                                    full_symbol = str(data.get("symbol", ""))
                                    if not full_symbol.endswith(".US"):
                                        raise ValueError("unexpected public tape symbol")
                                    symbol = full_symbol[:-3]
                                    if symbol not in subscribed:
                                        continue
                                    for row in data["trades"]:
                                        identity, trade = parse_trade(row, now_ns=self._now_ns())
                                        identifier = symbol, identity
                                        previous = seen.get(identifier)
                                        if previous is not None:
                                            if previous != trade:
                                                raise ValueError(
                                                    "provider changed a trade identity"
                                                )
                                            self.duplicates += 1
                                            continue
                                        seen[identifier] = trade
                                        if len(seen) > _IDENTITIES:
                                            seen.popitem(last=False)
                                        self._publish(symbol, trade)
                except InvalidStatus as exc:
                    response = exc.response
                    try:
                        error = json.loads(response.body)
                        code = str(error.get("code", "unknown"))
                    except (ValueError, TypeError, AttributeError):
                        code = "unknown"
                    self._unavailable(f"provider HTTP {response.status_code}; code {code}")
                    if response.status_code in (401, 403):
                        return
                    if response.status_code == 429:
                        await self._sleep(retry_delay(response.headers, now_s=time.time()))
                        continue
                except (ValueError, KeyError, TypeError):
                    self._unavailable("provider data failed validation")
                    return
                except (ConnectionClosed, TimeoutError, OSError):
                    self._unavailable("public tape disconnected")
                attempts += 1
                await self._sleep(1 if attempts <= 3 else 5 if attempts <= 6 else 30)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Exceptions may embed the credential-bearing URL. Never log str(exc).
            self._unavailable("public tape unavailable")


_HUBS: WeakKeyDictionary[asyncio.AbstractEventLoop, PublicEquityTapeHub] = WeakKeyDictionary()


def default_public_tape(symbol: str) -> AsyncIterator[TapeMessage]:
    loop = asyncio.get_running_loop()
    hub = _HUBS.get(loop)
    if hub is None:
        hub = _HUBS[loop] = PublicEquityTapeHub()
    return hub.stream(symbol)
