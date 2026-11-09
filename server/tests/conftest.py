"""Loaded before every test module: importing the package applies the Windows
``now_ns`` shim (``flowmap_server._compat``) before any test binds crocodile
names directly."""

import os

import pytest

import flowmap_server  # noqa: F401


@pytest.fixture(autouse=True)
def _no_developer_flowmap_env(monkeypatch):
    """A developer's FLOWMAP_* settings must not change a test; a test sets its own with monkeypatch."""
    for name in [name for name in os.environ if name.startswith("FLOWMAP_")]:
        monkeypatch.delenv(name)


@pytest.fixture(autouse=True)
def _fresh_ccxt_market_tables():
    """The ccxt market-table cache is process-wide; no test may inherit another's table."""
    from flowmap_server.core import backfill

    backfill._MARKETS_CACHE.clear()
    yield
    backfill._MARKETS_CACHE.clear()
