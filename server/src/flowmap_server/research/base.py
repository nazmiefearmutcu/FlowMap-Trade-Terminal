"""Shared plumbing for the Research drawer's sections.

Every section answers with one ``SectionResult``: real data from a free public
source, or a status with a short reason. Nothing here invents a value.

- ``ok``: ``data`` holds the section's figures.
- ``empty``: the source answered and has nothing for this symbol.
- ``not_applicable``: the section cannot apply to this symbol (no public job
  board, no options market for this coin, ...).
- ``unavailable``: the source could not be read (``reason`` says why) and no
  earlier result is held. With an earlier result, that result is served instead
  with ``stale=True``.

A section loader is an async callable returning a ``SectionResult``. It raises
on a source failure, and returns ``empty``/``not_applicable`` itself (those are
answers, cached like data). ``SectionUnavailable`` lets a loader give its own
reason for a failure that should not be cached (a missing setting, say).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import json
import logging
import re
import ssl
import time
from typing import Any

import aiohttp
import certifi
import msgspec

from flowmap_server import __version__
from flowmap_server.data.market_map import read_capped_bytes

__all__ = [
    "CRYPTO_QUOTES",
    "Http",
    "RETRY_AFTER_FAILURE_S",
    "SectionCache",
    "SectionResult",
    "SectionUnavailable",
    "crypto_base",
    "failure_reason",
    "result",
    "us_symbol",
]

logger = logging.getLogger(__name__)

STATUSES = frozenset({"ok", "empty", "unavailable", "not_applicable"})
RETRY_AFTER_FAILURE_S = 60.0
DEFAULT_TIMEOUT_S = 12.0
USER_AGENT = f"FlowMap/{__version__}"

_US_SYMBOL = re.compile(r"[A-Z][A-Z0-9.\-]{0,9}")
_CRYPTO_SYMBOL = re.compile(r"[A-Z0-9]{1,20}")
# Quote assets stripped from a chart symbol to get the coin, longest first.
CRYPTO_QUOTES = ("FDUSD", "USDT", "USDC", "BUSD", "TUSD", "USD", "EUR", "TRY")


class SectionResult(msgspec.Struct, frozen=True):
    """One section's answer for one symbol."""

    section: str
    symbol: str
    status: str
    reason: str | None
    source: str
    as_of: str | None
    fetched_ns: int
    stale: bool
    data: dict[str, Any] | None


