"""Loaded before every test module: importing the package applies the Windows
``now_ns`` shim (``flowmap_server._compat``) before any test binds crocodile
names directly."""

import pytest

import flowmap_server  # noqa: F401


@pytest.fixture(autouse=True)
def _fresh_ccxt_market_tables():
    """The ccxt market-table cache is process-wide; no test may inherit another's table."""
    from flowmap_server.core import backfill

    backfill._MARKETS_CACHE.clear()
    yield
    backfill._MARKETS_CACHE.clear()
