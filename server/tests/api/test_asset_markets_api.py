"""Asset markets (futures, forex, indices, bonds) through the discovery and price routes. NO network.

Crocodile's asset layer (:class:`AssetFeed`) is replaced by a fake that answers ``board``,
``quotes`` and nothing else, from hand-made scanner rows. The fake is installed at the one place
every asset path looks it up, ``asset_markets.asset_feed``, so the real routes, the real
``default_quote_fn`` / ``default_movers_fn`` and the real venue enumerator run against it.

Expected values are computed by hand from the fake rows, never by calling the code under test.
"""

from __future__ import annotations

import time

import httpx
import pytest
from crocodile.equity.universal.live.assets import AssetKind, AssetQuote

from flowmap_server.api import market_cache
from flowmap_server.api.app import create_app
from flowmap_server.api.market_cache import MarketDataCache, default_movers_fn, default_quote_fn
from flowmap_server.api.ws import normalize_symbol
from flowmap_server.config import Config
from flowmap_server.data import venues
from flowmap_server.feeds import asset_markets


class FakeAssetFeed:
    """Stands in for Crocodile's AssetFeed: boards and quotes from the rows a test gives it."""

    def __init__(self) -> None:
        self.rows: list[AssetQuote] = []
        self.quote_error: Exception | None = None
        self.board_error: Exception | None = None

    async def board(self, kind: AssetKind, venue: str | None = None, *, limit: int = 200):
        if self.board_error is not None:
            raise self.board_error
        return [row for row in self.rows if row.kind is kind and (venue is None or row.venue == venue)]

    async def quotes(self, tickers):
        if self.quote_error is not None:
            raise self.quote_error
        wanted = set(tickers)
        return [row for row in self.rows if row.ticker in wanted]


def _row(
    kind: AssetKind,
    venue: str,
    symbol: str,
    *,
    last: float | None = None,
    prev_close: float | None = None,
) -> AssetQuote:
    ticker = symbol if kind is AssetKind.INDEX else f"{venue}:{symbol}"
    return AssetQuote(
        kind=kind,
        ticker=ticker,
        venue=venue,
        symbol=symbol,
        # Fresh: the quote's age must stay under the fifteen-minute staleness bound.
        captured_ns=time.time_ns(),
        last=last,
        prev_close=prev_close,
    )


@pytest.fixture(autouse=True)
def _fresh_venue_symbols():
    venues._cache.clear()
    venues._locks.clear()
    yield
    venues._cache.clear()
    venues._locks.clear()


@pytest.fixture
def assets(monkeypatch: pytest.MonkeyPatch) -> FakeAssetFeed:
    fake = FakeAssetFeed()
    monkeypatch.setattr(asset_markets, "asset_feed", lambda: fake)
    return fake


def _client(cache: MarketDataCache | None = None) -> httpx.AsyncClient:
    app = create_app(Config(), market_cache=cache)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720"
    )


def _quotes() -> MarketDataCache:
    """The production quote and movers seams, reached through the fake asset feed."""
    return MarketDataCache(quote_fn=default_quote_fn, movers_fn=default_movers_fn)


def _futures_rows() -> list[AssetQuote]:
    return [
        _row(AssetKind.FUTURE, "CME_MINI", "ES1!", last=5300.0, prev_close=5200.0),
        _row(AssetKind.FUTURE, "CME_MINI", "NQ1!", last=18000.0, prev_close=18100.0),
        _row(AssetKind.FUTURE, "CME_MINI", "Esm2026", last=5310.0, prev_close=5300.0),
    ]


# --- GET /api/venues -----------------------------------------------------------


async def test_venues_lists_the_four_asset_markets_at_the_synth_tier() -> None:
    async with _client() as c:
        body = (await c.get("/api/venues")).json()
    by_id = {v["id"]: v for v in body["venues"]}
    for venue_id in ("futures", "forex", "indices", "bonds"):
        assert by_id[venue_id]["depth"] == "SYNTH", venue_id
        assert by_id[venue_id]["assetClass"] == "equity", venue_id
    assert "cme_mini" in by_id["futures"]["segments"]
    assert by_id["forex"]["segments"] == []


