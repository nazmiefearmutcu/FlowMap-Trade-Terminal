"""Symbol pre-check and market-table cache on the subscribe path. NO network.

``resolve_symbol`` is the one gate a subscribe passes before any connector is
built. These tests pin four things, with ``_load_tables`` replaced by a counting
fake so the ccxt download is observable:

- a symbol the loaded table does not list is refused before any connector,
  and the refusal costs no second table download;
- a listed symbol is translated through the cached table, in either spelling;
- a table that cannot be loaded (error or timeout) fails open and is logged once;
- a loaded table is reused within its TTL, and a failed load is retried only
  after the short negative TTL.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from flowmap_server.data import venues
from flowmap_server.data.venues import (
    EMPTY_TTL_NS,
    SYMBOL_TTL_NS,
    UnlistedSymbolError,
    resolve_symbol,
)


@pytest.fixture(autouse=True)
def _isolate_table_cache(monkeypatch: pytest.MonkeyPatch):
    """Module-level caches leak across tests; clear them before and after."""

    def clear() -> None:
        venues._cache.clear()
        venues._locks.clear()
        venues._tables.clear()
        venues._table_locks.clear()
        venues._tables_unavailable.clear()

    clear()
    yield
    clear()


def _binance_table() -> venues._VenueTables:
    markets = {
        "BTC/USDT": {"id": "BTCUSDT", "symbol": "BTC/USDT"},
        "ETH/BTC": {"id": "ETHBTC", "symbol": "ETH/BTC"},
    }
    by_id = {"BTCUSDT": [markets["BTC/USDT"]], "ETHBTC": [markets["ETH/BTC"]]}
    return venues._VenueTables(markets=markets, markets_by_id=by_id)


def _count_loads(monkeypatch: pytest.MonkeyPatch, table: venues._VenueTables | Exception):
    """Replace the ccxt download with a counting fake; return the call log."""
    calls: list[tuple[str, bool]] = []

    async def fake_load(exchange: str, swap: bool) -> venues._VenueTables:
        calls.append((exchange, swap))
        if isinstance(table, Exception):
            raise table
        return table

    monkeypatch.setattr(venues, "_load_tables", fake_load)
    return calls


def test_unlisted_symbol_error_is_a_value_error() -> None:
    # The WS layer's generic ValueError path must still catch it as bad input.
    assert issubclass(UnlistedSymbolError, ValueError)


async def test_unlisted_symbol_is_refused_and_the_table_downloads_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _count_loads(monkeypatch, _binance_table())
    for _ in range(3):
        with pytest.raises(UnlistedSymbolError):
            await resolve_symbol("binance-spot", "ZZZUSDT")
    # Three refusals, one download: a retry storm of typos never reaches the venue.
    assert calls == [("binance", False)]


async def test_unlisted_native_shaped_symbol_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _count_loads(monkeypatch, _binance_table())
    # Native spelling, but the venue does not list it.
    with pytest.raises(UnlistedSymbolError):
        await resolve_symbol("binance-spot", "NOPENOPE")


async def test_listed_native_spelling_passes_through_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    _count_loads(monkeypatch, _binance_table())
    assert await resolve_symbol("binance-spot", "BTCUSDT") == "BTCUSDT"


async def test_listed_unified_spelling_is_translated_to_the_venue_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _count_loads(monkeypatch, _binance_table())
    assert await resolve_symbol("binance-spot", "BTC/USDT") == "BTCUSDT"
    assert await resolve_symbol("binance-spot", "ETH/BTC") == "ETHBTC"
    # Both translations share the one cached table.
    assert calls == [("binance", False)]


async def test_ccxt_venue_gets_the_unified_id_for_a_native_spelling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kucoin = venues._VenueTables(
        markets={"BTC/USDT": {"id": "BTC-USDT", "symbol": "BTC/USDT"}},
        markets_by_id={"BTC-USDT": [{"symbol": "BTC/USDT"}]},
    )
    _count_loads(monkeypatch, kucoin)
    assert await resolve_symbol("kucoin", "BTC-USDT") == "BTC/USDT"


async def test_failed_table_load_fails_open_and_logs_once(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    calls = _count_loads(monkeypatch, RuntimeError("venue down"))
    with caplog.at_level(logging.WARNING, logger=venues.logger.name):
        assert await resolve_symbol("binance-spot", "ZZZUSDT") == "ZZZUSDT"
        assert await resolve_symbol("binance-spot", "ZZZUSDT") == "ZZZUSDT"
    # Fail open: the input is returned, not refused, while the table is down.
    # The failure is remembered for EMPTY_TTL_NS, so only one attempt was made,
    # and the outage was logged once.
    assert len(calls) == 1
    outages = [r for r in caplog.records if "market table unavailable" in r.getMessage()]
    assert len(outages) == 1


async def test_table_load_timeout_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(venues, "LIST_TIMEOUT_S", 0.01)

    async def slow_load(exchange: str, swap: bool) -> venues._VenueTables:
        await asyncio.sleep(5)
        raise AssertionError("the timeout should have cancelled this load")

    monkeypatch.setattr(venues, "_load_tables", slow_load)
    assert await resolve_symbol("binance-spot", "ZZZUSDT") == "ZZZUSDT"


async def test_loaded_table_is_reused_within_its_ttl_and_refreshed_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _count_loads(monkeypatch, _binance_table())
    first = await venues._venue_tables("binance", "spot", now_ns=0)
    assert first is not None
    assert await venues._venue_tables("binance", "spot", now_ns=SYMBOL_TTL_NS - 1) is first
    assert len(calls) == 1
    await venues._venue_tables("binance", "spot", now_ns=SYMBOL_TTL_NS)
    assert len(calls) == 2


async def test_failed_table_is_retried_after_the_short_negative_ttl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _count_loads(monkeypatch, RuntimeError("venue down"))
    assert await venues._venue_tables("binance", "spot", now_ns=0) is None
    assert await venues._venue_tables("binance", "spot", now_ns=EMPTY_TTL_NS - 1) is None
    assert len(calls) == 1
    assert await venues._venue_tables("binance", "spot", now_ns=EMPTY_TTL_NS) is None
    assert len(calls) == 2


async def test_default_market_type_keys_separate_tables(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _count_loads(monkeypatch, _binance_table())
    await venues._venue_tables("binance", "spot", now_ns=0)
    await venues._venue_tables("binance", "usdm", now_ns=0)
    # A bare id resolves differently under spot and swap, so each keeps its own table.
    assert calls == [("binance", False), ("binance", True)]
