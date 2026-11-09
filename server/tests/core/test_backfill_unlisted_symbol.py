"""A crypto symbol its venue does not list backfills nothing, instead of raising into the kline path."""

from __future__ import annotations

import logging

from flowmap_server.core import backfill
from flowmap_server.data.venues import UnlistedSymbolError
from flowmap_server.feeds import crypto


async def test_unlisted_symbol_returns_no_klines_and_logs_a_warning(monkeypatch, caplog):
    async def refuse(market: str, symbol: str) -> str:
        raise UnlistedSymbolError(f"{symbol!r} is not listed on {market!r}")

    async def no_native(*args, **kwargs):
        raise AssertionError("an unlisted symbol must not reach a venue fetch")

    monkeypatch.setattr(crypto, "resolve_symbol_cached", refuse)
    monkeypatch.setattr(backfill, "_native_candles", no_native)
    monkeypatch.setattr(backfill, "_ccxt_candles", no_native, raising=False)

    with caplog.at_level(logging.WARNING, logger=backfill.logger.name):
        candles = await backfill.crypto_klines("binance-spot", "NOTLISTED", max_bars=10, now_ns=0)

    assert candles == []
    assert "NOTLISTED" in caplog.text
