"""Research source: placeholder until its task fills it in (see the 2026-11-15 spec)."""

from __future__ import annotations

from collections.abc import Callable
import time
from flowmap_server.research.base import Http, SectionResult, SectionUnavailable


class SecSource:
    def __init__(self, http: Http, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._clock = clock

    async def risk_factors(self, symbol: str, contact: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def management_language(self, symbol: str, contact: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def close(self) -> None:
        return None
