"""World-market plumbing: routing, venues, universe, quote and movers.

Every world listing is answered by Crocodile's live layer. These tests replace that layer with a
fake that answers from hand-made snapshots (``live_feed`` is monkeypatched at the feed module, the
one place the routes and the caches look it up), so nothing touches the network. The venues
symbol cache is cleared around every test, and each test builds its own quote cache.
"""

from __future__ import annotations

import time

import httpx
import pytest
from crocodile.equity.universal.live.model import LiveLevel, LiveListing, LiveSnapshot

from flowmap_server.api.app import create_app
from flowmap_server.api.market_cache import MarketDataCache, default_movers_fn, default_quote_fn
from flowmap_server.config import Config
from flowmap_server.data import venues
from flowmap_server.feeds import global_equity
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.equity_markets import is_equity_market
from flowmap_server.feeds.global_equity import GlobalEquityFeed
from flowmap_server.feeds.router import build_feed
from flowmap_server.proto import events


class FakeLive:
    """Stands in for crocodile's LiveFeed: answers from the snapshots a test gives it."""

    def __init__(self) -> None:
        self.rows: list[LiveSnapshot] = []
        self.polls: dict[str, LiveSnapshot] = {}
        self.poll_error: Exception | None = None

    async def poll(self, listing: LiveListing, max_tier: object = None) -> LiveSnapshot | None:
        if self.poll_error is not None:
            raise self.poll_error
        return self.polls.get(listing.local_symbol)

    async def board(self, mic: str, limit: int | None = None) -> list[LiveSnapshot]:
        return list(self.rows)

    async def identify(self, listing: LiveListing) -> LiveListing:
        return listing

    async def minute_bars(self, listing: LiveListing) -> list:
        return []


@pytest.fixture(autouse=True)
def _fresh_venue_symbols():
    venues._cache.clear()
    venues._locks.clear()
    yield
    venues._cache.clear()
    venues._locks.clear()


@pytest.fixture
def live(monkeypatch: pytest.MonkeyPatch) -> FakeLive:
    fake = FakeLive()
    monkeypatch.setattr(global_equity, "live_feed", lambda: fake)
    return fake


def _snap(
    mic: str,
    symbol: str,
    *,
    last: float | None,
    prev_close: float | None = None,
    delay_s: int | None = None,
    bids: tuple[tuple[float, float], ...] = (),
    asks: tuple[tuple[float, float], ...] = (),
) -> LiveSnapshot:
    """One snapshot captured now, so it is fresh by the cache's own staleness rule."""
    now = time.time_ns()
    return LiveSnapshot(
        source="fake",
        listing=LiveListing(mic=mic, local_symbol=symbol),
        symbol_raw=symbol,
        captured_ns=now,
        source_ts_ns=now,
        last=last,
        prev_close=prev_close,
        delay_s=delay_s,
        bids=tuple(LiveLevel(price=p, size=s) for p, s in bids),
        asks=tuple(LiveLevel(price=p, size=s) for p, s in asks),
    )


def _client(cache: MarketDataCache | None = None) -> httpx.AsyncClient:
    app = create_app(Config(), market_cache=cache)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720"
    )


def _quotes() -> MarketDataCache:
    """The production quote and movers seams, reached through the fake live feed."""
    return MarketDataCache(quote_fn=default_quote_fn, movers_fn=default_movers_fn)


# --- routing -------------------------------------------------------------------


def test_router_sends_a_world_market_to_a_global_equity_feed() -> None:
    feed = build_feed(
        events.Subscribe(market="world-xist", symbol="THYAO", mode="live"),
        Config(),
        realtime_sim=False,
    )
    assert isinstance(feed, GlobalEquityFeed)
    assert feed.mic == "XIST"
    assert feed.symbol == "THYAO"


def test_router_keeps_a_mixed_case_local_symbol() -> None:
    feed = build_feed(
        events.Subscribe(market="world-bcxe", symbol="RRl", mode="live"),
        Config(),
        realtime_sim=False,
    )
    assert isinstance(feed, GlobalEquityFeed)
    assert feed.symbol == "RRl"


def test_router_still_sends_equity_to_the_us_feed() -> None:
    feed = build_feed(
        events.Subscribe(market="equity", symbol="AAPL", mode="live"),
        Config(),
        realtime_sim=False,
    )
    assert isinstance(feed, EquityFeed)
    assert not isinstance(feed, GlobalEquityFeed)


def test_router_refuses_an_unknown_world_mic() -> None:
    with pytest.raises(NotImplementedError):
        build_feed(
            events.Subscribe(market="world-zzzz", symbol="X", mode="live"),
            Config(),
            realtime_sim=False,
        )


@pytest.mark.parametrize("market", ["equity", "world-xist", "WORLD-XIST"])
def test_equity_market_test_accepts_us_and_world_markets(market: str) -> None:
    assert is_equity_market(market) is True


@pytest.mark.parametrize("market", ["binance-spot", "sim"])
def test_equity_market_test_refuses_crypto_and_sim(market: str) -> None:
    assert is_equity_market(market) is False


# --- venues --------------------------------------------------------------------


