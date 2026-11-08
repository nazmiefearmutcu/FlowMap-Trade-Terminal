"""Congressional stock disclosure watcher (GOV <GO>), House only.

The single source is the House Stock Watcher open JSON dataset:
  https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json
It carries House disclosures only; Senate filings are not read. Each event is
stamped with its transaction date, not the time it was fetched. The latest
transaction date in the dataset is reported with every fetch so a stale third-party
snapshot is visible.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
import json
import logging
import time
from typing import Any

import aiohttp

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.warehouse_share import shared_warehouse

log = logging.getLogger(__name__)

_HOUSE_TRANSACTIONS_URL = (
    "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json"
)


_MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class CapitolTradesWatcher:
    """Monitors House stock disclosures by members of Congress."""

    def __init__(self, warehouse: DuckWarehouse | None = None) -> None:
        self.warehouse = warehouse or shared_warehouse()
        self._session: aiohttp.ClientSession | None = None
        # Outcome of the latest fetch, so an outage can be told apart from an
        # empty lookback window. fetch_recent_trades still returns only the rows.
        self.last_status: dict[str, Any] = {}
        # Filings already stored by this process, so repeated polls do not re-insert them.
        self._stored: set[tuple[object, ...]] = set()
        # ETag and parsed body of the last successful download (see fetch_recent_trades).
        self._etag: str | None = None
        self._raw: list[Any] | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-CapitolWatcher/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_recent_trades(
        self,
        lookback_days: int = 30,
        symbols: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch and parse House stock disclosures inside the lookback window."""
        session = await self._get_session()
        raw_data: object = None
        http_status: int | None = None
        error: str | None = None
        # Conditional GET: an unchanged dataset (304) reuses the parsed copy from the last fetch.
        headers = {"If-None-Match": self._etag} if self._etag and self._raw is not None else {}

        try:
            async with session.get(
                _HOUSE_TRANSACTIONS_URL, headers=headers, timeout=aiohttp.ClientTimeout(total=20)
            ) as resp:
                http_status = resp.status
                if resp.status == 304 and self._raw is not None:
                    raw_data = self._raw
                elif resp.status == 200:
                    if (getattr(resp, "content_length", None) or 0) > _MAX_RESPONSE_BYTES:
                        error = "response_too_large"
                    else:
                        body = await _read_capped(resp, _MAX_RESPONSE_BYTES)
                        if body is None:
                            error = "response_too_large"
                        else:
                            try:
                                raw_data = json.loads(body)
                            except ValueError:
                                error = "malformed_response"
                            else:
                                if isinstance(raw_data, list):
                                    # Only a usable dataset is kept for conditional re-fetches.
                                    self._raw = raw_data
                                    self._etag = _etag_of(resp)
                else:
                    error = f"http_{resp.status}"
                    log.warning("Capitol transactions returned status %d", resp.status)
        except Exception as exc:
            error = "unreachable"
            log.warning("Failed querying Congressional Stock Watcher: %s", exc)

        if not isinstance(raw_data, list):
            if error is None:
                error = "malformed_response"
            self.last_status = {
                "source_ok": False, "http_status": http_status, "error": error,
                "parsed_count": 0, "skipped_count": 0, "latest_transaction_date": None,
            }
            return []

        results: list[dict[str, Any]] = []
        now = datetime.now(UTC)
        cutoff = (now - timedelta(days=lookback_days)).date()
        now_ns = time.time_ns()
        skipped = 0
        parsed_count = 0

        sym_filter = {s.strip().upper() for s in symbols} if symbols is not None else None

        # The dataset's own freshness is reported whatever the filters keep.
        dates = [_parse_transaction_date(item) for item in raw_data if isinstance(item, dict)]
        latest_dataset = max((d for d in dates if d is not None), default=None)

        for item in raw_data:
            if not isinstance(item, dict):
                skipped += 1
                continue
            ticker = str(item.get("ticker") or "").strip().upper()
            if not ticker or ticker == "--":
                continue
            if sym_filter is not None and ticker not in sym_filter:
                continue

            trans_date = str(item.get("transaction_date", ""))
            parsed_date = _parse_transaction_date(item)
            if parsed_date is None:
                skipped += 1
                continue
            if not cutoff <= parsed_date <= now.date():
                continue
            parsed_count += 1

            rep = str(item.get("representative") or "").strip()
            ttype = str(item.get("type") or "").strip().lower()
            amount_str = str(item.get("amount") or "").strip()
            party = str(item.get("party") or "").strip()
            state = str(item.get("state") or "").strip()

            headline = f"🏛️ {rep or 'Representative unavailable'} {ttype.upper() or 'TRANSACTION'}: {ticker}"
            if amount_str:
                headline += f" ({amount_str})"
            detail = json.dumps({
                "politician": rep or None,
                "chamber": "House",
                "type": ttype.title() if ttype else None,
                "amount_range": amount_str or None,
                "date": parsed_date.isoformat(),
                "transaction_date": trans_date,
                "disclosure_date": item.get("disclosure_date") or None,
                "party": party or None,
                "state": state or None,
                "ingested_ns": now_ns,
            }, ensure_ascii=False)
            # The event is stamped with the transaction date. Fetch time lives in detail.
            event_ns = _utc_midnight_ns(parsed_date)

            ev = {
                "ts_ns": event_ns,
                "kind": "capitol",
                "symbol": ticker,
                "headline": headline,
                # Disclosures report a range, not an exact transaction amount.
                "amount_usd": None,
                "detail": detail,
                "source": "House Stock Watcher",
            }
            results.append(ev)
            # Every poll re-reads the same lookback window; store each filing once per process.
            key = (ticker, trans_date, rep, ttype, amount_str)
            if key in self._stored:
                continue
            self._stored.add(key)
            if len(self._stored) > _STORED_KEYS:
                self._stored.clear()
                self._stored.add(key)
            self.warehouse.insert_intelligence(
                event_ns,
                "capitol",
                ticker,
                headline,
                None,
                detail,
                "House Stock Watcher",
            )

        self.last_status = {
            "source_ok": True,
            "http_status": http_status,
            "error": None,
            "parsed_count": parsed_count,
            "skipped_count": skipped,
            "latest_transaction_date": latest_dataset.isoformat() if latest_dataset else None,
        }
        return results


_STORED_KEYS = 50_000


async def _read_capped(resp: Any, limit: int) -> bytes | None:
    """The response body, or None once it runs past *limit* (reading stops there)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in resp.content.iter_chunked(64 * 1024):
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _etag_of(resp: Any) -> str | None:
    headers = getattr(resp, "headers", None)
    value = headers.get("ETag") if headers is not None else None
    return value or None


def _parse_transaction_date(item: object) -> date | None:
    if not isinstance(item, dict):
        return None
    text = str(item.get("transaction_date", ""))
    for date_format in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, date_format).date()
        except ValueError:
            continue
    return None


def _utc_midnight_ns(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp()) * 1_000_000_000
