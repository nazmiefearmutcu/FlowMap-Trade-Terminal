"""Research source: placeholder until its task fills it in (see the 2026-11-15 spec)."""

from __future__ import annotations

from collections.abc import Callable
import time

from flowmap_server.research.names import CompanyNames
from flowmap_server.research.base import Http, SectionResult, SectionUnavailable


class HiringSource:
    def __init__(self, http: Http, names: CompanyNames, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._clock = clock

    async def hiring(self, symbol: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def close(self) -> None:
        return None
