"""House members' stock transactions, from the Clerk's Periodic Transaction Reports.

The House Clerk publishes, per year, an index of financial disclosure filings
(``{YEAR}FD.zip`` holding ``{YEAR}FD.txt``) and each Periodic Transaction Report
(filing type ``P``) as a PDF. Electronically filed reports carry text, read here
with ``pypdf``; scanned paper reports carry none and are counted as unreadable.

A row is read from the report's text when it has the full shape
``(TICKER) [XX] <type> <transaction date> <notification date> <amount range>``.
Rows without a ticker (Treasury bills, funds without one) are not read. The
asset's name is not kept: in the text it runs into the previous row's
sub-holding note with no separator, so it cannot be cut out reliably. The owner
(the member, a spouse, a joint account or a dependent child) is not read for the
same reason, and every answer says so (``ownerKnown: false``): the linked report
names the owner of each row.

A member's committees come from the public-domain ``congress-legislators``
dataset, matched by last name, state and district.

Work happens in one background task, started by the first request: it reads the
current and previous year's index (again every ``INDEX_TTL_S``), then reads the
reports it has not read yet, newest first: ``REPORTS_PER_PASS`` reports one every
``REPORT_PAUSE_S`` seconds, then a pause of ``BATCH_PAUSE_S``, so a cold start
asks the House site for at most about 480 reports an hour. Parsing runs in a
worker thread, off the event loop.
Parsed rows are kept on disk under ``data_dir/house-ptr/{year}/{DocID}.json``
(the PDF itself is not kept), so a restart does not read them again; a file
written by another ``PARSER_VERSION`` is read again from the House site. A request
answers from what has been read so far and says how far that is (``coverage``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
import io
import json
import logging
from pathlib import Path
import re
import time
from typing import Any
import zipfile

from flowmap_server.research.base import (
    Http,
    SectionResult,
    SectionUnavailable,
    failure_reason,
    result,
)

__all__ = [
    "HouseTradesSource",
    "IndexRow",
    "parse_committees",
    "parse_index",
    "parse_legislators",
    "parse_report_text",
    "report_rows",
]

logger = logging.getLogger(__name__)

SOURCE = "House Clerk"
INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip"
REPORT_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"
LEGISLATORS_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
MEMBERSHIP_URL = "https://unitedstates.github.io/congress-legislators/committee-membership-current.json"
COMMITTEES_URL = "https://unitedstates.github.io/congress-legislators/committees-current.json"

INDEX_LIMIT = 5 * 1024 * 1024
REPORT_LIMIT = 2 * 1024 * 1024
INDEX_TEXT_LIMIT = 32 * 1024 * 1024
LEGISLATORS_LIMIT = 8 * 1024 * 1024
INDEX_TTL_S = 6 * 3600.0
INDEX_RETRY_S = 300.0
REPORT_PAUSE_S = 1.0
REPORTS_PER_PASS = 40
MAX_REPORT_ATTEMPTS = 3
BATCH_PAUSE_S = 300.0
MEMBERS_TTL_S = 24 * 3600.0
# Saved rows record the parser that read them; rows of another version are read again.
PARSER_VERSION = 1
FIRST_INDEX_WAIT_S = 15.0
MAX_TRADES = 25

TYPES = {"P": "Purchase", "S": "Sale", "S (partial)": "Partial sale", "E": "Exchange"}
_ROW = re.compile(
    r"\((?P<ticker>[A-Z][A-Z0-9.]{0,9})\)\s*\[(?P<kind>[A-Z]{2})\]\s*"
    r"(?P<type>S \(partial\)|P|S|E)\s+"
    r"(?P<tdate>\d{2}/\d{2}/\d{4})\s+(?P<ndate>\d{2}/\d{2}/\d{4})\s+"
    r"(?P<amount>\$[\d,]+\s*-\s*\$[\d,]+|Over \$[\d,]+|\$[\d,]+)"
)
_STATE_DISTRICT = re.compile(r"([A-Z]{2})(\d{1,2})")
_NAME_PART = re.compile(r"[^a-z]")


@dataclass(frozen=True)
class IndexRow:
    doc_id: str
    year: int
    member: str
    last: str
    state: str
    district: int | None
    filing_date: str


def _us_date(value: str) -> str | None:
    try:
        return datetime.strptime(value.strip(), "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def parse_index(text: str, year: int) -> list[IndexRow]:
    """Periodic Transaction Report rows of one year's ``FD.txt`` (tab-separated, with a header)."""
    lines = text.splitlines()
    if not lines:
        raise ValueError("empty index")
    header = [h.strip() for h in lines[0].split("\t")]
    try:
        col = {name: header.index(name) for name in ("Last", "First", "Suffix", "FilingType", "StateDst", "FilingDate", "DocID")}
    except ValueError as exc:
        raise ValueError("index header changed") from exc
    rows: list[IndexRow] = []
    for line in lines[1:]:
        cells = [c.strip() for c in line.split("\t")]
        if len(cells) <= max(col.values()) or cells[col["FilingType"]] != "P":
            continue
        doc_id = cells[col["DocID"]]
        filed = _us_date(cells[col["FilingDate"]])
        if not doc_id.isdigit() or filed is None:
            continue
        match = _STATE_DISTRICT.fullmatch(cells[col["StateDst"]])
        member = " ".join(p for p in (cells[col["First"]], cells[col["Last"]], cells[col["Suffix"]]) if p)
        rows.append(IndexRow(
            doc_id=doc_id, year=year, member=member, last=cells[col["Last"]],
            state=match.group(1) if match else cells[col["StateDst"]][:2],
            district=int(match.group(2)) if match else None, filing_date=filed,
        ))
    return rows


