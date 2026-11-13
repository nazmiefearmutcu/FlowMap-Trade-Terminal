"""Public macro readings: SOFR, the 10y-2y Treasury spread and the high-yield spread.

SOFR comes from the New York Fed and the 10y-2y spread from the US Treasury par
yield curve; both are keyless. The high-yield spread (FRED ``BAMLH0A0HYM2``) needs
a FRED API key in ``FRED_API_KEY``, and without one it is reported as missing.
Each series is fetched on its own, so one failing source does not hide the others.
The stress score is computed only when the high-yield spread and the curve are
both present.

The service keeps a reading for 15 minutes. A refresh where every series fails
serves the previous reading marked stale, and is not retried for a minute.
"""

from __future__ import annotations

import asyncio
import csv
from dataclasses import dataclass
from datetime import UTC, date, datetime
import io
import json
import logging
import math
import os
import ssl
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

import aiohttp
import certifi
import msgspec

from flowmap_server import __version__
from flowmap_server.feeds.macro import MacroStressPoller, score_reading

__all__ = [
    "CACHE_TTL_S",
    "MacroPublicService",
    "MacroReading",
    "MacroSourceError",
    "MacroUnavailable",
    "Observation",
    "SERIES_ORDER",
    "SOURCE_NAMES",
    "parse_sofr_json",
    "parse_treasury_curve_csv",
]

logger = logging.getLogger(__name__)

CACHE_TTL_S = 15 * 60.0
# After a refresh where every series failed, no series is fetched again for this long.
RETRY_AFTER_FAILURE_S = 60.0

SOFR_SERIES = "SOFR"
HY_SERIES = "BAMLH0A0HYM2"
CURVE_SERIES = "T10Y2Y"
SERIES_ORDER = (SOFR_SERIES, HY_SERIES, CURVE_SERIES)
SOURCE_NAMES = {SOFR_SERIES: "New York Fed", CURVE_SERIES: "US Treasury", HY_SERIES: "FRED"}

_SOFR_URL = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json"
_CURVE_URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates"
    "/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
    "&field_tdr_date_value={year}&page&_format=csv"
)
_TIMEOUT_S = 10.0
_SOFR_BODY_LIMIT = 256 * 1024
# One year of the Treasury file is about 250 rows of roughly 120 bytes.
_CURVE_BODY_LIMIT = 2 * 1024 * 1024
_READ_CHUNK = 64_000
_HEADERS = {"User-Agent": f"FlowMap/{__version__}"}
_JSON_HEADERS = {**_HEADERS, "Accept": "application/json"}
_CSV_HEADERS = {**_HEADERS, "Accept": "text/csv"}
# Reasons the FRED poller uses, named as the rest of this module names them.
_FRED_REASONS = {
    "fred_api_key_missing": "fred_api_key_missing",
    "fred_malformed_response": "malformed",
    "fred_no_observation": "no_observation",
    "fred_unreachable": "unreachable",
    "fred_rejected": "rejected",
    "fred_rate_limited": "rate_limited",
}


@dataclass(frozen=True, slots=True)
class Observation:
    """One value of a series and the date it was observed (YYYY-MM-DD)."""

    value: float
    date: str


class MacroSourceError(Exception):
    """A series has no value; ``reason`` is a short machine reason such as ``http_500``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MacroUnavailable(Exception):
    """No series has a value and nothing is held from an earlier refresh."""


class MacroReading(msgspec.Struct, frozen=True):
    sofr: float | None
    sofr_date: str | None
    yield_10y2y: float | None
    curve_date: str | None
    hy_spread: float | None
    hy_date: str | None
    stress_score: float | None
    status: str | None  # NORMAL_LIQUIDITY | ELEVATED | SEVERE_STRESS; None without both HY and curve
    source_status: dict[str, str]  # series -> "ok" or the reason it has no value
    sources: dict[str, str]  # series -> the publisher
    as_of_ns: int  # when this reading was fetched, UTC ns
    stale: bool


def _finite_number(value: object) -> float | None:
    """The value as a finite float when it is a JSON number, else None. Booleans and strings are not numbers."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _iso_date(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def parse_sofr_json(payload: object) -> Observation:
    """The latest SOFR rate from the New York Fed JSON, with its effective date.

    Raises ``MacroSourceError`` with ``malformed`` for a payload of the wrong shape
    or type, and ``no_observation`` when the list is empty.
    """
    if not isinstance(payload, dict):
        raise MacroSourceError("malformed")
    rows = payload.get("refRates")
    if not isinstance(rows, list):
        raise MacroSourceError("malformed")
    if not rows:
        raise MacroSourceError("no_observation")
    row = rows[0]
    if not isinstance(row, dict):
        raise MacroSourceError("malformed")
    rate = _finite_number(row.get("percentRate"))
    day = _iso_date(row.get("effectiveDate"))
    if rate is None or day is None:
        raise MacroSourceError("malformed")
    return Observation(rate, day)