async def test_venues_lists_the_world_venue_with_its_exchanges() -> None:
    async with _client() as c:
        body = (await c.get("/api/venues")).json()
    world = next(v for v in body["venues"] if v["id"] == "world")
    assert world["assetClass"] == "equity"
    assert world["native"] is True
    assert "xist" in world["segments"]
    assert "xtai" in world["segments"]
    # A sanctioned market stays closed to this build and is never offered.
    assert "misx" not in world["segments"]
    label = body["labels"]["world-xist"]
    assert isinstance(label, str)
    assert "Istanbul" in label
    assert "(TR)" in label


# --- universe ------------------------------------------------------------------


async def test_universe_of_a_world_market_is_its_live_board(live: FakeLive) -> None:
    live.rows = [
        _snap("XIST", "THYAO", last=300.0),
        _snap("XIST", "ASELS", last=50.0),
        _snap("XIST", "garan", last=1.0),
    ]
    async with _client() as c:
        rows = (await c.get("/api/universe", params={"market": "world-xist"})).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["THYAO", "ASELS", "garan"]
    assert all(s["market"] == "world-xist" for s in rows)
    assert "depth" in rows[0]["capability"]


async def test_universe_of_a_world_market_honours_query_and_limit(live: FakeLive) -> None:
    live.rows = [
        _snap("XIST", "THYAO", last=300.0),
        _snap("XIST", "ASELS", last=50.0),
        _snap("XIST", "garan", last=1.0),
    ]
    async with _client() as c:
        by_limit = (
            await c.get("/api/universe", params={"market": "world-xist", "limit": 2})
        ).json()["symbols"]
        by_query = (
            await c.get("/api/universe", params={"market": "world-xist", "q": "AS"})
        ).json()["symbols"]
    assert [s["symbol"] for s in by_limit] == ["THYAO", "ASELS"]
    assert [s["symbol"] for s in by_query] == ["ASELS"]


async def test_universe_of_an_empty_world_board_is_empty_not_the_us_shortlist(
    live: FakeLive,
) -> None:
    live.rows = []
    async with _client() as c:
        r = await c.get("/api/universe", params={"market": "world-xist"})
    assert r.status_code == 200
    assert r.json() == {"symbols": []}


# --- quote ---------------------------------------------------------------------


async def test_quote_of_a_world_listing_is_last_against_previous_close(live: FakeLive) -> None:
    live.polls["THYAO"] = _snap("XIST", "THYAO", last=110.0, prev_close=100.0)
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "world-xist", "symbol": "THYAO"})
        ).json()
    assert q["price"] == 110.0
    assert q["changePct"] == pytest.approx(10.0)
    assert q["stale"] is False
    assert q["reachable"] is True


async def test_quote_of_a_delayed_listing_is_stale(live: FakeLive) -> None:
    live.polls["THYAO"] = _snap("XIST", "THYAO", last=110.0, prev_close=100.0, delay_s=900)
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "world-xist", "symbol": "THYAO"})
        ).json()
    assert q["stale"] is True
    assert q["price"] == 110.0


async def test_quote_is_unreachable_when_the_live_poll_raises(live: FakeLive) -> None:
    live.poll_error = RuntimeError("publisher down")
    async with _client(_quotes()) as c:
        q = (
            await c.get("/api/quote", params={"market": "world-xist", "symbol": "THYAO"})
        ).json()
    assert q["reachable"] is False
    assert q["stale"] is True
    assert q["price"] is None


async def test_quote_keeps_the_case_of_a_mixed_case_local_symbol(live: FakeLive) -> None:
    # The fake answers only the exact spelling: an upper-cased lookup would find nothing.
    live.polls["RRl"] = _snap("BCXE", "RRl", last=5.0, prev_close=4.0)
    async with _client(_quotes()) as c:
        q = (await c.get("/api/quote", params={"market": "world-bcxe", "symbol": "RRl"})).json()
    assert q["symbol"] == "RRl"
    assert q["price"] == 5.0
    assert q["changePct"] == pytest.approx(25.0)


# --- movers --------------------------------------------------------------------


async def test_movers_of_a_world_market_rank_by_absolute_change(live: FakeLive) -> None:
    live.rows = [
        _snap("XIST", "AAA", last=110.0, prev_close=100.0),  # +10%
        _snap("XIST", "BBB", last=95.0, prev_close=100.0),  # -5%
        _snap("XIST", "CCC", last=101.0, prev_close=100.0),  # +1%
        _snap("XIST", "DDD", last=50.0),  # no previous close: cannot be ranked
    ]
    async with _client(_quotes()) as c:
        ranked = (await c.get("/api/movers", params={"market": "world-xist"})).json()["movers"]
        top = (
            await c.get("/api/movers", params={"market": "world-xist", "limit": 2})
        ).json()["movers"]
    assert [m["symbol"] for m in ranked] == ["AAA", "BBB", "CCC"]
    assert [m["symbol"] for m in top] == ["AAA", "BBB"]
    assert all(m["market"] == "world-xist" for m in ranked)


async def test_movers_refuses_an_unknown_world_market_with_the_existing_error() -> None:
    async with _client(_quotes()) as c:
        r = await c.get("/api/movers", params={"market": "world-zzzz"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "unknown_market"
