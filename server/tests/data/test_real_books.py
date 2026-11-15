"""``data.real_books``: where a synthetic instrument's underlying has a real public book."""

from __future__ import annotations

import pytest

from flowmap_server.data.real_books import REAL_BOOKS, real_book
from flowmap_server.feeds.asset_markets import is_asset_market
from flowmap_server.feeds.crypto import is_crypto_market


def test_a_currency_pair_points_at_the_venue_that_lists_it_on_spot() -> None:
    assert real_book("forex", "EURUSD") == {"market": "kraken", "symbol": "EUR/USD", "kind": "spot"}
    assert real_book("forex", "GBPUSD") == {"market": "kraken", "symbol": "GBP/USD", "kind": "spot"}


def test_gold_points_at_the_perpetual_from_both_of_its_markets() -> None:
    expected = {"market": "binance-usdm", "symbol": "XAUUSDT", "kind": "perpetual"}
    assert real_book("futures-comex", "GC1!") == expected
    assert real_book("forex", "XAUUSD") == expected


def test_a_us_share_is_found_whatever_the_case_of_its_symbol() -> None:
    assert real_book("equity", "aapl") == real_book("equity", "AAPL")
    assert real_book("equity", "AAPL") == {
        "market": "binance-usdm",
        "symbol": "AAPLUSDT",
        "kind": "perpetual",
    }


@pytest.mark.parametrize(
    ("market", "symbol"),
    [
        # A pair whose only public book was stale when it was read is not offered.
        ("forex", "USDJPY"),
        ("forex", "USDTRY"),
        # The index itself: the venues list perpetuals on the ETF, a different instrument.
        ("indices", "SP:SPX"),
        ("futures-cme_mini", "ES1!"),
        ("equity", "IBM"),
        # The real book's own market never points anywhere.
        ("binance-usdm", "XAUUSDT"),
        ("kraken", "EUR/USD"),
        ("sim", "SIM-DEMO"),
    ],
)
def test_an_instrument_without_a_verified_book_points_nowhere(market: str, symbol: str) -> None:
    assert real_book(market, symbol) is None


def test_every_row_goes_from_a_synthetic_market_to_a_crypto_venue_this_build_streams() -> None:
    for (market, _symbol), (target, target_symbol, kind) in REAL_BOOKS.items():
        assert market == "equity" or is_asset_market(market), market
        assert is_crypto_market(target), target
        assert target_symbol
        assert kind in ("spot", "perpetual")
