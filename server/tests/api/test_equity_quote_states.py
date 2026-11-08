"""Explicit equity quote states for Yahoo errors.

An unknown ticker used to fall through the generic fallback and come back as
``reachable=False``, which read as a provider outage. An outage used to be
indistinguishable from "no data". Each now maps to its own quote state.
"""

from __future__ import annotations

import pytest

from flowmap_server.api import market_cache as market
from flowmap_server.feeds import _yahoo as yahoo


async def test_unknown_ticker_is_an_explicit_reachable_empty_quote(monkeypatch):
    async def history(symbol):
        raise yahoo.UnknownSymbolError(symbol)

    monkeypatch.setattr(yahoo, "equity_bars", history)
    quote = await market._equity_quote("zzzq")
    assert quote.symbol == "ZZZQ"
    assert quote.price is None and quote.change_pct is None
    assert quote.reachable is True  # Yahoo answered; the ticker simply does not exist
    # No price is never a fresh mark: stale, like the other no-data quote.
    assert quote.stale is True


async def test_provider_outage_is_an_explicit_unreachable_quote(monkeypatch):
    async def history(symbol):
        raise yahoo.YahooUnavailableError("chart unavailable")

    monkeypatch.setattr(yahoo, "equity_bars", history)
    quote = await market._equity_quote("aapl")
    assert quote.symbol == "AAPL"
    assert quote.price is None
    assert quote.reachable is False and quote.stale is True


async def test_unknown_ticker_is_cached_by_the_market_cache(monkeypatch):
    calls: list[str] = []

    async def history(symbol):
        calls.append(symbol)
        raise yahoo.UnknownSymbolError(symbol)

    monkeypatch.setattr(yahoo, "equity_bars", history)
    cache = market.MarketDataCache(quote_fn=market.default_quote_fn, movers_fn=_no_movers)
    first = await cache.quote("equity", "zzzq", wait_for_refresh=True)
    second = await cache.quote("equity", "zzzq", wait_for_refresh=True)
    assert first.reachable is True and second.reachable is True
    assert len(calls) == 1  # the explicit answer is stored, not retried per read


async def _no_movers(market_name, limit):
    return []


@pytest.mark.parametrize("error", [yahoo.UnknownSymbolError, yahoo.YahooUnavailableError])
async def test_quote_states_never_claim_a_price(monkeypatch, error):
    async def history(symbol):
        raise error(symbol)

    monkeypatch.setattr(yahoo, "equity_bars", history)
    assert (await market._equity_quote("aapl")).price is None
