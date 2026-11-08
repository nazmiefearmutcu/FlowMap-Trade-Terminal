"""Discovery input validation and quote-cache hardening.

Every test injects canned provider seams: nothing here touches the network.
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server.api import market_cache as mc
from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.api.market_cache import MarketDataCache, QuoteData


def _quote(market: str, symbol: str, change: float = 1.0) -> QuoteData:
    return QuoteData(market=market, symbol=symbol, price=10.0, change_pct=change,
                     spark=[9.0, 10.0], as_of_ns=1, stale=False, reachable=True)


def _app(tmp_path, cache: MarketDataCache):
    return create_app(
        Config(data_dir=str(tmp_path / "rec"), recording_enabled=False),
        market_cache=cache,
    )


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8720")


async def _canned_quote(market: str, symbol: str) -> QuoteData:
    return _quote(market, symbol)


async def _canned_movers(market: str, limit: int) -> list[QuoteData]:
    return [_quote(market, "AAA")][:limit]


# --- discovery validation -----------------------------------------------------


async def test_movers_refuses_a_market_it_does_not_rank(tmp_path):
    cache = MarketDataCache(quote_fn=_canned_quote, movers_fn=_canned_movers)
    async with _client(_app(tmp_path, cache)) as client:
        refused = await client.get("/api/movers", params={"market": "kraken"})
        served = await client.get("/api/movers", params={"market": "crypto"})
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "unknown_market"
    assert served.status_code == 200


async def test_quote_refuses_unknown_market_and_malformed_symbol(tmp_path):
    cache = MarketDataCache(quote_fn=_canned_quote, movers_fn=_canned_movers)
    async with _client(_app(tmp_path, cache)) as client:
        bad_market = await client.get("/api/quote", params={"market": "foo", "symbol": "BTC"})
        too_long = await client.get("/api/quote", params={"market": "crypto", "symbol": "A" * 65})
        spaced = await client.get("/api/quote", params={"market": "crypto", "symbol": "BTC USDT"})
        good_venue = await client.get(
            "/api/quote", params={"market": "binance-spot", "symbol": "BTC/USDT"}
        )
        good_equity = await client.get("/api/quote", params={"market": "equity", "symbol": "BRK.B"})
    assert bad_market.status_code == 422
    assert too_long.status_code == 422
    assert spaced.status_code == 422
    assert good_venue.status_code == 200
    assert good_equity.status_code == 200


async def test_default_movers_seam_refuses_an_unknown_pool():
    with pytest.raises(ValueError):
        await mc.default_movers_fn("kraken", 5, quote_fn=_canned_quote)


async def test_default_movers_seam_ranks_copies_not_cached_objects():
    originals: list[QuoteData] = []

    async def fetch(market: str, symbol: str) -> QuoteData:
        # The seam's own label is "binance-spot"; the cache-owned object keeps
        # the label it was fetched under until a copy is relabelled.
        quote = QuoteData(market="cache-owned", symbol=symbol, price=10.0,
                          change_pct=float(len(originals) + 1), as_of_ns=1)
        originals.append(quote)
        return quote

    movers = await mc.default_movers_fn("crypto", 3, quote_fn=fetch)
    assert movers and all(m.market == "binance-spot" for m in movers)
    assert originals and all(q.market == "cache-owned" for q in originals)


# --- quote cache: negative caching, recency, preview generation ---------------


async def test_failed_first_fetch_is_not_retried_within_the_negative_ttl():
    now = [0]
    calls = []

    async def failing(market: str, symbol: str) -> QuoteData:
        calls.append(symbol)
        raise RuntimeError("provider down")

    cache = MarketDataCache(quote_fn=failing, movers_fn=_canned_movers, clock=lambda: now[0])
    first = await cache.quote("crypto", "DEAD")
    second = await cache.quote("crypto", "DEAD")
    assert len(calls) == 1
    assert first.reachable is False and second.reachable is False and second.price is None
    now[0] = mc.NEGATIVE_TTL_NS + 1
    await cache.quote("crypto", "DEAD")
    assert len(calls) == 2  # retried once the negative window has passed


async def test_eviction_drops_the_least_recently_stored_symbol_not_the_hot_one():
    now = [0]

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol)

    cache = MarketDataCache(
        quote_fn=quote_fn, movers_fn=_canned_movers, clock=lambda: now[0],
        ttl_ns=10, max_entries=2,
    )
    await cache.quote("crypto", "A")
    await cache.quote("crypto", "B")
    now[0] = 100  # every entry is stale: the next read refetches and stores
    await cache.quote("crypto", "A")  # A is refreshed: now the most recently stored
    await cache.quote("crypto", "C")  # over the cap: B, not A, must go
    keys = set(cache._quotes)
    assert ("crypto", "A") in keys and ("crypto", "C") in keys
    assert ("crypto", "B") not in keys


async def test_eviction_bumps_the_preview_generation_so_clients_reset():
    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol)

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=_canned_movers, max_entries=2)
    await cache.quote("crypto", "A")
    await cache.quote("crypto", "B")
    before = cache.preview_snapshot(after=0)["generation"]
    # An incremental client that already holds A and B asks for newer deltas.
    revision = cache.preview_snapshot(after=0)["revision"]
    await cache.quote("crypto", "C")  # evicts A: a delta could never say so
    after = cache.preview_snapshot(after=revision, generation=before)
    assert after["generation"] != before
    assert {q["symbol"] for q in after["quotes"]} >= {"B", "C"}
