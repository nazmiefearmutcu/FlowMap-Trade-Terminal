"""Research plumbing: results, symbols, failure reasons and the section cache. No network."""

from __future__ import annotations

import asyncio

import aiohttp
import pytest

from flowmap_server.research.base import (
    SectionCache,
    SectionResult,
    SectionUnavailable,
    crypto_base,
    failure_reason,
    result,
    us_symbol,
)


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _ok(value: int) -> SectionResult:
    return result("gex", "NVDA", "ok", source="Test", fetched_ns=1, data={"value": value})


def test_only_an_ok_result_carries_data() -> None:
    assert _ok(1).data == {"value": 1}
    with pytest.raises(ValueError):
        result("gex", "NVDA", "empty", source="Test", fetched_ns=1, data={"x": 1})
    with pytest.raises(ValueError):
        result("gex", "NVDA", "ok", source="Test", fetched_ns=1)
    with pytest.raises(ValueError):
        result("gex", "NVDA", "maybe", source="Test", fetched_ns=1)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("NVDA", "NVDA"), ("brk.b", "BRK.B"), ("equity:aapl", "AAPL"), ("", None), ("NV DA", None), ("1ABC", None)],
)
def test_us_symbol(raw: str, expected: str | None) -> None:
    assert us_symbol(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("binance:ETHUSDT", "ETH"),
        ("BTCUSDT", "BTC"),
        ("eth", "ETH"),
        ("SOL/USDC", "SOL"),
        ("binance-spot:1000PEPEUSDT", "1000PEPE"),
        ("USDT", "USDT"),
        ("bad symbol!", None),
    ],
)
def test_crypto_base(raw: str, expected: str | None) -> None:
    assert crypto_base(raw) == expected


def test_failure_reasons_never_carry_the_url() -> None:
    info = aiohttp.RequestInfo(url=aiohttp.client.URL("https://x.test/?symbol=NVDA"), method="GET", headers={})  # type: ignore[arg-type]
    http_error = aiohttp.ClientResponseError(info, (), status=503)
    assert failure_reason(http_error) == "http_503"
    assert failure_reason(aiohttp.ClientConnectionError("https://x.test")) == "unreachable"
    assert failure_reason(TimeoutError()) == "unreachable"
    assert failure_reason(ValueError("over the limit")) == "malformed"
    assert failure_reason(ValueError("response body is over the 100 byte limit")) == "too_large"
    assert failure_reason(SectionUnavailable("sec_contact_missing")) == "sec_contact_missing"
    assert failure_reason(RuntimeError("x")) == "failed"


async def test_a_fresh_result_is_served_from_the_cache() -> None:
    mono = _Clock()
    cache = SectionCache(monotonic=mono)
    calls = 0

    async def load() -> SectionResult:
        nonlocal calls
        calls += 1
        return _ok(calls)

    first = await cache.get("gex", "NVDA", ttl_s=60, source="Test", load=load)
    mono.t += 30
    second = await cache.get("gex", "NVDA", ttl_s=60, source="Test", load=load)
    assert first is second and calls == 1
    mono.t += 31
    third = await cache.get("gex", "NVDA", ttl_s=60, source="Test", load=load)
    assert third.data == {"value": 2}


async def test_a_failed_refresh_serves_the_previous_result_stale_and_waits_before_retrying() -> None:
    mono = _Clock()
    cache = SectionCache(monotonic=mono, retry_after_s=60)
    outcome: list[object] = [_ok(1)]
    calls = 0

    async def load() -> SectionResult:
        nonlocal calls
        calls += 1
        item = outcome[0]
        if isinstance(item, Exception):
            raise item
        assert isinstance(item, SectionResult)
        return item

    await cache.get("gex", "NVDA", ttl_s=10, source="Test", load=load)
    outcome[0] = aiohttp.ClientConnectionError()
    mono.t += 11
    stale = await cache.get("gex", "NVDA", ttl_s=10, source="Test", load=load)
    assert stale.stale and stale.data == {"value": 1} and stale.reason == "unreachable"
    mono.t += 30
    await cache.get("gex", "NVDA", ttl_s=10, source="Test", load=load)
    assert calls == 2  # inside the retry floor: no new load
    outcome[0] = _ok(3)
    mono.t += 31
    fresh = await cache.get("gex", "NVDA", ttl_s=10, source="Test", load=load)
    assert not fresh.stale and fresh.data == {"value": 3}


async def test_a_failure_with_nothing_held_is_unavailable_with_its_reason() -> None:
    cache = SectionCache(monotonic=_Clock(), clock=lambda: 42)

    async def load() -> SectionResult:
        raise ValueError("bad json")

    answer = await cache.get("gex", "NVDA", ttl_s=10, source="Cboe", load=load)
    assert (answer.status, answer.reason, answer.source, answer.data) == ("unavailable", "malformed", "Cboe", None)


async def test_a_section_unavailable_is_answered_but_does_not_start_the_retry_floor() -> None:
    cache = SectionCache(monotonic=_Clock())
    calls = 0

    async def load() -> SectionResult:
        nonlocal calls
        calls += 1
        raise SectionUnavailable("sec_contact_missing")

    first = await cache.get("language", "NVDA", ttl_s=10, source="SEC", load=load)
    second = await cache.get("language", "NVDA", ttl_s=10, source="SEC", load=load)
    assert first.reason == second.reason == "sec_contact_missing"
    assert calls == 2


async def test_concurrent_callers_share_one_load() -> None:
    cache = SectionCache(monotonic=_Clock())
    calls = 0
    gate = asyncio.Event()

    async def load() -> SectionResult:
        nonlocal calls
        calls += 1
        await gate.wait()
        return _ok(1)

    tasks = [asyncio.create_task(cache.get("gex", "NVDA", ttl_s=10, source="T", load=load)) for _ in range(5)]
    await asyncio.sleep(0)
    gate.set()
    answers = await asyncio.gather(*tasks)
    assert calls == 1 and all(a is answers[0] for a in answers)
