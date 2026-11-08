"""Keyless last-price poller: one Google Finance scrape per call.

The poller is only built on the keyless tier. Its failures are the caller's to
absorb, so a scrape can never end the feed loop.
"""

import contextlib
import math
from collections.abc import Sequence
from typing import Protocol, cast

from crocodile.core.schema.records import Trade as EqTrade


# Total timeout for the poller's own aiohttp session: a hung scrape must
# cost one poll, not the feed loop.
_HTTP_TIMEOUT_S = 10.0


class _Closable(Protocol):
    """The aiohttp session surface the poller needs (open check + close)."""

    @property
    def closed(self) -> bool: ...

    async def close(self) -> None: ...


class _ScrapeProvider(Protocol):
    """The slice of crocodile's google_finance provider this poller drives.

    The engine's scrape hook and its session attribute are not public API, so
    they are reached through this one typed view (a single cast in
    :meth:`_GooglePricePoller.poll`) instead of per-line ignores. The engine is
    vendored and pinned by sha256, so this surface changes only with the wheel."""

    session: object

    async def _scrape_symbol(self, symbol: str) -> Sequence[object]: ...


class _GooglePricePoller:
    """Default keyless last-price source: a one-shot google_finance scrape.

    Owns a lazily-created aiohttp session + provider so each poll is a single
    fragile CSS scrape; failures are the caller's to swallow. Never
    imported at module load (heavy deps) and never touched by pytest (tests
    inject ``price_fn``)."""

    def __init__(self, symbol: str) -> None:
        self._symbol = symbol
        self._provider: object | None = None
        self._session: _Closable | None = None

    async def poll(self) -> float | None:
        import aiohttp

        from crocodile.equity.providers.google_finance.connector import GoogleFinanceProvider
        from crocodile.equity.reference.registry import InstrumentRegistry
        from crocodile.core.sink.memory import MemorySink

        if self._provider is None:
            self._provider = GoogleFinanceProvider(
                [self._symbol], ["trade"], MemorySink(), InstrumentRegistry()
            )
        session = self._session
        if session is None or session.closed:
            # Total timeout: the engine's default is aiohttp's 5-minute
            # client default — one hung scrape must cost a poll, not the loop.
            session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_HTTP_TIMEOUT_S)
            )
            self._session = session
        provider = cast(_ScrapeProvider, self._provider)
        provider.session = session
        recs = await provider._scrape_symbol(self._symbol)
        for rec in recs:
            if isinstance(rec, EqTrade) and math.isfinite(rec.price):
                return float(rec.price)
        return None

    async def close(self) -> None:
        session = self._session
        self._session = None
        if session is not None and not session.closed:
            with contextlib.suppress(Exception):
                await session.close()