def _tenor(cell: str) -> float | None:
    text = cell.strip()
    if not text or text == "N/A":
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _treasury_date(cell: str) -> str | None:
    try:
        return datetime.strptime(cell.strip(), "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def parse_treasury_curve_csv(text: str) -> Observation:
    """The 10y-2y spread in percent from the Treasury yield curve CSV.

    Columns are found by header name, so their order does not matter. The file lists
    the newest day first; the first row with both a 2 Yr and a 10 Yr value is used,
    and rows with an empty or ``N/A`` cell are skipped. Raises ``MacroSourceError``
    with ``malformed`` when the Date, 2 Yr or 10 Yr column is missing, and with
    ``no_observation`` when no row has both values.
    """
    try:
        reader = csv.reader(io.StringIO(text))
        header = next(reader)
        names = [cell.strip() for cell in header]
        date_at = names.index("Date")
        two_at = names.index("2 Yr")
        ten_at = names.index("10 Yr")
        width = max(date_at, two_at, ten_at) + 1
        for row in reader:
            if len(row) < width:
                continue
            two = _tenor(row[two_at])
            ten = _tenor(row[ten_at])
            day = _treasury_date(row[date_at])
            if two is None or ten is None or day is None:
                continue
            return Observation(round(ten - two, 4), day)
    except StopIteration:
        raise MacroSourceError("no_observation") from None
    except (ValueError, csv.Error):
        # A missing column name raises ValueError from list.index.
        raise MacroSourceError("malformed") from None
    raise MacroSourceError("no_observation")


class _Stream(Protocol):
    async def read(self, n: int = -1) -> bytes: ...


class _Body(Protocol):
    """The part of an aiohttp response the bounded reader needs."""

    @property
    def content_length(self) -> int | None: ...

    @property
    def content(self) -> _Stream: ...


async def _read_capped(response: _Body, *, limit: int) -> bytes:
    """The body, read in chunks and refused past ``limit`` bytes (a declared length is checked first)."""
    declared = response.content_length
    if declared is not None and declared > limit:
        raise ValueError(f"response declares {declared} bytes, over the {limit} byte limit")
    body = bytearray()
    while True:
        chunk = await response.content.read(_READ_CHUNK)
        if not chunk:
            break
        body += chunk
        if len(body) > limit:
            raise ValueError(f"response body is over the {limit} byte limit")
    return bytes(body)


def _fred_reason(reason: str) -> str:
    if reason.startswith("fred_http_"):
        return reason[len("fred_"):]
    return _FRED_REASONS.get(reason, reason)


def _summary(reasons: dict[str, str]) -> str:
    return ", ".join(f"{name} {reason}" for name, reason in reasons.items())


def _held_observation(held: MacroReading | None, name: str) -> Observation | None:
    """The value and date a held reading has for one series, or None when it has none."""
    if held is None:
        return None
    if name == SOFR_SERIES:
        value, day = held.sofr, held.sofr_date
    elif name == CURVE_SERIES:
        value, day = held.yield_10y2y, held.curve_date
    else:
        value, day = held.hy_spread, held.hy_date
    if value is None or day is None:
        return None
    return Observation(value, day)


class MacroPublicService:
    """The macro reading, cached for ``ttl_s`` seconds.

    Concurrent callers share one refresh, and the three series are fetched at once.
    A refresh that gives at least one value is merged into the held reading: a
    series that failed keeps its last good value and date, and the reading is
    stale while any such value is carried over. A refresh where every series
    fails serves the previous reading as stale, or raises ``MacroUnavailable``
    when there is none, and is not retried for ``RETRY_AFTER_FAILURE_S`` seconds.
    """

    def __init__(
        self,
        *,
        fetch_sofr: Callable[[], Awaitable[Observation]] | None = None,
        fetch_curve: Callable[[], Awaitable[Observation]] | None = None,
        fetch_hy: Callable[[], Awaitable[Observation]] | None = None,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        ttl_s: float = CACHE_TTL_S,
    ) -> None:
        self._fetchers: dict[str, Callable[[], Awaitable[Observation]]] = {
            SOFR_SERIES: fetch_sofr or self._fetch_sofr,
            HY_SERIES: fetch_hy or self._fetch_hy,
            CURVE_SERIES: fetch_curve or self._fetch_curve,
        }
        self._clock = clock
        self._monotonic = monotonic
        self._ttl_s = ttl_s
        self._held: tuple[MacroReading, float] | None = None
        self._failed_at: float | None = None
        self._failure: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self._session: aiohttp.ClientSession | None = None

    async def get(self) -> MacroReading:
        fresh = self._fresh()
        if fresh is not None:
            return fresh
        async with self._lock:
            fresh = self._fresh()
            if fresh is not None:
                return fresh
            if self._failed_at is None or self._monotonic() - self._failed_at >= RETRY_AFTER_FAILURE_S:
                outcomes = await asyncio.gather(*(self._observe(name) for name in SERIES_ORDER))
                results = dict(zip(SERIES_ORDER, outcomes, strict=True))
                if any(isinstance(result, Observation) for result in results.values()):
                    held = self._held[0] if self._held is not None else None
                    reading = self._build(results, held)
                    self._held = (reading, self._monotonic())
                    self._failed_at = None
                    self._failure = {}
                    return reading
                self._failed_at = self._monotonic()
                self._failure = {name: str(result) for name, result in results.items()}
            return self._fallback()

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is not None and not session.closed:
            await session.close()

    def _fresh(self) -> MacroReading | None:
        if self._held is None:
            return None
        reading, fetched_at = self._held
        return reading if self._monotonic() - fetched_at < self._ttl_s else None

    def _fallback(self) -> MacroReading:
        if self._held is None:
            raise MacroUnavailable(f"Macro data is unavailable right now ({_summary(self._failure)})")
        return msgspec.structs.replace(self._held[0], stale=True)

    async def _observe(self, name: str) -> Observation | str:
        """The series' value, or the reason it has none. Never raises."""
        try:
            return await self._fetchers[name]()
        except MacroSourceError as exc:
            return exc.reason
        except Exception as exc:
            logger.warning("macro series %s failed: %s", name, type(exc).__name__)
            return "unreachable"

    def _build(self, results: dict[str, Observation | str], held: MacroReading | None) -> MacroReading:
        """The reading for this refresh, with each failed series filled from ``held``.

        A series that failed keeps its last good value and date when the held
        reading has one. The score and status come from the merged values, and
        the reading is stale when any value was carried over.
        """
        values: dict[str, Observation | None] = {}
        carried = False
        for name, result in results.items():
            if isinstance(result, Observation):
                values[name] = result
                continue
            previous = _held_observation(held, name)
            carried = carried or previous is not None
            values[name] = previous
        sofr_obs = values[SOFR_SERIES]
        hy_obs = values[HY_SERIES]
        curve_obs = values[CURVE_SERIES]
        score: float | None = None
        status: str | None = None
        if hy_obs is not None and curve_obs is not None:
            score, status = score_reading(hy_obs.value, curve_obs.value)
        return MacroReading(
            sofr=sofr_obs.value if sofr_obs else None,
            sofr_date=sofr_obs.date if sofr_obs else None,
            yield_10y2y=curve_obs.value if curve_obs else None,
            curve_date=curve_obs.date if curve_obs else None,
            hy_spread=hy_obs.value if hy_obs else None,
            hy_date=hy_obs.date if hy_obs else None,
            stress_score=score,
            status=status,
            source_status={
                name: "ok" if isinstance(result, Observation) else result
                for name, result in results.items()
            },
            sources=dict(SOURCE_NAMES),
            as_of_ns=self._clock(),
            stale=carried,
        )

    async def _fetch_sofr(self) -> Observation:
        body = await self._get_body(_SOFR_URL, headers=_JSON_HEADERS, limit=_SOFR_BODY_LIMIT)
        try:
            payload = json.loads(body)
        except ValueError:
            raise MacroSourceError("malformed") from None
        return parse_sofr_json(payload)

    async def _fetch_curve(self) -> Observation:
        # Early in the year the current year's file can have no rows yet, or no
        # file at all (HTTP 404), so the previous year is read in those cases.
        year = datetime.now(UTC).year
        for candidate in (year, year - 1):
            try:
                body = await self._get_body(
                    _CURVE_URL.format(year=candidate), headers=_CSV_HEADERS, limit=_CURVE_BODY_LIMIT
                )
                try:
                    text = body.decode("utf-8-sig")
                except UnicodeDecodeError:
                    raise MacroSourceError("malformed") from None
                return parse_treasury_curve_csv(text)
            except MacroSourceError as exc:
                missing_this_year = exc.reason in ("no_observation", "http_404")
                if not missing_this_year or candidate == year - 1:
                    raise
        raise MacroSourceError("no_observation")

    async def _fetch_hy(self) -> Observation:
        """The FRED high-yield spread, read with the key in ``FRED_API_KEY`` (missing without it)."""
        key = os.environ.get("FRED_API_KEY", "").strip()
        poller = MacroStressPoller(api_key=key or None)
        try:
            value = await poller.fetch_series_observation(HY_SERIES)
            if value is None:
                raise MacroSourceError(_fred_reason(poller.failure_reason(HY_SERIES) or "fred_unreachable"))
            day = _iso_date(poller.observation_date(HY_SERIES))
            if day is None:
                raise MacroSourceError("malformed")
            return Observation(value, day)
        finally:
            await poller.close()

    async def _get_body(self, url: str, *, headers: dict[str, str], limit: int) -> bytes:
        session = self._http()
        try:
            async with session.get(
                url, headers=headers, timeout=aiohttp.ClientTimeout(total=_TIMEOUT_S)
            ) as response:
                if response.status != 200:
                    raise MacroSourceError(f"http_{response.status}")
                return await _read_capped(response, limit=limit)
        except MacroSourceError:
            raise
        except ValueError:
            # Raised by the bounded reader when the body is over its limit.
            raise MacroSourceError("malformed") from None
        except (aiohttp.ClientError, TimeoutError):
            raise MacroSourceError("unreachable") from None

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            context = ssl.create_default_context(cafile=certifi.where())
            self._session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=context))
        return self._session
