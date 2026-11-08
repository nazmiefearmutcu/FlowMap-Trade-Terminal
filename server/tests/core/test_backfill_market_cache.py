"""ccxt market tables are downloaded once per venue and market type, not per miss (api-v1)."""

import asyncio
import threading

import ccxt.async_support as ccxt_async
import pytest

from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector
from flowmap_server.core import backfill
from flowmap_server.data import venues

NOW_NS = 1_700_000_000 * 10**9


class _FakeExchange:
    loads = 0

    def __init__(self, options):
        self.options = options
        self.has = {"fetchOHLCV": True}
        self.markets = {}
        self.markets_by_id = {}

    async def load_markets(self):
        type(self).loads += 1
        return {"BTC/USDT": {"symbol": "BTC/USDT", "id": "BTCUSDT"}}

    def set_markets(self, markets, currencies=None):
        self.markets = markets
        self.markets_by_id = {"BTCUSDT": next(iter(markets.values()))}

    async def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None):
        return [[NOW_NS // 10**6 - 60_000 * (2 - i), 1.0, 2.0, 0.5, 1.5, 3.0] for i in range(2)]

    async def close(self):
        return None


@pytest.fixture
def fake_venue(monkeypatch):
    _FakeExchange.loads = 0
    monkeypatch.setattr(ccxt_async, "fakevenue", _FakeExchange, raising=False)
    monkeypatch.setattr(venues, "ccxt_knows", lambda name: name == "fakevenue")
    monkeypatch.setattr(
        CCXTConnector, "_resolve_symbol", staticmethod(lambda sym, markets, by_id: "BTC/USDT")
    )
    backfill._MARKETS_CACHE.clear()
    yield
    backfill._MARKETS_CACHE.clear()


def _fetch() -> list:
    return asyncio.run(backfill._ccxt_candles_owned(
        "fakevenue", "BTCUSDT", "spot", interval="1m", max_bars=2,
        now_ns=NOW_NS, cancelled=threading.Event(),
    ))


def test_second_miss_reuses_the_cached_market_table(fake_venue):
    first = _fetch()
    second = _fetch()
    assert len(first) == len(second) == 2
    assert _FakeExchange.loads == 1, "the market table was downloaded again on a miss"


def test_market_table_is_per_venue_and_market_type(fake_venue):
    _fetch()
    asyncio.run(backfill._ccxt_candles_owned(
        "fakevenue", "BTCUSDT", "usdm", interval="1m", max_bars=2,
        now_ns=NOW_NS, cancelled=threading.Event(),
    ))
    assert _FakeExchange.loads == 2  # swap and spot tables are different tables


def test_expired_table_is_downloaded_again(fake_venue, monkeypatch):
    _fetch()
    monkeypatch.setattr(backfill, "_MARKETS_TTL_S", 0.0)
    _fetch()
    assert _FakeExchange.loads == 2