async def test_venues_labels_name_a_futures_market_and_forex() -> None:
    async with _client() as c:
        labels = (await c.get("/api/venues")).json()["labels"]
    assert labels["futures-cme_mini"].startswith("CME_MINI futures (")
    assert labels["forex"] == "Currency pairs (composite quotes)"


# --- GET /api/universe -----------------------------------------------------------


async def test_universe_of_a_futures_market_is_its_board(assets: FakeAssetFeed) -> None:
    assets.rows = _futures_rows()
    async with _client() as c:
        rows = (
            await c.get("/api/universe", params={"market": "futures-cme_mini"})
        ).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["ES1!", "NQ1!", "Esm2026"]
    assert all(s["market"] == "futures-cme_mini" for s in rows)
    capability = rows[0]["capability"]
    assert capability["depth"] == "SYNTH"
    assert capability["instrument_kind"] == "future"
    assert capability["profile_basis"] == "volume"


async def test_universe_of_a_futures_market_filters_by_query_case_insensitively(
    assets: FakeAssetFeed,
) -> None:
    assets.rows = _futures_rows()
    async with _client() as c:
        rows = (
            await c.get("/api/universe", params={"market": "futures-cme_mini", "q": "ES"})
        ).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["ES1!", "Esm2026"]


async def test_universe_of_forex_states_a_time_profile(assets: FakeAssetFeed) -> None:
    assets.rows = [
        _row(AssetKind.FOREX, "FX_IDC", "EURUSD", last=1.1, prev_close=1.0),
        _row(AssetKind.FOREX, "FX_IDC", "USDJPY", last=150.0, prev_close=151.0),
    ]
    async with _client() as c:
        rows = (await c.get("/api/universe", params={"market": "forex"})).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["EURUSD", "USDJPY"]
    assert rows[0]["capability"]["profile_basis"] == "time"


async def test_universe_of_an_unreachable_board_is_empty_not_an_error(
    assets: FakeAssetFeed,
) -> None:
    assets.board_error = RuntimeError("scanner down")
    async with _client() as c:
        r = await c.get("/api/universe", params={"market": "futures-cme_mini"})
    assert r.status_code == 200
    assert r.json() == {"symbols": []}


# --- GET /api/quote --------------------------------------------------------------


async def test_quote_of_a_future_is_last_against_previous_close(assets: FakeAssetFeed) -> None:
    assets.rows = _futures_rows()
    async with _client(_quotes()) as c:
        r = await c.get(
            "/api/quote", params={"market": "futures-cme_mini", "symbol": "ES1!"}
        )
    assert r.status_code == 200
    q = r.json()
    assert q["price"] == 5300.0
    # (5300 - 5200) / 5200 * 100
    assert q["changePct"] == pytest.approx(100.0 / 5200.0 * 100.0)
    assert q["stale"] is False
    assert q["reachable"] is True
    assert q["symbol"] == "ES1!"


async def test_quote_keeps_the_case_of_a_mixed_case_future_symbol(assets: FakeAssetFeed) -> None:
    # The fake answers only the exact spelling: an upper-cased lookup would find no row.
    assets.rows = _futures_rows()
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "futures-cme_mini", "symbol": "Esm2026"})
        ).json()
    assert q["symbol"] == "Esm2026"
    assert q["price"] == 5310.0
    assert q["changePct"] == pytest.approx(10.0 / 5300.0 * 100.0)


async def test_quote_of_an_unknown_future_is_reached_but_has_no_price(
    assets: FakeAssetFeed,
) -> None:
    assets.rows = _futures_rows()
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "futures-cme_mini", "symbol": "ZZZ1!"})
        ).json()
    assert q["reachable"] is True
    assert q["stale"] is True
    assert q["price"] is None