def parse_report_text(text: str) -> list[dict[str, Any]]:
    """Transaction rows of one report's extracted text."""
    flat = re.sub(r"\s+", " ", text)
    rows = []
    for m in _ROW.finditer(flat):
        transaction = _us_date(m["tdate"])
        if transaction is None:
            continue
        rows.append({
            "ticker": m["ticker"],
            "assetType": m["kind"],
            "type": TYPES[m["type"]],
            "transactionDate": transaction,
            "notificationDate": _us_date(m["ndate"]),
            "amount": re.sub(r"\s*-\s*", " - ", m["amount"]),
        })
    return rows


def report_rows(pdf: bytes) -> tuple[list[dict[str, Any]], bool]:
    """``(rows, readable)`` of one report PDF; a PDF with no text is not readable."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf))
    text = " ".join((page.extract_text() or "") for page in reader.pages)
    if len(text.strip()) < 40:
        return [], False
    return parse_report_text(text), True


def _norm(name: str) -> str:
    return _NAME_PART.sub("", name.lower())


def parse_legislators(payload: object) -> dict[tuple[str, str, int], str]:
    """``{(last name, state, district): bioguide}`` for current House members."""
    if not isinstance(payload, list):
        raise ValueError("legislators is not a list")
    out: dict[tuple[str, str, int], str] = {}
    for person in payload:
        if not isinstance(person, dict):
            continue
        terms = person.get("terms")
        ids = person.get("id")
        name = person.get("name")
        if not (isinstance(terms, list) and terms and isinstance(ids, dict) and isinstance(name, dict)):
            continue
        term = terms[-1]
        if not isinstance(term, dict) or term.get("type") != "rep":
            continue
        bioguide, last = ids.get("bioguide"), name.get("last")
        state, district = term.get("state"), term.get("district")
        if isinstance(bioguide, str) and isinstance(last, str) and isinstance(state, str) and isinstance(district, int):
            out[(_norm(last), state, district)] = bioguide
    return out


def parse_committees(membership: object, committees: object) -> dict[str, list[str]]:
    """``{bioguide: [committee name, ...]}`` for full House committees (no subcommittees)."""
    if not isinstance(membership, dict) or not isinstance(committees, list):
        raise ValueError("committee data has the wrong shape")
    names: dict[str, str] = {}
    for committee in committees:
        if isinstance(committee, dict) and committee.get("type") == "house":
            cid, name = committee.get("thomas_id"), committee.get("name")
            if isinstance(cid, str) and isinstance(name, str):
                names[cid] = re.sub(r"^House (Permanent Select )?Committee on (the )?", "", name).strip()
    out: dict[str, list[str]] = {}
    for cid, members in membership.items():
        if cid not in names or not isinstance(members, list):
            continue
        for member in members:
            if isinstance(member, dict) and isinstance(member.get("bioguide"), str):
                out.setdefault(member["bioguide"], []).append(names[cid])
    return {k: sorted(set(v)) for k, v in out.items()}


def _index_rows(body: bytes, year: int) -> list[IndexRow]:
    """Rows of one year's ``FD.zip``; the text member is refused past ``INDEX_TEXT_LIMIT``."""
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        info = next((i for i in archive.infolist() if i.filename.lower().endswith("fd.txt")), None)
        if info is None:
            raise ValueError("index archive has no FD.txt")
        if info.file_size > INDEX_TEXT_LIMIT:
            raise ValueError(f"index text is over the {INDEX_TEXT_LIMIT} byte limit")
        return parse_index(archive.read(info).decode("utf-8-sig", "replace"), year)


