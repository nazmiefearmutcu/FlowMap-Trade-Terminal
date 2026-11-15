"""Instruments that have no public order book of their own, and where a real one is.

A currency pair, a commodity future and a US share on the keyless tier are drawn as a ``SYNTH``
profile, because no free source publishes the resting orders of their own market. For some of
them another venue lists an instrument on the same underlying whose order book IS public and
free, and this build already streams that venue. The table names those pairs, so the chart of
the synthetic instrument can point at the real book.

It is that venue's own instrument, never the exchange's book: Kraken's EUR/USD is Kraken's
spot market, and Binance's ``XAUUSDT`` is a perpetual contract that tracks gold. The client
says so where it shows the link.

Every row was read on 2026-11-12 with plain keyless requests: fifty levels a side answered,
and the 24 hour turnover is what the venue stated then. A venue whose book was listed but
empty or stale is not here (Kraken's USD/JPY: a 480 pip spread and resting orders three years
old). The S&P 500 and the Nasdaq 100 are absent on purpose: the venues this build streams list
perpetuals on the ETFs, which are a tenth of the index and a different instrument.
"""

from __future__ import annotations

from typing import Final

__all__ = ["REAL_BOOKS", "real_book"]

REAL_BOOKS: Final[dict[tuple[str, str], tuple[str, str, str]]] = {
    # Kraken spot: 0.5 and 0.6 pip spreads; about 43 M and 11 M USD a day.
    ("forex", "EURUSD"): ("kraken", "EUR/USD", "spot"),
    ("forex", "GBPUSD"): ("kraken", "GBP/USD", "spot"),
    # Binance USD-M perpetuals on commodities: 2.83 B, 0.80 B and 0.83 B USDT a day.
    ("forex", "XAUUSD"): ("binance-usdm", "XAUUSDT", "perpetual"),
    ("forex", "XAGUSD"): ("binance-usdm", "XAGUSDT", "perpetual"),
    ("futures-comex", "GC1!"): ("binance-usdm", "XAUUSDT", "perpetual"),
    ("futures-comex", "SI1!"): ("binance-usdm", "XAGUSDT", "perpetual"),
    ("futures-nymex", "CL1!"): ("binance-usdm", "CLUSDT", "perpetual"),
    # Binance USD-M perpetuals on US shares and ETFs: 96 M, 149 M and 5.28 B USDT a day for
    # the three shares.
    ("equity", "AAPL"): ("binance-usdm", "AAPLUSDT", "perpetual"),
    ("equity", "TSLA"): ("binance-usdm", "TSLAUSDT", "perpetual"),
    ("equity", "NVDA"): ("binance-usdm", "NVDAUSDT", "perpetual"),
    ("equity", "SPY"): ("binance-usdm", "SPYUSDT", "perpetual"),
    ("equity", "QQQ"): ("binance-usdm", "QQQUSDT", "perpetual"),
}
"""``(market, symbol)`` of a synthetic instrument to ``(market, symbol, kind)`` of the real
book. ``kind`` is ``spot`` or ``perpetual``."""


def real_book(market: str, symbol: str) -> dict[str, str] | None:
    """Where a real order book for this instrument's underlying is, or ``None``."""
    found = REAL_BOOKS.get((market, symbol)) or REAL_BOOKS.get((market, symbol.upper()))
    if found is None:
        return None
    return {"market": found[0], "symbol": found[1], "kind": found[2]}
