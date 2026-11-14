"""Research source: placeholder until its task fills it in (see the 2026-11-15 spec)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import time

from flowmap_server.research.base import Http, SectionResult, SectionUnavailable


class HouseTradesSource:
    def __init__(
        self, http: Http, *, data_dir: Path | None = None, clock: Callable[[], int] = time.time_ns
    ) -> None:
        self._http = http
        self._data_dir = data_dir
        self._clock = clock

    async def trades(self, symbol: str) -> SectionResult:
        raise SectionUnavailable("not_built")

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None
