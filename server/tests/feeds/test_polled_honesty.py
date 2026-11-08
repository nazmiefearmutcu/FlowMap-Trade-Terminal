"""Honesty of polled (ccxt) venues: dedup without ids, depth, segments, listings."""

from __future__ import annotations

import sys
from types import ModuleType

import ccxt
import pytest
from crocodile.core.schema.enums import AssetClass, Side
from crocodile.core.schema.records import Trade as CTrade

from flowmap_server.config import Config
from flowmap_server.data import venues
from flowmap_server.feeds.crypto import (
    _CCXT_BOOK_DEPTH,
    CryptoFeed,
    _BridgeSink,
)
from flowmap_server.proto.events import Trade

_VENUE_NS = 1_700_000_000_000_000_000
_LOCAL_NS = _VENUE_NS + 1


def _snapshot():
    from crocodile.core.schema.records import BookSnapshot

    return BookSnapshot(
        source="ccxt-test",
        symbol="ccxt-test:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=_VENUE_NS,
        local_ts=_LOCAL_NS,
        bids=[(100.0, 1.0)],
        asks=[(100.1, 1.0)],
        depth=1,
        sequence_id=1,
    )


def _idless_trade(*, ts: int = _VENUE_NS, price: float = 100.5, amount: float = 2.0) -> CTrade:
    return CTrade(
        source="ccxt-test",
        symbol="ccxt-test:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=ts,
        local_ts=ts + 1,
        id="",
        price=price,
        amount=amount,
        side=Side.BUY,
    )


async def test_idless_polled_window_is_not_re_emitted_on_every_poll() -> None:
    """A venue that publishes no trade id is re-read whole on each poll. The same
    print must land once, not once per poll. Each poll is one window, bracketed
    the way the poll connector brackets it."""
    out: list = []
    sink = _BridgeSink(out.append, 100, snapshot_driven=True)
    await sink.put(_snapshot())
    out.clear()
    for _ in range(3):
        sink.begin_poll()
        await sink.put(_idless_trade(ts=_VENUE_NS, price=100.5))
        await sink.put(_idless_trade(ts=_VENUE_NS + 5, price=101.0))
        sink.end_poll()
    trades = [e for e in out if isinstance(e, Trade)]
    assert [t.price for t in trades] == [100.5, 101.0]


async def test_idless_trades_that_differ_in_time_are_both_kept() -> None:
    out: list = []
    sink = _BridgeSink(out.append, 100, snapshot_driven=True)
    await sink.put(_snapshot())
    out.clear()
    await sink.put(_idless_trade(ts=_VENUE_NS))
    await sink.put(_idless_trade(ts=_VENUE_NS + 1))
    assert len([e for e in out if isinstance(e, Trade)]) == 2


@pytest.mark.parametrize("market", ["binance-usdm", "bingx", "binanceusdm"])
def test_book_top_n_capability_reports_the_depth_the_book_holds(market: str) -> None:
    exchange, segment = venues.split_market(market)
    feed = CryptoFeed(exchange=exchange, symbol="BTCUSDT", market=segment, cfg=Config())
    # Native books hold the configured cap; the ccxt path is requested at 100 levels.
    expected = Config().book_top_n if feed.native else _CCXT_BOOK_DEPTH
    assert feed.capability["book_top_n"] == expected
    assert (expected == 100) is (not feed.native)


class _FakeCcxt:
    """Records the options a ccxt client was built with and serves fixed markets."""

    created: list[dict] = []
    markets: dict = {}
    precisionMode = ccxt.TICK_SIZE

    def __init__(self, config: dict) -> None:
        type(self).created.append(config)

    async def load_markets(self) -> dict:
        return type(self).markets

    async def close(self) -> None:
        return None


def _install_fake_ccxt(monkeypatch, markets: dict) -> None:
    fake_async = ModuleType("ccxt.async_support")

    class _Venue(_FakeCcxt):
        pass

    _Venue.created = []
    _Venue.markets = markets
    fake_async.binance = _Venue  # type: ignore[attr-defined]
    fake_async.kraken = _Venue  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "ccxt.async_support", fake_async)
    # `import ccxt.async_support as x` reads the package attribute first, so patch that too.
    monkeypatch.setattr(ccxt, "async_support", fake_async, raising=False)
    monkeypatch.setattr(venues, "ccxt_knows", lambda exchange: True)
    venues._price_ticks.clear()
    venues._cache.clear()
    return _Venue


