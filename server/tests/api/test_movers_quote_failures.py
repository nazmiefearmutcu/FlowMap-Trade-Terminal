"""A movers quote that fails is dropped from the list and the reason is logged.

The sweep stays best effort: one failing symbol shortens the ranking, it never
fails the request. The drop must not be silent, or a broken feed looks like a
shorter, honest-looking list.
"""

from __future__ import annotations

import logging

from flowmap_server.api import market_cache


async def test_a_failing_movers_quote_is_dropped_and_logged(caplog):
    async def broken(symbol: str):
        raise RuntimeError("venue returned no candles")

    with caplog.at_level(logging.WARNING, logger=market_cache.__name__):
        assert await market_cache._safe_quote(broken, "NOPE1") is None

    assert "NOPE1" in caplog.text
    assert "RuntimeError" in caplog.text
