"""Research source: placeholder until its task fills it in (see the 2026-11-15 spec)."""

from __future__ import annotations

from collections.abc import Callable
import time

from flowmap_server.research.options import OptionsSource
from flowmap_server.research.base import Http, SectionResult, SectionUnavailable


class CryptoSource:
    def __init__(self, http: Http, options: OptionsSource, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._clock = clock

    async def derivatives(self, base: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def options(self, base: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def market(self, base: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def sentiment(self) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def close(self) -> None:
        return None
