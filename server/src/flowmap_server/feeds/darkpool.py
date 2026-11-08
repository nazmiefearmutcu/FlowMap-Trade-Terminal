"""FINRA Reg SHO daily short-sale volume feed (FLOW <GO>).

Pulls the daily FINRA Reg SHO consolidated short-sale file:
  https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
- The metric is the short-sale volume share = short_volume / total_volume.
  This file reports Reg SHO short sales. It does not report dark-pool or ATS
  print volume, so it says nothing about institutional accumulation or
  distribution, and no such label is produced.
- Stores observations in DuckWarehouse for live query and historical analysis.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
import logging
from typing import Any

import aiohttp

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.warehouse_share import shared_warehouse

log = logging.getLogger(__name__)

_FINRA_CDN_REGSHO = "https://cdn.finra.org/equity/regsho/daily"
# FINRA publishes a file for each trading day, so a 404 on a weekday is usually a
# holiday or a file not yet published. Step back over this many weekdays at most.
_MAX_WEEKDAY_STEPBACK = 4


class DarkPoolCollector:
    """Aggregates FINRA Reg SHO short-sale volume shares."""

    def __init__(self, warehouse: DuckWarehouse | None = None) -> None:
        self.warehouse = warehouse or shared_warehouse()
        self._session: aiohttp.ClientSession | None = None
        # Outcome of the latest fetch: which date was actually read, and why it failed.
        self.last_status: dict[str, Any] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap/{__version__} (research)"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_regsho_daily(
        self,
        target_date: date | None = None,
        symbols: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch and parse the daily FINRA Reg SHO file, stepping back on 404.

        ``last_status`` records the date that was read (``date_used``) and, when
        nothing was read, the error, so "not published yet" and "unreachable" are
        not the same result.
        """
        requested = target_date or (datetime.now(UTC).date() - timedelta(days=1))
        target = requested
        # Skip weekends backwards
        while target.weekday() >= 5:
            target -= timedelta(days=1)

        session = await self._get_session()
        text: str | None = None
        http_status: int | None = None
        error: str | None = None
        for _ in range(_MAX_WEEKDAY_STEPBACK + 1):
            date_str = target.strftime("%Y%m%d")
            url = f"{_FINRA_CDN_REGSHO}/CNMSshvol{date_str}.txt"
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    http_status = resp.status
                    if resp.status == 404:
                        target = _previous_weekday(target)
                        error = "not_published"
                        continue
                    if resp.status != 200:
                        error = f"http_{resp.status}"
                        log.warning("FINRA Reg SHO daily returned %s for %s", resp.status, date_str)
                        break
                    text = await resp.text(errors="replace")
                    error = None
                    break
            except Exception as exc:
                error = "unreachable"
                log.warning("Failed fetching FINRA Reg SHO daily %s: %s", url, exc)
                break

        if text is None:
            self.last_status = {
                "source_ok": False, "http_status": http_status, "error": error,
                "date_used": None, "requested_date": requested.isoformat(), "rows": 0,
            }
            return []

        iso_date = target.strftime("%Y-%m-%d")
        results: list[dict[str, Any]] = []
        sym_filter = {s.upper() for s in symbols} if symbols else None

        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("Date|"):
                continue
            parts = line.split("|")
            if len(parts) < 5:
                continue

            sym = parts[1].strip().upper()
            if sym_filter and sym not in sym_filter:
                continue

            try:
                short_vol = float(parts[2].strip() or 0.0)
                short_exempt = float(parts[3].strip() or 0.0)
                total_vol = float(parts[4].strip() or 0.0)
            except (ValueError, TypeError):
                continue

            if total_vol <= 0:
                continue

            short_ratio = round(short_vol / total_vol, 4)
            # Descriptive threshold only: half the day's short-sale volume was short.
            high_short_share = short_ratio >= 0.50

            row = {
                "date": iso_date,
                "symbol": sym,
                "short_volume": short_vol,
                "short_exempt_volume": short_exempt,
                "total_volume": total_vol,
                "short_ratio": short_ratio,
                "high_short_share": high_short_share,
            }
            results.append(row)

            # Persist to warehouse
            self.warehouse.insert_darkpool_volume(
                iso_date,
                sym,
                short_vol,
                short_exempt,
                total_vol,
                short_ratio,
                high_short_share,
            )

        self.last_status = {
            "source_ok": True, "http_status": 200, "error": None,
            "date_used": iso_date, "requested_date": requested.isoformat(), "rows": len(results),
        }
        log.info("Ingested %d FINRA Reg SHO records for date %s", len(results), iso_date)
        return results


def _previous_weekday(day: date) -> date:
    step = day - timedelta(days=1)
    while step.weekday() >= 5:
        step -= timedelta(days=1)
    return step
