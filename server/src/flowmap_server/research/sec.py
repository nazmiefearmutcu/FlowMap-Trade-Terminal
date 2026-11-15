"""SEC EDGAR: risk-factor changes and the language of earnings releases.

Two sections, both read from EDGAR, which asks automated clients to name a
contact e-mail in the User-Agent (``FlowMap/<version> <contact>``). The contact
is the user's own, passed in by the service; it is never logged.

- ``risk_factors``: the two newest 10-K or 10-Q filings whose Item 1A (Risk
  Factors) has at least ``MIN_RISK_CHARS`` of text, compared paragraph by
  paragraph: the paragraphs added in the newer filing and those it dropped.
  Paragraphs that contain one of ``TRIGGER_TERMS`` are listed as triggers. The
  diff shows changed text; it does not rate how much a change matters.
- ``management_language``: the two newest 8-K filings with Item 2.02 (results of
  operations) and an EX-99 exhibit (the earnings release). For each release, the
  rate per 1000 words of the hedging terms and of the uncertainty terms below,
  and the change from the previous release. Paragraphs of the safe-harbour
  notice (those mentioning "forward-looking statement") are left out, since that
  boilerplate repeats in every release. The term lists are this module's own,
  short and stated here; they are not a licensed dictionary. This is a measure
  of the written release, not of any audio.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
import difflib
import html
import json
import logging
import re
import time
from typing import Any

from flowmap_server import __version__
from flowmap_server.research.base import Http, SectionResult, failure_reason, result

__all__ = [
    "HEDGING_TERMS",
    "TRIGGER_TERMS",
    "UNCERTAINTY_TERMS",
    "SecSource",
    "html_to_paragraphs",
    "item_1a",
    "language_rates",
    "parse_exhibits",
    "parse_filings",
    "parse_ticker_map",
    "risk_diff",
]

logger = logging.getLogger(__name__)

SOURCE = "SEC EDGAR"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/{name}"

TICKERS_LIMIT = 4 * 1024 * 1024
SUBMISSIONS_LIMIT = 8 * 1024 * 1024
INDEX_LIMIT = 1024 * 1024
DOCUMENT_LIMIT = 24 * 1024 * 1024
TICKERS_TTL_S = 24 * 3600.0
TICKERS_RETRY_S = 60.0
TIMEOUT_S = 30.0

MIN_RISK_CHARS = 500
MAX_FILINGS_READ = 4
MAX_LIST = 40
MAX_PARAGRAPH = 400
NEAR_RATIO = 0.85
NEAR_PREFIX = 600
NEAR_WORDS = 0.6
MAX_NEAR_CHECKS = 20000
MAX_RATIO_CALLS = 150

TRIGGER_TERMS = (
    "going concern", "material weakness", "restatement", "restate", "investigation",
    "subpoena", "default", "impairment", "cybersecurity incident", "export control",
    "litigation", "bankruptcy",
)
HEDGING_TERMS = (
    "may", "might", "could", "approximately", "possibly", "potentially", "potential",
    "believe", "believes", "appear", "appears", "likely", "unlikely", "perhaps",
    "estimate", "estimated", "estimates", "anticipate", "anticipates", "expect", "expects",
    "intend", "intends", "seek", "seeks", "should", "would",
)
UNCERTAINTY_TERMS = (
    "uncertain", "uncertainty", "uncertainties", "volatile", "volatility", "unpredictable",
    "unclear", "unknown", "fluctuate", "fluctuates", "fluctuation", "fluctuations",
    "contingent", "risk", "risks", "challenging", "headwind", "headwinds", "pressure",
    "pressures", "cautious", "caution", "softness", "slowdown", "weakness", "weaker",
)
# Whole words, plurals included ("investigations", "impairments").
_TRIGGERS = tuple(
    (term, re.compile(rf"\b{re.escape(term)}(?:s|es)?\b", re.IGNORECASE)) for term in TRIGGER_TERMS
)
_HEDGING = frozenset(HEDGING_TERMS)
_UNCERTAINTY = frozenset(UNCERTAINTY_TERMS)
_WORD = re.compile(r"[a-z][a-z']*")
_TOKEN = re.compile(r"[a-z0-9']+")
_MONTH_MAY = re.compile(r"\bMay(?=\s+\d)")

_ITEM_1A = re.compile(r"^item\s*1a\b[.:\s-]*", re.IGNORECASE)
# Page numbers and the table-of-contents link repeated on every page.
_PAGE_FURNITURE = re.compile(r"(?i)(?:page\s*)?\d{1,4}|[ivxlc]{1,6}|table of contents|\d{1,4}\s*\|.*")
_ITEM_END = re.compile(r"^item\s*(1b|1c|2|3)\b[.:\s-]*", re.IGNORECASE)
_EXHIBIT_ROW = re.compile(
    r'<a href="(?P<href>/Archives/edgar/data/[^"]+\.html?)"[^>]*>[^<]*</a>[^<]*</td>\s*'
    r'<td[^>]*>(?P<type>EX-99[^<]*)</td>',
    re.IGNORECASE,
)


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_ticker_map(payload: object) -> dict[str, int]:
    """``{ticker: cik}`` from ``company_tickers.json``. Raises ``ValueError`` when empty."""
    if not isinstance(payload, dict):
        raise ValueError("ticker map is not an object")
    out: dict[str, int] = {}
    for row in payload.values():
        if not isinstance(row, dict):
            continue
        ticker = _text(row.get("ticker")).upper().replace("-", ".")
        cik = row.get("cik_str")
        if ticker and isinstance(cik, int) and not isinstance(cik, bool) and cik > 0:
            out.setdefault(ticker, cik)
    if not out:
        raise ValueError("ticker map has no rows")
    return out


def parse_filings(payload: object) -> list[dict[str, str]]:
    """Recent filings, newest first: ``form``, ``date``, ``accession``, ``document``, ``items``."""
    if not isinstance(payload, dict):
        raise ValueError("submissions is not an object")
    filings = payload.get("filings")
    recent = filings.get("recent") if isinstance(filings, dict) else None
    if not isinstance(recent, dict):
        raise ValueError("submissions has no recent filings")
    columns = ("form", "filingDate", "accessionNumber", "primaryDocument", "items")
    lists = [recent.get(name) for name in columns]
    if not all(isinstance(column, list) for column in lists[:4]):
        raise ValueError("submissions columns are missing")
    forms, dates, accessions, documents = (c if isinstance(c, list) else [] for c in lists[:4])
    items = lists[4] if isinstance(lists[4], list) else []
    out = []
    for i in range(min(len(forms), len(dates), len(accessions), len(documents))):
        row = {
            "form": _text(forms[i]),
            "date": _text(dates[i]),
            "accession": _text(accessions[i]),
            "document": _text(documents[i]),
            "items": _text(items[i]) if i < len(items) else "",
        }
        if row["form"] and row["accession"] and row["document"]:
            out.append(row)
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


def parse_exhibits(index_html: str) -> list[tuple[str, str]]:
    """``(type, archive path)`` of the EX-99 documents in a filing index page, in page order."""
    return [(m["type"].strip().upper(), m["href"]) for m in _EXHIBIT_ROW.finditer(index_html)]


def html_to_paragraphs(document: str) -> list[str]:
    """The visible text of an EDGAR HTML document, one paragraph per entry."""
    text = re.sub(r"(?is)<ix:header>.*?</ix:header>", " ", document)
    text = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h[1-6]|table)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    paragraphs = (re.sub(r"\s+", " ", line).strip() for line in text.split("\n"))
    return [p for p in paragraphs if p]


def item_1a(paragraphs: list[str]) -> list[str]:
    """The paragraphs of Item 1A (Risk Factors): the longest span from an Item 1A
    heading to the next Item 1B/1C/2/3 heading (the table of contents gives a
    short span and loses). Empty when there is no such heading."""
    best: list[str] = []
    for start, paragraph in enumerate(paragraphs):
        if not _ITEM_1A.match(paragraph):
            continue
        end = start + 1
        while end < len(paragraphs) and not _ITEM_END.match(paragraphs[end]):
            end += 1
        # Page headers repeat the Item 1A heading inside the section: not risk text.
        span = [p for p in paragraphs[start + 1:end] if not _ITEM_1A.match(p) and not _PAGE_FURNITURE.fullmatch(p)]
        if sum(map(len, span)) > sum(map(len, best)):
            best = span
    return best


def _cut(paragraph: str) -> str:
    return paragraph if len(paragraph) <= MAX_PARAGRAPH else paragraph[: MAX_PARAGRAPH - 1].rstrip() + "…"


def _words(paragraph: str) -> frozenset[str]:
    return frozenset(_TOKEN.findall(paragraph.lower()))


def _near(a: str, b: str, words_a: frozenset[str], words_b: frozenset[str]) -> bool:
    """Two paragraphs that differ only by a few words (a reworded sentence, a new date).

    Cheap gates first: lengths within ``NEAR_RATIO`` of each other, and word sets
    that share at least ``NEAR_WORDS`` of their union. Only then are the first
    ``NEAR_PREFIX`` characters compared, so a call stays cheap whatever the text.
    """
    short, long_ = sorted((len(a), len(b)))
    if long_ == 0 or short / long_ < NEAR_RATIO:
        return False
    union = len(words_a | words_b)
    if union == 0 or len(words_a & words_b) / union < NEAR_WORDS:
        return False
    return True


def _close_text(a: str, b: str) -> bool:
    """The character-level check behind ``_near`` (the costly part, budgeted by the caller)."""
    matcher = difflib.SequenceMatcher(a=a[:NEAR_PREFIX], b=b[:NEAR_PREFIX], autojunk=False)
    return matcher.quick_ratio() >= NEAR_RATIO and matcher.ratio() >= NEAR_RATIO


def _terms(paragraph: str) -> set[str]:
    return {term for term, pattern in _TRIGGERS if pattern.search(paragraph)}


def risk_diff(previous: list[str], current: list[str]) -> dict[str, Any]:
    """Paragraphs added in ``current`` and removed from ``previous``, with triggers.

    Inside each changed block, a removed paragraph with a near-identical added one
    (``NEAR_RATIO``) is a rewording: both leave the lists and count in
    ``modifiedCount``. At most ``MAX_NEAR_CHECKS`` pairs pass the cheap gates and
    ``MAX_RATIO_CALLS`` the character comparison per diff; past that, the remaining
    paragraphs stay as added and removed.

    ``triggers`` are the ``TRIGGER_TERMS`` (whole words) found in an added
    paragraph, or in a reworded paragraph whose previous wording lacked them.
    """
    matcher = difflib.SequenceMatcher(a=previous, b=current, autojunk=False)
    added: list[str] = []
    removed: list[str] = []
    triggers: set[str] = set()
    modified = 0
    checks = 0
    ratio_calls = 0
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            continue
        gone = list(previous[a0:a1])
        new = list(current[b0:b1])
        new_words = {candidate: _words(candidate) for candidate in new}
        for paragraph in list(gone):
            match = None
            paragraph_words = _words(paragraph)
            for candidate in new:
                if checks >= MAX_NEAR_CHECKS:
                    break
                checks += 1
                if not _near(paragraph, candidate, paragraph_words, new_words[candidate]):
                    continue
                if ratio_calls >= MAX_RATIO_CALLS:
                    break
                ratio_calls += 1
                if _close_text(paragraph, candidate):
                    match = candidate
                    break
            if match is not None:
                gone.remove(paragraph)
                new.remove(match)
                modified += 1
                triggers |= _terms(match) - _terms(paragraph)
        removed.extend(gone)
        added.extend(new)
    for paragraph in added:
        triggers |= _terms(paragraph)
    return {
        "added": [_cut(p) for p in added[:MAX_LIST]],
        "removed": [_cut(p) for p in removed[:MAX_LIST]],
        "addedCount": len(added),
        "removedCount": len(removed),
        "modifiedCount": modified,
        "triggers": sorted(triggers),
    }


def language_rates(paragraphs: list[str]) -> dict[str, Any]:
    """Words, hedging and uncertainty terms per 1000 words, and the most used terms."""
    kept = [p for p in paragraphs if "forward-looking statement" not in p.lower()]
    # "May 20" and "May 2026" are the month, not the hedge.
    text = _MONTH_MAY.sub(" ", " ".join(kept))
    words = _WORD.findall(text.lower())
    total = len(words)
    hedging = Counter(w for w in words if w in _HEDGING)
    uncertainty = Counter(w for w in words if w in _UNCERTAINTY)
    per_1k = (lambda n: round(n * 1000.0 / total, 2)) if total else (lambda n: None)
    top = (hedging + uncertainty).most_common(8)
    return {
        "words": total,
        "hedgingPer1k": per_1k(sum(hedging.values())),
        "uncertaintyPer1k": per_1k(sum(uncertainty.values())),
        "topTerms": [{"term": term, "count": count} for term, count in top],
    }


def _risk_section(document: str) -> list[str]:
    return item_1a(html_to_paragraphs(document))


def _release_rates(body: bytes) -> dict[str, Any]:
    return language_rates(html_to_paragraphs(body.decode("utf-8", "replace")))


def _change(new: float | None, old: float | None) -> float | None:
    return round(new - old, 2) if new is not None and old is not None else None


def _folder(accession: str) -> str:
    return accession.replace("-", "")


class SecSource:
    """The two SEC sections. Fetchers can be injected for tests: ``fetch(url, limit, contact) -> bytes``."""

    def __init__(
        self,
        http: Http,
        *,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        fetch: Callable[[str, int, str], Awaitable[bytes]] | None = None,
    ) -> None:
        self._http = http
        self._clock = clock
        self._monotonic = monotonic
        self._fetch = fetch or self._fetch_bytes
        self._tickers: dict[str, int] | None = None
        self._tickers_at: float | None = None
        self._tickers_failed_at: float | None = None
        self._lock = asyncio.Lock()

    async def risk_factors(self, symbol: str, contact: str) -> SectionResult:
        cik = await self._cik(symbol, contact)
        if cik is None:
            return self._answer("risk-factors", symbol, "not_applicable", reason="not_sec_registrant")
        filings = [f for f in await self._filings(cik, contact) if f["form"] in ("10-K", "10-Q")]
        found: list[tuple[dict[str, str], list[str]]] = []
        for filing in filings[:MAX_FILINGS_READ]:
            document = await self._document(cik, filing, filing["document"], contact)
            # Parsing a filing of several MB is CPU work: keep it off the event loop.
            section = await asyncio.to_thread(_risk_section, document)
            if sum(map(len, section)) >= MIN_RISK_CHARS:
                found.append((filing, section))
            if len(found) == 2:
                break
        if len(found) < 2:
            return self._answer("risk-factors", symbol, "empty", reason="fewer_than_two_filings")
        (new, new_text), (old, old_text) = found
        data = {
            "form": new["form"],
            "filedDate": new["date"],
            "previousForm": old["form"],
            "previousFiledDate": old["date"],
            "url": self._index_url(cik, new),
            "previousUrl": self._index_url(cik, old),
            **(await asyncio.to_thread(risk_diff, old_text, new_text)),
        }
        return self._answer("risk-factors", symbol, "ok", data=data, as_of=new["date"])

    async def management_language(self, symbol: str, contact: str) -> SectionResult:
        cik = await self._cik(symbol, contact)
        if cik is None:
            return self._answer("language", symbol, "not_applicable", reason="not_sec_registrant")
        releases = [
            f for f in await self._filings(cik, contact)
            if f["form"] == "8-K" and "2.02" in f["items"].split(",")
        ]
        read: list[tuple[dict[str, str], dict[str, Any], str]] = []
        for filing in releases[:MAX_FILINGS_READ]:
            index_url = self._index_url(cik, filing)
            index_html = (await self._fetch(index_url, INDEX_LIMIT, contact)).decode("utf-8", "replace")
            exhibits = parse_exhibits(index_html)
            if not exhibits:
                continue
            chosen = next((path for kind, path in exhibits if kind == "EX-99.1"), exhibits[0][1])
            body = await self._fetch("https://www.sec.gov" + chosen, DOCUMENT_LIMIT, contact)
            rates = await asyncio.to_thread(_release_rates, body)
            if rates["words"]:
                read.append((filing, rates, "https://www.sec.gov" + chosen))
            if len(read) == 2:
                break
        if not read:
            return self._answer("language", symbol, "empty", reason="no_earnings_release")
        new_filing, new, url = read[0]
        old = read[1][1] if len(read) > 1 else None
        data = {
            "filedDate": new_filing["date"],
            "previousFiledDate": read[1][0]["date"] if old is not None else None,
            "url": url,
            "words": new["words"],
            "hedgingPer1k": new["hedgingPer1k"],
            "uncertaintyPer1k": new["uncertaintyPer1k"],
            "previousHedgingPer1k": old["hedgingPer1k"] if old else None,
            "previousUncertaintyPer1k": old["uncertaintyPer1k"] if old else None,
            "hedgingChange": _change(new["hedgingPer1k"], old["hedgingPer1k"]) if old else None,
            "uncertaintyChange": _change(new["uncertaintyPer1k"], old["uncertaintyPer1k"]) if old else None,
            "topTerms": new["topTerms"],
        }
        return self._answer("language", symbol, "ok", data=data, as_of=new_filing["date"])

    async def close(self) -> None:
        return None

    def _answer(
        self, section: str, symbol: str, status: str, *, data: dict[str, Any] | None = None,
        reason: str | None = None, as_of: str | None = None,
    ) -> SectionResult:
        return result(section, symbol, status, source=SOURCE, fetched_ns=self._clock(),
                      data=data, reason=reason, as_of=as_of)

    async def _cik(self, symbol: str, contact: str) -> int | None:
        """The CIK of a ticker. The ticker map is read once a day; a failed refresh
        keeps the previous map (or raises when there is none) and is not tried again
        for ``TICKERS_RETRY_S``."""
        async with self._lock:
            due = self._tickers_at is None or self._monotonic() - self._tickers_at >= TICKERS_TTL_S
            waiting = self._tickers_failed_at is not None and self._monotonic() - self._tickers_failed_at < TICKERS_RETRY_S
            if due and not waiting:
                try:
                    body = await self._fetch(TICKERS_URL, TICKERS_LIMIT, contact)
                    self._tickers = await asyncio.to_thread(lambda: parse_ticker_map(json.loads(body)))
                    self._tickers_at = self._monotonic()
                    self._tickers_failed_at = None
                except Exception as exc:
                    self._tickers_failed_at = self._monotonic()
                    logger.warning("SEC ticker map refresh failed: %s", failure_reason(exc))
                    if self._tickers is None:
                        raise
            tickers = self._tickers
        if tickers is None:
            raise ConnectionError("SEC ticker map not read yet")
        return tickers.get(symbol.upper())

    async def _filings(self, cik: int, contact: str) -> list[dict[str, str]]:
        body = await self._fetch(SUBMISSIONS_URL.format(cik=cik), SUBMISSIONS_LIMIT, contact)
        return await asyncio.to_thread(lambda: parse_filings(json.loads(body)))

    async def _document(self, cik: int, filing: dict[str, str], name: str, contact: str) -> str:
        url = ARCHIVE_URL.format(cik=cik, folder=_folder(filing["accession"]), name=name)
        return (await self._fetch(url, DOCUMENT_LIMIT, contact)).decode("utf-8", "replace")

    @staticmethod
    def _index_url(cik: int, filing: dict[str, str]) -> str:
        return ARCHIVE_URL.format(
            cik=cik, folder=_folder(filing["accession"]), name=f"{filing['accession']}-index.html"
        )

    async def _fetch_bytes(self, url: str, limit: int, contact: str) -> bytes:
        return await self._http.get_bytes(
            url, limit=limit, timeout_s=TIMEOUT_S,
            headers={"User-Agent": f"FlowMap/{__version__} {contact}", "Accept-Encoding": "gzip, deflate"},
        )

