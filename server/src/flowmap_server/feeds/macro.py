"""Macro Liquidity & Credit Stress Engine (MACRO <GO>).

Queries St. Louis Fed FRED API for systemic macro liquidity:
- SOFR (Secured Overnight Financing Rate): Key dollar repo benchmark.
- BAMLH0A0HYM2 (US High Yield Option-Adjusted Spread): Corporate credit default risk (CDS proxy).
- T10Y2Y (10-Year minus 2-Year Treasury Yield Curve): Recession inversion warning.
- Produces an uncalibrated heuristic stress score (0.0 to 1.0). Its weights,
  anchors and thresholds are fixed model choices, not a validated model; the
  method is returned with every result.

Every reading keeps the FRED observation date, not the date it was fetched, and
every failure carries a reason, so a stale or missing value is never presented as
today's regime.

Wiring status: this build starts no producer for this module. Nothing under
``src/`` imports it, so the FRED host named here is not contacted by a running
server; only the tests exercise it. Treat the description above as the module's
design, not as a data source this build serves.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
import logging
import math
from typing import Any

import aiohttp
import numpy as np

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds._numeric import finite_number
from flowmap_server.feeds.warehouse_share import shared_warehouse

log = logging.getLogger(__name__)

_FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"
# A reading whose observation date is more than this many business days old is
# reported as stale; FRED publishes these series with a lag of about one day.
_STALE_BUSINESS_DAYS = 3
_SERIES = ("SOFR", "BAMLH0A0HYM2", "T10Y2Y")
_METHOD = {
    "model": "uncalibrated heuristic composite; not a validated stress model",
    "hy_score": "clip((HY OAS % - 3.0) / 3.0, 0, 1)",
    "curve_score": "clip(-T10Y2Y % / 0.5, 0, 1) when inverted, else 0",
    "composite": "0.6 * hy_score + 0.4 * curve_score, rounded to 3 places",
    "status_thresholds": {"SEVERE_STRESS": 0.70, "ELEVATED": 0.35},
}


def _finite_float(value: object) -> float:
    """The value as a float, or NaN when it is not a finite number (callers check first)."""
    return float(value) if finite_number(value) else math.nan


class MacroStressPoller:
    """Monitors credit risk spreads and yield curve inversions."""

    def __init__(
        self,
        api_key: str | None = None,
        warehouse: DuckWarehouse | None = None,
    ) -> None:
        self.api_key = api_key.strip() if api_key else None
        self.warehouse = warehouse or shared_warehouse()
        self._session: aiohttp.ClientSession | None = None
        # Per-series observation date and failure reason from the latest fetch.
        self._observation_dates: dict[str, str] = {}
        self._failure_reasons: dict[str, str] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-MacroStress/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_series_observation(self, series_id: str) -> float | None:
        """Fetch latest numeric observation for a FRED series ID.

        The observation date is kept in ``self._observation_dates`` and the reason
        for a missing value in ``self._failure_reasons``.
        """
        self._observation_dates.pop(series_id, None)
        self._failure_reasons.pop(series_id, None)
        if not self.api_key:
            self._failure_reasons[series_id] = "fred_api_key_missing"
            return None
        session = await self._get_session()
        params: dict[str, str | int] = {
            "series_id": series_id,
            "api_key": self.api_key,
            "file_type": "json",
            "sort_order": "desc",
            "limit": 5,
        }
        try:
            async with session.get(_FRED_OBS_URL, params=params, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    self._failure_reasons[series_id] = _http_reason(resp.status)
                    log.warning("FRED %s returned HTTP %s", series_id, resp.status)
                    return None
                data = await resp.json()
                obs = data.get("observations", []) if isinstance(data, dict) else []
                if not isinstance(obs, list):
                    self._failure_reasons[series_id] = "fred_malformed_response"
                    return None
                for item in obs:
                    if not isinstance(item, dict):
                        continue
                    raw_value = item.get("value")
                    if raw_value is None or raw_value == "." or isinstance(raw_value, bool):
                        continue
                    try:
                        value = float(raw_value)
                    except (TypeError, ValueError, OverflowError):
                        continue
                    if not math.isfinite(value):
                        continue
                    observed = item.get("date")
                    if isinstance(observed, str) and observed:
                        self._observation_dates[series_id] = observed
                    return value
                self._failure_reasons[series_id] = "fred_no_observation"
        except Exception as exc:
            self._failure_reasons[series_id] = "fred_unreachable"
            # Log the exception type only: the request URL carries the API key,
            # and some transport errors render their request in the message.
            log.warning("FRED query for %s failed: %s", series_id, type(exc).__name__)
        return None

    async def compute_current_stress(self) -> dict[str, Any]:
        """Compute the heuristic macro credit and liquidity stress reading."""
        sofr_val, hy_val, t10y2y_val = await asyncio.gather(
            self.fetch_series_observation("SOFR"),
            self.fetch_series_observation("BAMLH0A0HYM2"),
            self.fetch_series_observation("T10Y2Y"),
            return_exceptions=True,
        )

        observations = {
            "SOFR": sofr_val,
            "BAMLH0A0HYM2": hy_val,
            "T10Y2Y": t10y2y_val,
        }
        missing = [name for name, value in observations.items() if not finite_number(value)]
        reasons = {name: self._failure_reasons.get(name, "fred_unreachable") for name in missing}
        series_dates = {name: self._observation_dates.get(name) for name in _SERIES}
        # Per series: "ok", or the reason it has no reading. The wire carries this map as
        # MacroStressUpdate.source_status.
        source_status = {name: reasons.get(name, "ok") for name in _SERIES}
        if missing:
            return {
                "date": None,
                "as_of": None,
                "available": False,
                "source": "FRED",
                "missing_series": missing,
                "unavailable_reason": _summary_reason(reasons),
                "series_dates": series_dates,
                "source_status": source_status,
                "stale": None,
                "sofr": None,
                "hy_spread_pct": None,
                "yield_curve_10y2y": None,
                "stress_score": None,
                "status": "UNAVAILABLE",
                "inversion_alert": None,
                "method": _METHOD,
            }
        sofr = _finite_float(sofr_val)
        hy_spread = _finite_float(hy_val)
        yield_curve = _finite_float(t10y2y_val)

        # Uncalibrated heuristic (see _METHOD): the HY spread scores from 0 at 3% to 1 at 6%,
        # and an inverted 10y-2y curve adds up to 0.4 as it inverts by 0.5 points.
        hy_score = min(max((hy_spread - 3.0) / 3.0, 0.0), 1.0)
        curve_score = min(max((-yield_curve) / 0.5, 0.0), 1.0) if yield_curve < 0 else 0.0
        composite_score = round(0.6 * hy_score + 0.4 * curve_score, 3)

        if composite_score >= 0.70:
            status = "SEVERE_STRESS"
        elif composite_score >= 0.35:
            status = "ELEVATED"
        else:
            status = "NORMAL_LIQUIDITY"

        # The reading is as old as its oldest series. Without a date for every
        # series there is no honest as-of date, so nothing is persisted under today.
        dated = [d for d in series_dates.values() if d]
        as_of = min(dated) if len(dated) == len(_SERIES) else None
        stale = _is_stale(as_of) if as_of is not None else None
        persisted = as_of is not None
        if as_of is not None:
            self.warehouse.insert_macro_stress(
                as_of,
                sofr,
                hy_spread,
                yield_curve,
                composite_score,
                status,
            )

        return {
            "date": as_of,
            "as_of": as_of,
            "available": True,
            "source": "FRED",
            "missing_series": [],
            "unavailable_reason": None,
            "series_dates": series_dates,
            "source_status": source_status,
            "stale": stale,
            "persisted": persisted,
            "sofr": sofr,
            "hy_spread_pct": hy_spread,
            "yield_curve_10y2y": yield_curve,
            "stress_score": composite_score,
            "status": status,
            "inversion_alert": yield_curve < 0.0,
            "method": _METHOD,
        }


def _http_reason(status: int) -> str:
    if status in (400, 403):
        return "fred_rejected"
    if status == 429:
        return "fred_rate_limited"
    return f"fred_http_{status}"


def _summary_reason(reasons: dict[str, str]) -> str | None:
    if not reasons:
        return None
    unique = sorted(set(reasons.values()))
    return unique[0] if len(unique) == 1 else "fred_mixed_failures"


def _is_stale(as_of: str) -> bool:
    try:
        observed = date.fromisoformat(as_of)
    except ValueError:
        return True
    today = datetime.now(UTC).date()
    if observed > today:
        return False
    return int(np.busday_count(observed, today)) > _STALE_BUSINESS_DAYS
