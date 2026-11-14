"""Research source: US government contracts won by a company, from USAspending.gov.

The company is looked up by its name (``names.py``) with the legal-form words
removed, and USAspending is searched for award recipients of that name over the
last 365 days (contract award types A to D). Only the awards whose recipient name
contains the company's core name as whole words are kept: ``Lockheed Martin
Corporation`` matches ``LOCKHEED MARTIN SPACE`` but not ``MARTIN MARIETTA``.

What the figures mean:

- Only the 25 largest search hits (by award amount, one page) are read. A company's
  smaller awards beyond those 25 hits are never seen, so the ranking is not a full
  ranking of the company's awards.
- ``awards`` lists at most 10 of the matched awards, largest amount first. A matched
  award with no numeric amount is listed last with ``amount`` None.
- ``listedTotal`` is the sum of the amounts of the awards in ``awards`` (None-amount
  awards left out). It is None when no listed award has an amount. It is not the
  company's total.
- ``matchedCount`` is how many of the rows read matched the company, before the cap
  of 10.

Keyless; no figure is estimated.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
import math
import time
from typing import Any
from urllib.parse import quote

from flowmap_server.research.base import Http, SectionResult, result
from flowmap_server.research.names import CompanyNames, legal_core

__all__ = ["ContractsSource"]

SECTION = "contracts"
SOURCE = "USAspending.gov"
SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
BODY_LIMIT = 4 * 1024 * 1024
TIMEOUT_S = 20.0
WINDOW_DAYS = 365
# USAspending award type codes A to D: BPA calls, purchase orders, delivery orders
# and definitive contracts. IDVs use the separate IDV_* codes and are not searched.
AWARD_TYPE_CODES = ["A", "B", "C", "D"]
FIELDS = [
    "Award ID",
    "Recipient Name",
    "Awarding Agency",
    "Awarding Sub Agency",
    "Award Amount",
    "Start Date",
    "Description",
    "generated_internal_id",
]
SEARCH_LIMIT = 25
MAX_AWARDS = 10
DESCRIPTION_MAX = 300
AWARD_URL = "https://www.usaspending.gov/award/{}"


@dataclass(frozen=True)
class _Award:
    award_id: str | None
    recipient: str
    agency: str | None
    sub_agency: str | None
    amount: float | None
    start_date: str | None
    description: str | None
    url: str | None

    def as_data(self) -> dict[str, Any]:
        return {
            "awardId": self.award_id,
            "recipient": self.recipient,
            "agency": self.agency,
            "subAgency": self.sub_agency,
            "amount": self.amount,
            "startDate": self.start_date,
            "description": self.description,
            "url": self.url,
        }


class ContractsSource:
    """Federal contract awards for one US company, read from USAspending."""

    def __init__(self, http: Http, names: CompanyNames, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._names = names
        self._clock = clock

    async def contracts(self, symbol: str) -> SectionResult:
        """The company's largest awards in the last year; ``empty`` when none match."""
        fetched_ns = self._clock()
        today = _utc_date(fetched_ns)
        name = await self._names.name(symbol)
        company = legal_core(name) if name is not None else ""
        if not company:
            return result(
                SECTION, symbol, "not_applicable", source=SOURCE, fetched_ns=fetched_ns,
                reason="unknown_company",
            )
        reply = await self._http.post_json(
            SEARCH_URL, build_payload(company, today), limit=BODY_LIMIT, timeout_s=TIMEOUT_S
        )
        matched = _matched_awards(parse_awards(reply), company)
        if not matched:
            return result(
                SECTION, symbol, "empty", source=SOURCE, fetched_ns=fetched_ns,
                reason="no_awards", as_of=today.isoformat(),
            )
        listed = matched[:MAX_AWARDS]
        amounts = [award.amount for award in listed if award.amount is not None]
        return result(
            SECTION, symbol, "ok", source=SOURCE, fetched_ns=fetched_ns, as_of=today.isoformat(),
            data={
                "query": company,
                "windowDays": WINDOW_DAYS,
                "listedTotal": sum(amounts) if amounts else None,
                "matchedCount": len(matched),
                "awards": [award.as_data() for award in listed],
                "source": SOURCE,
            },
        )

    async def close(self) -> None:
        return None


def build_payload(query: str, today: date) -> dict[str, Any]:
    """The spending_by_award request for a recipient search over the window ending ``today``."""
    start = today - timedelta(days=WINDOW_DAYS)
    return {
        "filters": {
            "recipient_search_text": [query],
            "award_type_codes": list(AWARD_TYPE_CODES),
            "time_period": [{"start_date": start.isoformat(), "end_date": today.isoformat()}],
        },
        "fields": list(FIELDS),
        "sort": "Award Amount",
        "order": "desc",
        "limit": SEARCH_LIMIT,
        "page": 1,
    }


def parse_awards(reply: object) -> list[_Award]:
    """The awards in a spending_by_award reply. Rows without a recipient name are skipped.

    A row whose award amount is null or not a finite number keeps ``amount`` None
    instead of failing the reply. Raises ``ValueError`` only when the reply has no
    ``results`` list or a row is not an object.
    """
    if not isinstance(reply, dict):
        raise ValueError("reply is not an object")
    rows = reply.get("results")
    if not isinstance(rows, list):
        raise ValueError("reply has no results list")
    awards: list[_Award] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("award row is not an object")
        recipient = _text(row.get("Recipient Name"))
        if recipient is None:
            continue
        generated_id = _text(row.get("generated_internal_id"))
        description = _text(row.get("Description"))
        awards.append(
            _Award(
                award_id=_text(row.get("Award ID")),
                recipient=recipient,
                agency=_text(row.get("Awarding Agency")),
                sub_agency=_text(row.get("Awarding Sub Agency")),
                amount=_amount(row.get("Award Amount")),
                start_date=_text(row.get("Start Date")),
                description=description[:DESCRIPTION_MAX] if description is not None else None,
                url=AWARD_URL.format(quote(generated_id, safe="")) if generated_id is not None else None,
            )
        )
    return awards


def _matched_awards(awards: list[_Award], company: str) -> list[_Award]:
    """Awards whose recipient's core name contains ``company`` as whole words.

    Largest amount first; an award with no amount comes after every award with one.
    """
    needle = f" {company} "
    matched = [a for a in awards if needle in f" {legal_core(a.recipient)} "]
    with_amount = sorted((a for a in matched if a.amount is not None), key=lambda a: a.amount or 0.0, reverse=True)
    without = [a for a in matched if a.amount is None]
    return with_amount + without


def _amount(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _utc_date(ns: int) -> date:
    return datetime.fromtimestamp(ns // 1_000_000_000, tz=UTC).date()