def _located(trade: dict[str, Any], row: IndexRow) -> dict[str, Any]:
    """A report row with the member and report it came from."""
    return {
        **trade,
        "member": row.member,
        "last": row.last,
        "state": row.state,
        "district": row.district,
        "filedDate": row.filing_date,
        "reportUrl": REPORT_URL.format(year=row.year, doc_id=row.doc_id),
    }


Fetch = Callable[[str, int], Awaitable[bytes]]


class HouseTradesSource:
    """The House trades section and its background reader."""

    def __init__(
        self,
        http: Http,
        *,
        data_dir: Path | None = None,
        clock: Callable[[], int] = time.time_ns,
        fetch: Fetch | None = None,
        pause_s: float = REPORT_PAUSE_S,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http
        self._dir = data_dir / "house-ptr" if data_dir is not None else None
        self._clock = clock
        self._fetch = fetch or self._fetch_bytes
        self._pause_s = pause_s
        self._monotonic = monotonic
        self._index: list[IndexRow] = []
        self._index_ready = asyncio.Event()
        self._index_error: Exception | None = None
        self._members_at: float | None = None
        self._done: dict[str, bool] = {}  # DocID -> readable
        self._rows: dict[str, list[dict[str, Any]]] = {}  # DocID -> parsed rows
        self._attempts: dict[str, int] = {}  # DocID -> failed reads so far
        self._by_ticker: dict[str, list[dict[str, Any]]] = {}
        self._members: dict[tuple[str, str, int], str] = {}
        self._committees: dict[str, list[str]] = {}
        self._task: asyncio.Task[None] | None = None

    async def trades(self, symbol: str) -> SectionResult:
        await self.start()
        if not self._index_ready.is_set():
            try:
                await asyncio.wait_for(self._index_ready.wait(), timeout=FIRST_INDEX_WAIT_S)
            except TimeoutError:
                if self._index_error is not None:
                    raise self._index_error from None
                raise SectionUnavailable("index_loading") from None
        rows = sorted(self._by_ticker.get(symbol.upper(), []),
                      key=lambda r: (r["transactionDate"], r["filedDate"]), reverse=True)
        total = len(self._index)
        parsed = sum(1 for row in self._index if row.doc_id in self._done)
        unreadable = sum(1 for row in self._index if self._done.get(row.doc_id) is False)
        data = {
            "trades": [self._with_member(row) for row in rows[:MAX_TRADES]],
            "tradeCount": len(rows),
            "coverage": {"parsed": parsed, "total": total, "unreadable": unreadable},
            "years": sorted({row.year for row in self._index}),
            # The owner of a row (member, spouse, joint, child) is not read; see the report.
            "ownerKnown": False,
        }
        newest = max((row.filing_date for row in self._index if row.doc_id in self._done), default=None)
        return result("house-trades", symbol, "ok", source=SOURCE, fetched_ns=self._clock(),
                      data=data, as_of=newest)

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="house-ptr-reader")

    async def close(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _with_member(self, row: dict[str, Any]) -> dict[str, Any]:
        bioguide = self._members.get((_norm(row["last"]), row["state"], row["district"])) if row["district"] is not None else None
        out = {k: v for k, v in row.items() if k != "last"}
        out["committees"] = self._committees.get(bioguide, []) if bioguide else []
        return out

    async def _run(self) -> None:
        await asyncio.to_thread(self._load_disk)
        while True:
            loaded_at = self._monotonic()
            try:
                await self._load_index()
            except Exception as exc:
                self._index_error = exc
                logger.warning("house report index read failed: %s", failure_reason(exc))
                await asyncio.sleep(INDEX_RETRY_S)
                continue
            if self._members_at is None or self._monotonic() - self._members_at >= MEMBERS_TTL_S:
                try:
                    await self._load_members()
                    self._members_at = self._monotonic()
                except Exception as exc:  # committees are extra: rows still show without them
                    logger.warning("house committee data read failed: %s", failure_reason(exc))
            while self._monotonic() - loaded_at < INDEX_TTL_S:
                pending = [row for row in sorted(self._index, key=lambda r: r.filing_date, reverse=True)
                           if row.doc_id not in self._done][:REPORTS_PER_PASS]
                if not pending:
                    break
                for row in pending:
                    await self._read_report(row)
                    await asyncio.sleep(self._pause_s)
                await asyncio.sleep(BATCH_PAUSE_S)
            await asyncio.sleep(max(0.0, INDEX_TTL_S - (self._monotonic() - loaded_at)))

    async def _load_index(self) -> None:
        year = datetime.fromtimestamp(self._clock() / 1e9, UTC).year
        rows: list[IndexRow] = []
        for y in (year, year - 1):
            body = await self._fetch(INDEX_URL.format(year=y), INDEX_LIMIT)
            rows.extend(await asyncio.to_thread(_index_rows, body, y))
        self._index = rows
        self._index_error = None
        self._index_ready.set()
        self._rebuild()

    async def _load_members(self) -> None:
        legislators = await self._fetch(LEGISLATORS_URL, LEGISLATORS_LIMIT)
        membership = await self._fetch(MEMBERSHIP_URL, LEGISLATORS_LIMIT)
        committees = await self._fetch(COMMITTEES_URL, LEGISLATORS_LIMIT)
        self._members, self._committees = await asyncio.to_thread(
            lambda: (parse_legislators(json.loads(legislators)),
                     parse_committees(json.loads(membership), json.loads(committees))))

    async def _read_report(self, row: IndexRow) -> None:
        try:
            body = await self._fetch(REPORT_URL.format(year=row.year, doc_id=row.doc_id), REPORT_LIMIT)
            rows, readable = await asyncio.to_thread(report_rows, body)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A report that cannot be read now is tried again on a later pass; after
            # MAX_REPORT_ATTEMPTS failures (or at once when it is too large, malformed or
            # gone) it counts as unreadable so it cannot hold up the reports behind it.
            reason = failure_reason(exc)
            logger.warning("house report read failed: %s", reason)
            attempts = self._attempts.get(row.doc_id, 0) + 1
            self._attempts[row.doc_id] = attempts
            if attempts >= MAX_REPORT_ATTEMPTS or reason in ("too_large", "malformed", "http_404"):
                self._done[row.doc_id] = False
                self._save(row, [], False)
            return
        self._done[row.doc_id] = readable
        self._save(row, rows, readable)
        for trade in rows:
            self._by_ticker.setdefault(trade["ticker"], []).append(_located(trade, row))

    def _rebuild(self) -> None:
        by_ticker: dict[str, list[dict[str, Any]]] = {}
        for row in self._index:
            for trade in self._rows.get(row.doc_id, []):
                by_ticker.setdefault(trade["ticker"], []).append(_located(trade, row))
        self._by_ticker = by_ticker

    def _save(self, row: IndexRow, rows: list[dict[str, Any]], readable: bool) -> None:
        self._rows[row.doc_id] = rows
        if self._dir is None:
            return
        try:
            folder = self._dir / str(row.year)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{row.doc_id}.json").write_text(
                json.dumps({"parser": PARSER_VERSION, "readable": readable, "rows": rows}), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("house report cache write failed: %s", type(exc).__name__)

    def _load_disk(self) -> None:
        if self._dir is None or not self._dir.is_dir():
            return
        for path in self._dir.glob("*/*.json"):
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
                rows = saved["rows"]
                readable = saved["readable"]
                if saved.get("parser") != PARSER_VERSION:
                    continue
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
            if isinstance(rows, list) and isinstance(readable, bool):
                self._done[path.stem] = readable
                self._rows[path.stem] = [r for r in rows if isinstance(r, dict) and isinstance(r.get("ticker"), str)]

    async def _fetch_bytes(self, url: str, limit: int) -> bytes:
        return await self._http.get_bytes(url, limit=limit, timeout_s=30.0)
