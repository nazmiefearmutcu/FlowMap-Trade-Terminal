"""US Government & Defense Contracts intelligence listener (GOV <GO>).

Queries USASpending.gov API (official, completely free US government REST API)
for awarded defense, intelligence, and agency contracts:
- Endpoint: https://api.usaspending.gov/api/v2/search/spending_by_award/
- Maps recipient entity names to stock symbols (LMT, RTX, GD, BA, NOC, PLTR, etc.).
- Categorizes multi-million / billion dollar allocations into MARKET_INTELLIGENCE events.

Wiring status: this build starts no producer for this module, so nothing it
produces reaches a client. Only the tests exercise it. Treat the description above
as the module's design, not as data this build serves.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import logging
import math
import time
from typing import Any

import aiohttp

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.warehouse_share import shared_warehouse

log = logging.getLogger(__name__)

_USASPENDING_API = "https://api.usaspending.gov/api/v2/search/spending_by_award/"

# Corporate recipient name substrings to ticker mapping
RECIPIENT_TICKER_MAP: dict[str, str] = {
    "LOCKHEED MARTIN": "LMT",
    "RAYTHEON": "RTX",
    "GENERAL DYNAMICS": "GD",
    "BOEING": "BA",
    "NORTHROP GRUMMAN": "NOC",
    "PALANTIR": "PLTR",
    "BOOZ ALLEN HAMILTON": "BAH",
    "LEIDOS": "LDOS",
    "L3HARRIS": "LHX",
    "HUNTINGTON INGALLS": "HII",
    "MICROSOFT": "MSFT",
    "AMAZON DATA SERVICES": "AMZN",
    "AMAZON WEB SERVICES": "AMZN",
    "ALPHABET": "GOOGL",
    "GOOGLE": "GOOGL",
}


class DefenseContractsListener:
    """Monitors US government and DoD contract awards for publicly traded defense/tech issuers."""

    def __init__(self, warehouse: DuckWarehouse | None = None) -> None:
        self.warehouse = warehouse or shared_warehouse()
        self._session: aiohttp.ClientSession | None = None
        # Outcome of the latest fetch, so an outage is not read as "no awards".
        self.last_status: dict[str, Any] = {}
        # Awards already stored by this process; repeated polls do not re-insert them.
        self._stored: set[tuple[object, ...]] = set()

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-GovTracker/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_recent_contracts(
        self,
        lookback_days: int = 7,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Fetch latest awarded contracts from USASpending.gov."""
        now = datetime.now(UTC)
        start_date = (now - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        payload = {
            "filters": {
                "time_period": [{"start_date": start_date, "end_date": end_date}],
                "award_type_codes": ["A", "B", "C", "D"],  # Contracts
                # Restrict to the mapped issuers at the source. Without this the top
                # awards nationwide are fetched and the mapped ones are picked out afterwards.
                "recipient_search_text": sorted(set(RECIPIENT_TICKER_MAP)),
            },
            "fields": [
                "Award ID",
                "Recipient Name",
                "Award Amount",
                "Description",
                "Action Date",
                "Awarding Agency",
            ],
            "limit": limit,
            "page": 1,
            "sort": "Award Amount",
            "order": "desc",
        }

        session = await self._get_session()
        data: dict[str, Any] = {}
        http_status: int | None = None
        error: str | None = None
        try:
            async with session.post(_USASPENDING_API, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                http_status = resp.status
                if resp.status == 200:
                    data = await resp.json()
                else:
                    error = f"http_{resp.status}"
                    log.warning("USASpending API returned status %d", resp.status)
        except Exception as exc:
            error = "unreachable"
            log.warning("Failed querying USASpending.gov API: %s", exc)

        results: list[dict[str, Any]] = []
        raw_results = data.get("results", []) if isinstance(data, dict) else []
        if not isinstance(raw_results, list):
            self.last_status = {"source_ok": False, "http_status": http_status,
                                "error": error or "malformed_response", "rows": 0}
            return []

        now_ns = time.time_ns()

        for item in raw_results:
            if not isinstance(item, dict):
                continue
            recipient = str(item.get("Recipient Name") or "").strip()
            matched_sym = None
            for key, sym in RECIPIENT_TICKER_MAP.items():
                if key in recipient.upper():
                    matched_sym = sym
                    break

            if not matched_sym:
                continue

            raw_amount = item.get("Award Amount")
            try:
                amount = float(raw_amount) if raw_amount is not None and not isinstance(raw_amount, bool) else None
            except (TypeError, ValueError, OverflowError):
                amount = None
            if amount is not None and not math.isfinite(amount):
                amount = None
            desc = str(item.get("Description") or "").strip()
            agency = str(item.get("Awarding Agency") or "").strip()
            headline = f"{matched_sym} contract award"
            if amount is not None:
                headline += f" ${amount:,.0f}"
            if agency:
                headline += f" by {agency}"
            detail = json.dumps({
                "award_id": item.get("Award ID") or None,
                "recipient": recipient,
                "agency": agency or None,
                "description": desc or None,
                "date": item.get("Action Date") or None,
            }, ensure_ascii=False)

            # Stamp the award's action date. The fetch time is only the fallback when
            # the source gives no usable date, and then detail says so.
            action_ns = _action_date_ns(item.get("Action Date"))
            event_ns = action_ns if action_ns is not None else now_ns
            contract_event = {
                "ts_ns": event_ns,
                "kind": "defense_contract",
                "symbol": matched_sym,
                "headline": headline,
                "amount_usd": amount,
                "detail": detail,
                "source": "USASpending.gov",
            }
            results.append(contract_event)
            award_key = (item.get("Award ID"), item.get("Action Date"), matched_sym)
            if award_key in self._stored:
                continue
            self._stored.add(award_key)
            if len(self._stored) > _STORED_KEYS:
                self._stored.clear()
                self._stored.add(award_key)
            self.warehouse.insert_intelligence(
                event_ns,
                "defense_contract",
                matched_sym,
                headline,
                amount,
                detail,
                "USASpending.gov",
            )

        self.last_status = {"source_ok": error is None, "http_status": http_status,
                            "error": error, "rows": len(results)}
        return results


_STORED_KEYS = 50_000


def _action_date_ns(value: object) -> int | None:
    """UTC-midnight ns of a YYYY-MM-DD action date, or None when it is absent or invalid."""
    if not isinstance(value, str):
        return None
    try:
        day = datetime.strptime(value.strip(), "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        return None
    return int(day.timestamp()) * 1_000_000_000