class SectionUnavailable(Exception):
    """A loader's own reason for having no answer; never cached as data."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def result(
    section: str,
    symbol: str,
    status: str,
    *,
    source: str,
    fetched_ns: int,
    data: Mapping[str, Any] | None = None,
    reason: str | None = None,
    as_of: str | None = None,
) -> SectionResult:
    """Build a result, checking the status and that only ``ok`` carries data."""
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    if status != "ok" and data is not None:
        raise ValueError("only an ok result carries data")
    if status == "ok" and data is None:
        raise ValueError("an ok result needs data")
    return SectionResult(
        section=section,
        symbol=symbol,
        status=status,
        reason=reason,
        source=source,
        as_of=as_of,
        fetched_ns=fetched_ns,
        stale=False,
        data=dict(data) if data is not None else None,
    )


def us_symbol(raw: str) -> str | None:
    """A US ticker in upper case (``brk.b`` -> ``BRK.B``), or None when malformed."""
    symbol = raw.strip().upper()
    if symbol.startswith("EQUITY:"):
        symbol = symbol[len("EQUITY:"):]
    return symbol if _US_SYMBOL.fullmatch(symbol) else None


def crypto_base(raw: str) -> str | None:
    """The coin of a chart symbol: ``binance:ETHUSDT`` / ``ETHUSDT`` / ``ETH`` -> ``ETH``.

    The venue prefix and one known quote asset are removed. Returns None when
    what is left is not a plain alphanumeric code.
    """
    symbol = raw.strip().upper()
    if ":" in symbol:
        symbol = symbol.rsplit(":", 1)[1]
    symbol = symbol.replace("/", "").replace("-", "")
    for quote in CRYPTO_QUOTES:
        if symbol.endswith(quote) and len(symbol) > len(quote):
            symbol = symbol[: -len(quote)]
            break
    return symbol if _CRYPTO_SYMBOL.fullmatch(symbol) else None


def failure_reason(exc: BaseException) -> str:
    """A short machine reason for a failed read; never the URL or a header."""
    if isinstance(exc, SectionUnavailable):
        return exc.reason
    if isinstance(exc, aiohttp.ClientResponseError):
        return f"http_{exc.status}"
    if isinstance(exc, (aiohttp.ClientError, asyncio.TimeoutError, TimeoutError, OSError)):
        return "unreachable"
    if isinstance(exc, (ValueError, KeyError, TypeError, IndexError, json.JSONDecodeError)):
        return "malformed"
    return "failed"


class Http:
    """One shared HTTP session for the research sources, with bounded reads."""

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            context = ssl.create_default_context(cafile=certifi.where())
            self._session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=context))
        return self._session

    async def get_bytes(
        self,
        url: str,
        *,
        limit: int,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> bytes:
        merged = {"User-Agent": USER_AGENT, **(headers or {})}
        async with self._http().get(
            url, headers=merged, params=params, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as response:
            response.raise_for_status()
            return await read_capped_bytes(response, limit=limit)

    async def get_json(
        self,
        url: str,
        *,
        limit: int,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> object:
        body = await self.get_bytes(url, limit=limit, headers=headers, params=params, timeout_s=timeout_s)
        return json.loads(body)

    async def post_json(
        self,
        url: str,
        payload: object,
        *,
        limit: int,
        headers: Mapping[str, str] | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> object:
        merged = {"User-Agent": USER_AGENT, "Content-Type": "application/json", **(headers or {})}
        async with self._http().post(
            url, data=json.dumps(payload), headers=merged, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as response:
            response.raise_for_status()
            return json.loads(await read_capped_bytes(response, limit=limit))

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is not None and not session.closed:
            await session.close()


Loader = Callable[[], Awaitable[SectionResult]]


class SectionCache:
    """Results per (section, symbol), each kept for its own TTL.

    Concurrent callers for one key share a single load. A failed load serves the
    previous result for that key marked ``stale=True`` when there is one, else an
    ``unavailable`` result with the failure's reason, and the key is not loaded
    again for ``retry_after_s``. A ``SectionUnavailable`` is answered the same way
    but does not start the retry floor (it is a setting, not a source fault).
    """

    def __init__(
        self,
        *,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        retry_after_s: float = RETRY_AFTER_FAILURE_S,
    ) -> None:
        self._clock = clock
        self._monotonic = monotonic
        self._retry_after_s = retry_after_s
        self._held: dict[tuple[str, str], tuple[SectionResult, float]] = {}
        self._failed: dict[tuple[str, str], tuple[float, str]] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    def now_ns(self) -> int:
        return self._clock()

    async def get(
        self, section: str, symbol: str, *, ttl_s: float, source: str, load: Loader
    ) -> SectionResult:
        key = (section, symbol)
        fresh = self._fresh(key, ttl_s)
        if fresh is not None:
            return fresh
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            fresh = self._fresh(key, ttl_s)
            if fresh is not None:
                return fresh
            failed = self._failed.get(key)
            if failed is not None and self._monotonic() - failed[0] < self._retry_after_s:
                return self._fallback(key, section, symbol, source, failed[1])
            try:
                answer = await load()
            except SectionUnavailable as exc:
                return self._fallback(key, section, symbol, source, exc.reason)
            except Exception as exc:  # a source fault: answered, never raised to the route
                reason = failure_reason(exc)
                self._failed[key] = (self._monotonic(), reason)
                logger.warning("research %s for %s failed: %s", section, symbol, reason)
                return self._fallback(key, section, symbol, source, reason)
            self._held[key] = (answer, self._monotonic())
            self._failed.pop(key, None)
            return answer

    def _fresh(self, key: tuple[str, str], ttl_s: float) -> SectionResult | None:
        held = self._held.get(key)
        if held is None:
            return None
        answer, at = held
        return answer if self._monotonic() - at < ttl_s else None

    def _fallback(
        self, key: tuple[str, str], section: str, symbol: str, source: str, reason: str
    ) -> SectionResult:
        held = self._held.get(key)
        if held is not None:
            previous = held[0]
            return msgspec.structs.replace(previous, stale=True, reason=reason)
        return result(
            section, symbol, "unavailable", source=source, fetched_ns=self._clock(), reason=reason
        )
