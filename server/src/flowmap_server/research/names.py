"""US company names by ticker, for the sections that search by name.

The government-contracts and hiring sections look a company up by its name.
The name comes from the Nasdaq screener's full listing (every US-listed stock,
keyless), the same source the market map reads, and is cleaned the same way
(``Apple Inc. Common Stock`` -> ``Apple Inc.``). The listing is read at most
once a day; a failed read keeps the previous listing.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
import re
import time

from flowmap_server.data.market_map import clean_company_name
from flowmap_server.research.base import Http, failure_reason

__all__ = ["CompanyNames", "legal_core", "parse_listing"]

logger = logging.getLogger(__name__)

LISTING_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true"
LISTING_HEADERS = {
    # The Nasdaq API refuses requests without a browser-like agent.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
}
LISTING_LIMIT = 8 * 1024 * 1024
LISTING_TTL_S = 24 * 3600.0
LISTING_RETRY_S = 300.0
# The full listing is about 2-3 MB and the Nasdaq API can be slow to send it.
LISTING_TIMEOUT_S = 40.0

# Legal-form words dropped to get the core of a company name, whole words only.
_LEGAL_WORDS = frozenset({
    "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc",
    "holdings", "holding", "group", "nv", "sa", "ag", "se", "llc", "lp", "the",
})
_WORD = re.compile(r"[a-z0-9]+")


def parse_listing(payload: object) -> dict[str, str]:
    """``{ticker: cleaned name}`` from a screener download. Raises ``ValueError`` when empty."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        raise ValueError("listing has no data object")
    rows = payload["data"].get("rows")
    if not isinstance(rows, list):
        raise ValueError("listing has no rows list")
    names: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").strip().upper().replace("/", ".")
        name = str(row.get("name") or "").strip()
        if symbol and name:
            names[symbol] = clean_company_name(name, symbol)
    if not names:
        raise ValueError("listing has no usable rows")
    return names


def legal_core(name: str) -> str:
    """The name without punctuation and legal-form words: ``Lockheed Martin Corporation`` -> ``lockheed martin``."""
    words = [w for w in _WORD.findall(name.lower().replace("&", " and ")) if w not in _LEGAL_WORDS]
    return " ".join(words)


class CompanyNames:
    """Ticker -> company name, from a listing refreshed once a day."""

    def __init__(
        self,
        http: Http,
        *,
        fetch: Callable[[], Awaitable[object]] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http
        self._fetch = fetch or self._fetch_listing
        self._monotonic = monotonic
        self._names: dict[str, str] | None = None
        self._loaded_at: float | None = None
        self._failed_at: float | None = None
        self._lock = asyncio.Lock()

    async def name(self, symbol: str) -> str | None:
        """The cleaned company name, or None when the ticker is not listed.

        Raises the read failure when no listing has ever been read.
        """
        names = await self._listing()
        return names.get(symbol.upper())

    async def _listing(self) -> dict[str, str]:
        if self._names is not None and self._fresh():
            return self._names
        async with self._lock:
            if self._names is not None and self._fresh():
                return self._names
            if self._failed_at is not None and self._monotonic() - self._failed_at < LISTING_RETRY_S:
                if self._names is not None:
                    return self._names
                raise ConnectionError("company listing unavailable")
            try:
                names = parse_listing(await self._fetch())
            except Exception as exc:
                self._failed_at = self._monotonic()
                logger.warning("company listing refresh failed: %s", failure_reason(exc))
                if self._names is not None:
                    return self._names
                raise
            self._names = names
            self._loaded_at = self._monotonic()
            self._failed_at = None
            return names

    def _fresh(self) -> bool:
        return self._loaded_at is not None and self._monotonic() - self._loaded_at < LISTING_TTL_S

    async def _fetch_listing(self) -> object:
        return await self._http.get_json(
            LISTING_URL, limit=LISTING_LIMIT, headers=LISTING_HEADERS, timeout_s=LISTING_TIMEOUT_S
        )
