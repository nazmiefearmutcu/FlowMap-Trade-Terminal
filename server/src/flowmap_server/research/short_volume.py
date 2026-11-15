"""Short-sale volume from FINRA's daily Reg SHO files (``CNMSshvol{YYYYMMDD}.txt``).

A file is one trading day: a header line, one row per symbol, and a trailer line
holding the row count. Class shares are written with a slash (``BRK/B``) and are
matched in the ``us_symbol`` form (``BRK.B``). The newest five existing files are
used; a weekend is skipped. A parsed day is kept per date (at most six), so a second
symbol reuses it without a new fetch.

Only HTTP 403 and 404 mean "no file for this day". Any other HTTP status or transport
error is raised. A day answered missing is remembered for six hours, past days only
(today's file may still be published), so a transient block on a past day heals. If the
12-day window holds no file at all, the answer raises ``ConnectionError`` rather than
an empty result: that is a block or an outage, not a holiday week.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import math
import time
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

from flowmap_server.research.base import Http, SectionResult, result

__all__ = ["ShortVolumeSource", "parse_short_volume_file"]

FINRA_URL = "https://cdn.finra.org/equity/regsho/daily"
CAP_BYTES = 10 * 1024 * 1024
SOURCE = "FINRA Reg SHO"
SECTION = "short-volume"
NEW_YORK = ZoneInfo("America/New_York")
HEADER = ["Date", "Symbol", "ShortVolume", "ShortExemptVolume", "TotalVolume", "Market"]
# Answers that mean "no file for this day" (FINRA answers 403 for a missing file).
ABSENT_STATUSES = frozenset({403, 404})
FILES_WANTED = 5
LOOKBACK_DAYS = 12  # Calendar days, today included.
MAX_PARSED_DAYS = 6
MISSING_DAY_TTL_NS = 6 * 3600 * 1_000_000_000  # How long a missing past day is not asked again.


@dataclass(frozen=True, slots=True)
class ShortRow:
    short: float
    exempt: float
    total: float


def _ratio(row: ShortRow) -> float | None:
    return row.short / row.total if row.total > 0 else None


def _finite(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite volume")
    return number


def parse_short_volume_file(raw: bytes) -> dict[str, ShortRow]:
    """Rows of one CNMS file keyed by the ``us_symbol`` form of the symbol.

    A trailer line, when present, must equal the number of rows; a mismatch means a
    truncated file and raises. A bad header or a bad row raises too.
    """
    lines = [line.strip() for line in raw.decode("utf-8").splitlines() if line.strip()]
    if not lines or [field.strip() for field in lines[0].split("|")] != HEADER:
        raise ValueError("unexpected Reg SHO header")
    rows: dict[str, ShortRow] = {}
    records = 0
    trailer: int | None = None
    for line in lines[1:]:
        fields = [field.strip() for field in line.split("|")]
        if len(fields) == 1 and fields[0].isdigit():
            trailer = int(fields[0])
            continue
        if len(fields) != 6:
            raise ValueError("malformed Reg SHO row")
        records += 1
        symbol = fields[1].replace("/", ".")
        row = ShortRow(_finite(fields[2]), _finite(fields[3]), _finite(fields[4]))
        rows.setdefault(symbol, row)
    if trailer is not None and trailer != records:
        raise ValueError("Reg SHO record count does not match the trailer")
    return rows


class ShortVolumeSource:
    """Short-sale volume for one US ticker from the newest FINRA daily files."""

    def __init__(self, http: Http, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._clock = clock
        self._parsed: dict[date, dict[str, ShortRow]] = {}
        # Past dates answered missing, with the clock reading until which they are not asked again.
        self._missing: dict[date, int] = {}
        self._lock = asyncio.Lock()

    async def short_volume(self, symbol: str) -> SectionResult:
        """Short volume for ``symbol`` (a ``us_symbol``) in the newest file that lists it.

        Raises ``ConnectionError`` when the window holds no file at all.
        """
        fetched = self._clock()
        async with self._lock:
            files = await self._newest_files()
            if not files:
                # Every day answered missing: that is an outage or a block, not a run of
                # holidays. Forget those answers so the next request asks again.
                self._missing.clear()
                raise ConnectionError("no FINRA file in the window")
        newest_day, newest = files[0]
        if symbol not in newest:
            return result(SECTION, symbol, "empty", source=SOURCE, fetched_ns=fetched,
                          reason="not_in_file")
        row = newest[symbol]
        days: list[dict[str, Any]] = [
            {"date": day.isoformat(), "shortRatio": _ratio(rows[symbol])}
            for day, rows in files
            if symbol in rows
        ]
        ratios = [entry["shortRatio"] for entry in days if entry["shortRatio"] is not None]
        data: dict[str, Any] = {
            "date": newest_day.isoformat(),
            "shortVolume": row.short,
            "shortExemptVolume": row.exempt,
            "totalVolume": row.total,
            "shortRatio": _ratio(row),
            "avgShortRatio5d": sum(ratios) / len(ratios) if len(ratios) >= 2 else None,
            "days": days,
        }
        return result(SECTION, symbol, "ok", source=SOURCE, fetched_ns=fetched,
                      as_of=newest_day.isoformat(), data=data)

    async def _newest_files(self) -> list[tuple[date, dict[str, ShortRow]]]:
        """The newest existing files, newest first, found by walking back from today (NY)."""
        today = datetime.fromtimestamp(self._clock() / 1e9, NEW_YORK).date()
        found: list[tuple[date, dict[str, ShortRow]]] = []
        for offset in range(LOOKBACK_DAYS):
            day = today - timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            parsed = await self._day(day, today)
            if parsed is not None:
                found.append((day, parsed))
                if len(found) == FILES_WANTED:
                    break
        return found

    async def _day(self, day: date, today: date) -> dict[str, ShortRow] | None:
        if day in self._parsed:
            return self._parsed[day]
        now = self._clock()
        if day in self._missing and now < self._missing[day]:
            return None
        try:
            raw = await self._http.get_bytes(
                f"{FINRA_URL}/CNMSshvol{day:%Y%m%d}.txt", limit=CAP_BYTES
            )
        except aiohttp.ClientResponseError as exc:
            if exc.status not in ABSENT_STATUSES:
                raise
            if day < today:
                self._missing[day] = now + MISSING_DAY_TTL_NS
            else:
                self._missing.pop(day, None)
            return None
        parsed = await asyncio.to_thread(parse_short_volume_file, raw)
        self._parsed[day] = parsed
        while len(self._parsed) > MAX_PARSED_DAYS:
            del self._parsed[min(self._parsed)]
        return parsed

    async def close(self) -> None:
        return None