async def test_quote_is_unreachable_when_the_scanner_raises(assets: FakeAssetFeed) -> None:
    assets.quote_error = RuntimeError("scanner down")
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "futures-cme_mini", "symbol": "ES1!"})
        ).json()
    assert q["reachable"] is False
    assert q["stale"] is True
    assert q["price"] is None


async def test_quote_of_an_index_takes_its_full_ticker(assets: FakeAssetFeed) -> None:
    assets.rows = [_row(AssetKind.INDEX, "SP", "SP:SPX", last=5000.0, prev_close=4900.0)]
    async with _client(_quotes()) as c:
        r = await c.get("/api/quote", params={"market": "indices", "symbol": "SP:SPX"})
    assert r.status_code == 200
    q = r.json()
    assert q["price"] == 5000.0
    # (5000 - 4900) / 4900 * 100
    assert q["changePct"] == pytest.approx(100.0 / 4900.0 * 100.0)
    assert q["symbol"] == "SP:SPX"


async def test_quote_refuses_a_symbol_with_a_disallowed_character(assets: FakeAssetFeed) -> None:
    async with _client(_quotes()) as c:
        r = await c.get("/api/quote", params={"market": "futures-cme_mini", "symbol": "ES1!;"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_symbol"


async def test_quote_refuses_an_unknown_futures_venue(assets: FakeAssetFeed) -> None:
    async with _client(_quotes()) as c:
        r = await c.get("/api/quote", params={"market": "futures-nope", "symbol": "ES1!"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "unknown_market"


# --- GET /api/movers -------------------------------------------------------------


async def test_movers_of_forex_rank_by_absolute_change_and_skip_rows_without_a_close(
    assets: FakeAssetFeed,
) -> None:
    assets.rows = [
        _row(AssetKind.FOREX, "FX_IDC", "EURUSD", last=1.10, prev_close=1.00),  # +10%
        _row(AssetKind.FOREX, "FX_IDC", "GBPUSD", last=1.25, prev_close=1.20),  # +4.1667%
        _row(AssetKind.FOREX, "FX_IDC", "USDJPY", last=150.0, prev_close=151.0),  # -0.6623%
        _row(AssetKind.FOREX, "FX_IDC", "USDCAD", last=1.36, prev_close=1.35),  # +0.7407%
        _row(AssetKind.FOREX, "FX_IDC", "AUDUSD", last=0.66),  # no previous close
    ]
    async with _client(_quotes()) as c:
        r = await c.get("/api/movers", params={"market": "forex", "limit": 3})
    assert r.status_code == 200
    movers = r.json()["movers"]
    assert [m["symbol"] for m in movers] == ["EURUSD", "GBPUSD", "USDCAD"]
    assert all(m["market"] == "forex" for m in movers)


# --- symbol and cache-key helpers --------------------------------------------------


@pytest.mark.parametrize("symbol", ["ES1!", "FDAX1!", "SP:SPX"])
def test_normalize_symbol_accepts_futures_and_index_tickers(symbol: str) -> None:
    assert normalize_symbol(symbol) == symbol


@pytest.mark.parametrize("symbol", ["!ES", "ES 1", "", "a" * 65])
def test_normalize_symbol_rejects_a_leading_bang_a_space_an_empty_or_an_overlong_symbol(
    symbol: str,
) -> None:
    assert normalize_symbol(symbol) is None


def test_normalize_symbol_accepts_a_64_character_symbol() -> None:
    assert normalize_symbol("a" * 64) == "a" * 64


@pytest.mark.parametrize("market", ["forex", "futures-eurex", "world-xist"])
def test_cache_symbol_keeps_the_case_of_asset_and_world_markets(market: str) -> None:
    assert market_cache._cache_symbol(market, "RRl") == "RRl"


@pytest.mark.parametrize("market", ["equity", "binance"])
def test_cache_symbol_upper_cases_us_and_crypto_markets(market: str) -> None:
    assert market_cache._cache_symbol(market, "rrl") == "RRL"
