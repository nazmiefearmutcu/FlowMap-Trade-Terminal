"""The Research drawer's sections behind one service.

``ResearchService.get(market, section, symbol)`` answers one section for one
symbol from its source module, through the shared ``SectionCache``. The table
``SECTIONS`` names every section, its publisher and how long an answer is kept.
The jets section has no source and no entry (the drawer shows a static note).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import os
from pathlib import Path
import re
import time

from flowmap_server.research.base import (
    Http,
    SectionCache,
    SectionResult,
    SectionUnavailable,
    crypto_base,
    us_symbol,
)
from flowmap_server.research.congress import HouseTradesSource
from flowmap_server.research.contracts import ContractsSource
from flowmap_server.research.crypto import CryptoSource
from flowmap_server.research.hiring import HiringSource
from flowmap_server.research.names import CompanyNames
from flowmap_server.research.options import OptionsSource
from flowmap_server.research.sec import SecSource
from flowmap_server.research.short_volume import ShortVolumeSource

__all__ = ["SECTIONS", "ResearchService", "SectionSpec", "UnknownSection", "sec_contact"]

SEC_CONTACT_ENV = "SEC_CONTACT_EMAIL"
_EMAIL = re.compile(r"[^@\s<>\"']{1,64}@[^@\s<>\"']{1,190}\.[A-Za-z]{2,24}")
# The key a market-wide section is cached under.
MARKET_WIDE = "MARKET"


@dataclass(frozen=True)
class SectionSpec:
    source: str
    ttl_s: float
    needs_sec_contact: bool = False
    market_wide: bool = False


SECTIONS: dict[tuple[str, str], SectionSpec] = {
    ("us", "risk-factors"): SectionSpec("SEC EDGAR", 6 * 3600.0, needs_sec_contact=True),
    ("us", "language"): SectionSpec("SEC EDGAR", 6 * 3600.0, needs_sec_contact=True),
    ("us", "contracts"): SectionSpec("USAspending.gov", 6 * 3600.0),
    # Read from memory; short so the coverage line follows the background reader.
    ("us", "house-trades"): SectionSpec("House Clerk", 60.0),
    ("us", "gex"): SectionSpec("Cboe delayed options", 15 * 60.0),
    ("us", "short-volume"): SectionSpec("FINRA Reg SHO", 3600.0),
    ("us", "hiring"): SectionSpec("Public job boards", 12 * 3600.0),
    ("crypto", "derivatives"): SectionSpec("Binance Futures", 60.0),
    ("crypto", "options"): SectionSpec("Deribit", 15 * 60.0),
    ("crypto", "market"): SectionSpec("CoinGecko and DefiLlama", 10 * 60.0),
    ("crypto", "sentiment"): SectionSpec("alternative.me", 3600.0, market_wide=True),
}


class UnknownSection(ValueError):
    """The market, section or symbol is not one this service answers."""


def sec_contact(header_value: str | None) -> str | None:
    """The SEC contact e-mail: the request's, else ``SEC_CONTACT_EMAIL``; None when neither is an e-mail."""
    for candidate in (header_value, os.environ.get(SEC_CONTACT_ENV)):
        value = (candidate or "").strip()
        if value and _EMAIL.fullmatch(value):
            return value
    return None


class ResearchService:
    """Every Research section, cached. Sources can be injected for tests."""

    def __init__(
        self,
        *,
        data_dir: Path | None = None,
        http: Http | None = None,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        names: CompanyNames | None = None,
        sec: SecSource | None = None,
        contracts: ContractsSource | None = None,
        house: HouseTradesSource | None = None,
        options: OptionsSource | None = None,
        short_volume: ShortVolumeSource | None = None,
        hiring: HiringSource | None = None,
        crypto: CryptoSource | None = None,
    ) -> None:
        self._http = http or Http()
        self._cache = SectionCache(clock=clock, monotonic=monotonic)
        self._names = names or CompanyNames(self._http, monotonic=monotonic)
        self.sec = sec or SecSource(self._http, clock=clock)
        self.contracts = contracts or ContractsSource(self._http, self._names, clock=clock)
        self.house = house or HouseTradesSource(self._http, data_dir=data_dir, clock=clock)
        self.options = options or OptionsSource(self._http, clock=clock)
        self.short_volume = short_volume or ShortVolumeSource(self._http, clock=clock)
        self.hiring = hiring or HiringSource(self._http, self._names, clock=clock)
        self.crypto = crypto or CryptoSource(self._http, self.options, clock=clock)

    async def get(
        self, market: str, section: str, raw_symbol: str, *, contact: str | None = None
    ) -> SectionResult:
        spec = SECTIONS.get((market, section))
        if spec is None:
            raise UnknownSection(f"no section {section!r} for market {market!r}")
        symbol = us_symbol(raw_symbol) if market == "us" else crypto_base(raw_symbol)
        if symbol is None:
            raise UnknownSection(f"malformed symbol {raw_symbol[:40]!r}")
        key = MARKET_WIDE if spec.market_wide else symbol
        return await self._cache.get(
            section, key, ttl_s=spec.ttl_s, source=spec.source,
            load=self._loader(market, section, symbol, contact),
        )

    def _loader(
        self, market: str, section: str, symbol: str, contact: str | None
    ) -> Callable[[], Awaitable[SectionResult]]:
        async def load() -> SectionResult:
            if market == "us":
                if section in ("risk-factors", "language"):
                    if contact is None:
                        raise SectionUnavailable("sec_contact_missing")
                    if section == "risk-factors":
                        return await self.sec.risk_factors(symbol, contact)
                    return await self.sec.management_language(symbol, contact)
                if section == "contracts":
                    return await self.contracts.contracts(symbol)
                if section == "house-trades":
                    return await self.house.trades(symbol)
                if section == "gex":
                    return await self.options.equity_gex(symbol)
                if section == "short-volume":
                    return await self.short_volume.short_volume(symbol)
                if section == "hiring":
                    return await self.hiring.hiring(symbol)
            if section == "derivatives":
                return await self.crypto.derivatives(symbol)
            if section == "options":
                return await self.crypto.options(symbol)
            if section == "market":
                return await self.crypto.market(symbol)
            if section == "sentiment":
                return await self.crypto.sentiment()
            raise UnknownSection(f"no loader for {market}/{section}")

        return load

    async def start(self) -> None:
        """Start the background work (the House reports cache)."""
        await self.house.start()

    async def close(self) -> None:
        await self.house.close()
        await self._http.close()