async def test_ccxt_listing_for_a_segment_asks_ccxt_for_that_market_type(monkeypatch) -> None:
    venue = _install_fake_ccxt(monkeypatch, {
        "BTC/USDT:USDT": {"id": "BTCUSDT", "active": True, "precision": {"price": 0.1}},
    })
    symbols = await venues._ccxt_symbols("binance-usdm", "binance", "usdm")
    assert symbols == ["BTC/USDT:USDT"]
    assert venue.created[-1]["options"] == {"defaultType": "swap"}


async def test_ccxt_usdm_listing_excludes_coin_margined_perpetuals(monkeypatch) -> None:
    """defaultType swap loads both settlement families; a usdm listing must not carry
    the coin-margined contracts, and a coinm listing must not carry the USDT ones."""
    markets = {
        "BTC/USDT:USDT": {"id": "BTCUSDT", "active": True, "linear": True, "inverse": False},
        "BTC/USD:BTC": {"id": "BTCUSD_PERP", "active": True, "linear": False, "inverse": True},
        "ETH/USDT:USDT": {"id": "ETHUSDT", "active": True},  # flag unknown: kept
    }
    _install_fake_ccxt(monkeypatch, markets)
    assert await venues._ccxt_symbols("binance-usdm", "binance", "usdm") == [
        "BTC/USDT:USDT", "ETH/USDT:USDT",
    ]
    # The ETH market carries no flag, so it is kept by either family (only an explicit False drops it).
    assert await venues._ccxt_symbols("binance-coinm", "binance", "coinm") == [
        "BTC/USD:BTC", "ETH/USDT:USDT",
    ]


async def test_ccxt_listing_without_a_segment_keeps_ccxt_defaults(monkeypatch) -> None:
    venue = _install_fake_ccxt(monkeypatch, {"BTC/USDT": {"active": True}})
    assert await venues._ccxt_symbols("kraken", "kraken") == ["BTC/USDT"]
    assert "options" not in venue.created[-1]


async def test_ccxt_listing_refuses_an_unmapped_segment_instead_of_listing_spot(monkeypatch) -> None:
    venue = _install_fake_ccxt(monkeypatch, {"BTC/USDT": {"active": True}})
    assert await venues._ccxt_symbols("binance-option", "binance", "option") == []
    assert venue.created == []


async def test_ccxt_ticks_are_stored_under_the_full_market_key(monkeypatch) -> None:
    _install_fake_ccxt(monkeypatch, {
        "BTC/USDT:USDT": {"id": "BTCUSDT", "active": True, "precision": {"price": 0.1}},
    })
    await venues._ccxt_symbols("binance-usdm", "binance", "usdm")
    assert venues._price_ticks["binance-usdm"]["BTC/USDT:USDT"] == pytest.approx(0.1)
    assert "binance" not in venues._price_ticks


async def test_one_null_precision_does_not_blank_the_venue_listing(monkeypatch) -> None:
    _install_fake_ccxt(monkeypatch, {
        "BAD/USDT": {"active": True, "precision": None},
        "GOOD/USDT": {"active": True, "precision": {"price": 0.01}},
    })
    assert await venues._ccxt_symbols("kraken", "kraken") == ["BAD/USDT", "GOOD/USDT"]


async def test_ccxt_market_with_unknown_active_status_is_still_listed(monkeypatch) -> None:
    _install_fake_ccxt(monkeypatch, {
        "UNKNOWN/USDT": {"active": None},
        "DELISTED/USDT": {"active": False},
    })
    assert await venues._ccxt_symbols("kraken", "kraken") == ["UNKNOWN/USDT"]


def test_trade_key_for_idless_venue_is_content_not_empty() -> None:
    """Inside a poll window an id-less print is keyed by its content. A second
    identical fill in the same window is a distinct print, so it gets a new key.
    Outside a window nothing is re-read, so there is no key to deduplicate on."""
    sink = _BridgeSink(lambda _ev: None, 100, snapshot_driven=True)
    sink.begin_poll()
    first = sink._trade_key(_idless_trade())
    assert first is not None
    assert first != sink._trade_key(_idless_trade())
    assert first != sink._trade_key(_idless_trade(price=101.0))
    assert first != sink._trade_key(_idless_trade(ts=_VENUE_NS + 1))
    sink.end_poll()
    assert sink._trade_key(_idless_trade()) is None
