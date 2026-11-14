"""Hiring activity per company from the public job boards it publishes on.

Three keyless board APIs are read: Greenhouse (``boards-api.greenhouse.io``),
Lever (``api.lever.co``) and Ashby (``api.ashbyhq.com``). A company is found in
``CURATED_BOARDS`` first, else by Greenhouse discovery from slug candidates built
from its SEC name. Companies on none of these boards are ``not_applicable``.

Counts come from each posting's date: Greenhouse ``first_published`` (the first
publish date), Ashby ``publishedAt``, and Lever ``createdAt``, which is the posting's
creation time, the closest date Lever gives. Updated dates are never used for the
30-day windows. When any posting of a board has no date, the windows are None rather
than a partial count.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import re
import time
from typing import Any, Protocol

import aiohttp

from flowmap_server.research.base import SectionResult, result
from flowmap_server.research.names import legal_core

__all__ = ["CURATED_BOARDS", "HiringSource"]

SECTION = "hiring"
READ_LIMIT = 16 * 1024 * 1024
WINDOW_S = 30 * 86400.0
MEMORY_NS = 7 * 86400 * 1_000_000_000
DISCOVERY_CANDIDATES = 3
STATUS_BAND_PCT = 10.0

GREENHOUSE_BOARD_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}"
GREENHOUSE_JOBS_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
LEVER_POSTINGS_URL = "https://api.lever.co/v0/postings/{slug}"
ASHBY_BOARD_URL = "https://api.ashbyhq.com/posting-api/job-board/{slug}"
PUBLIC_PAGE_URL = {
    "greenhouse": "https://boards.greenhouse.io/{slug}",
    "lever": "https://jobs.lever.co/{slug}",
    "ashby": "https://jobs.ashbyhq.com/{slug}",
}
SOURCE_NAME = {"greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby"}
NOT_APPLICABLE_SOURCE = "Public job boards"

# Whole-word R&D keywords, case-insensitive. Plurals and the -er form of "research"
# (Researcher, Researchers) count; "Datadog" does not count as "data".
_RD_WORDS = re.compile(
    r"(?<![A-Za-z0-9])(?:engineer(?:s|ing)?|research(?:er|ers)?|scientists?|data|"
    r"machine\s+learning|ml|ai|hardware|software|developers?|r&d)(?![A-Za-z0-9])",
    re.IGNORECASE,
)

# Large US-listed companies whose board was checked live on 2026-11-15: the board
# answered, and its own name (Greenhouse board ``name``, or the Lever/Ashby careers
# page title) matched the company name in the Nasdaq listing under ``legal_core``.
# Lever and Ashby postings carry no company name, so their boardName is None.
# NU (board "Nubank", listed "Nu Holdings Ltd.") and ROKU (not in the listing)
# were checked and left out.
CURATED_BOARDS: dict[str, tuple[str, str]] = {
    "DDOG": ("greenhouse", "datadog"),
    "NET": ("greenhouse", "cloudflare"),
    "MDB": ("greenhouse", "mongodb"),
    "ABNB": ("greenhouse", "airbnb"),
    "PINS": ("greenhouse", "pinterest"),
    "HOOD": ("greenhouse", "robinhood"),
    "COIN": ("greenhouse", "coinbase"),
    "LYFT": ("greenhouse", "lyft"),
    "RBLX": ("greenhouse", "roblox"),
    "TWLO": ("greenhouse", "twilio"),
    "OKTA": ("greenhouse", "okta"),
    "ZS": ("greenhouse", "zscaler"),
    "RDDT": ("greenhouse", "reddit"),
    "AFRM": ("greenhouse", "affirm"),
    "XYZ": ("greenhouse", "block"),
    "GTLB": ("greenhouse", "gitlab"),
    "ESTC": ("greenhouse", "elastic"),
    "BILL": ("greenhouse", "billcom"),
    "TOST": ("greenhouse", "toast"),
    "SOFI": ("greenhouse", "sofi"),
    "DUOL": ("greenhouse", "duolingo"),
    "IOT": ("greenhouse", "samsara"),
    "APP": ("greenhouse", "applovin"),
    "ASAN": ("greenhouse", "asana"),
    "CPNG": ("greenhouse", "coupang"),
    "PLTR": ("lever", "palantir"),
    "SPOT": ("lever", "spotify"),
    "SNOW": ("ashby", "snowflake"),
}


class _Fetcher(Protocol):
    """The part of ``Http`` this source uses (tests pass a fake)."""

    async def get_json(
        self,
        url: str,
        *,
        limit: int,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
    ) -> object: ...


class _Names(Protocol):
    """The part of ``CompanyNames`` this source uses."""

    async def name(self, symbol: str) -> str | None: ...


@dataclass(frozen=True)
class _Board:
    provider: str
    slug: str
    name: str | None
    discovered: bool = False


@dataclass(frozen=True)
class _Posting:
    title: str
    groups: tuple[str, ...]
    published: float | None


def _text(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("a posting field is not text")
    return value


def _iso_seconds(value: object) -> float | None:
    """Epoch seconds of an ISO 8601 date-time; None when the provider gives none."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("a date is not text")
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.timestamp()


def _rows(payload: object, key: str | None) -> list[dict[str, Any]]:
    rows: object = payload
    if key is not None:
        if not isinstance(payload, dict):
            raise ValueError("reply is not an object")
        rows = payload.get(key)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("reply has no list of postings")
    return rows


def _greenhouse_posting(row: dict[str, Any]) -> _Posting:
    departments = row.get("departments") or []
    if not isinstance(departments, list):
        raise ValueError("departments is not a list")
    groups = tuple(_text(d.get("name")) for d in departments if isinstance(d, dict))
    return _Posting(_text(row.get("title")), groups, _iso_seconds(row.get("first_published")))


def _lever_posting(row: dict[str, Any]) -> _Posting:
    categories = row.get("categories") or {}
    if not isinstance(categories, dict):
        raise ValueError("categories is not an object")
    groups = tuple(_text(categories.get(k)) for k in ("department", "team"))
    created = row.get("createdAt")
    published: float | None = None
    if created is not None:
        if not isinstance(created, (int, float)) or isinstance(created, bool):
            raise ValueError("createdAt is not a number")
        published = created / 1000.0
    return _Posting(_text(row.get("text")), groups, published)


def _ashby_posting(row: dict[str, Any]) -> _Posting:
    groups = (_text(row.get("department")), _text(row.get("team")))
    return _Posting(_text(row.get("title")), groups, _iso_seconds(row.get("publishedAt")))


def _is_rd(posting: _Posting) -> bool:
    return any(_RD_WORDS.search(text) for text in (posting.title, *posting.groups))


def _names_match(board_name: str, company: str) -> bool:
    """``legal_core`` names equal, or one starts with the other followed by a space."""
    board, listed = legal_core(board_name), legal_core(company)
    if not board or not listed:
        return False
    return board == listed or board.startswith(listed + " ") or listed.startswith(board + " ")


def _slug_candidates(company: str) -> list[str]:
    """At most three slugs: words joined with nothing, the first word, words joined with '-'."""
    words = legal_core(company).split()
    if not words:
        return []
    ordered = ["".join(words), words[0], "-".join(words)]
    unique: list[str] = []
    for slug in ordered:
        if slug not in unique:
            unique.append(slug)
    return unique[:DISCOVERY_CANDIDATES]


def _change_pct(new: int | None, prior: int | None) -> float | None:
    if new is None or prior is None or prior == 0:
        return None
    return (new - prior) * 100.0 / prior


def _status(change: float | None) -> str | None:
    if change is None:
        return None
    if change > STATUS_BAND_PCT:
        return "expanding"
    if change < -STATUS_BAND_PCT:
        return "slowing"
    return "steady"


def _not_applicable(symbol: str, reason: str | None, now: int) -> SectionResult:
    return result(
        SECTION, symbol, "not_applicable", source=NOT_APPLICABLE_SOURCE,
        fetched_ns=now, reason=reason,
    )


class HiringSource:
    """Hiring activity for one company, from the board it publishes on."""

    def __init__(
        self,
        http: _Fetcher,
        names: _Names,
        *,
        clock: Callable[[], int] = time.time_ns,
    ) -> None:
        self._http = http
        self._names = names
        self._clock = clock
        # Discovery answers (a board, or None for "no board") kept for MEMORY_NS.
        self._discovered: dict[str, tuple[int, _Board | None]] = {}

    async def hiring(self, symbol: str) -> SectionResult:
        now = self._clock()
        board, reason = await self._board_for(symbol, now)
        if board is None:
            return _not_applicable(symbol, reason, now)
        try:
            postings = await self._postings(board)
        except aiohttp.ClientResponseError as exc:
            if not board.discovered or exc.status != 404:
                raise
            # The discovered board moved or closed: forget it and discover once more.
            self._discovered.pop(symbol, None)
            board, reason = await self._board_for(symbol, now)
            if board is None:
                return _not_applicable(symbol, reason, now)
            postings = await self._postings(board)
        return self._answer(symbol, board, postings, now)

    async def close(self) -> None:
        return None

    async def _board_for(self, symbol: str, now: int) -> tuple[_Board | None, str | None]:
        """A board, or None with the reason it does not apply."""
        if symbol in CURATED_BOARDS:
            return await self._curated_board(symbol), None
        remembered = self._discovered.get(symbol)
        if remembered is not None and now - remembered[0] < MEMORY_NS:
            board = remembered[1]
        else:
            company = await self._names.name(symbol)
            if company is None:
                return None, "unknown_company"
            board = await self._discover(company)
            self._discovered[symbol] = (now, board)
        if board is None:
            return None, "no_public_board"
        return board, None

    async def _curated_board(self, symbol: str) -> _Board:
        provider, slug = CURATED_BOARDS[symbol]
        name: str | None = None
        if provider == "greenhouse":
            payload = await self._http.get_json(
                GREENHOUSE_BOARD_URL.format(slug=slug), limit=READ_LIMIT
            )
            if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
                raise ValueError("board reply has no name")
            name = payload["name"]
        return _Board(provider, slug, name)

    async def _discover(self, company: str) -> _Board | None:
        """The first candidate slug whose Greenhouse board name matches the company."""
        for slug in _slug_candidates(company):
            try:
                payload = await self._http.get_json(
                    GREENHOUSE_BOARD_URL.format(slug=slug), limit=READ_LIMIT
                )
            except aiohttp.ClientResponseError as exc:
                if exc.status == 404:
                    continue  # not this slug; any other failure raises
                raise
            if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
                raise ValueError("board reply has no name")
            if _names_match(payload["name"], company):
                return _Board("greenhouse", slug, payload["name"], discovered=True)
        return None

    async def _postings(self, board: _Board) -> list[_Posting]:
        if board.provider == "greenhouse":
            payload = await self._http.get_json(
                GREENHOUSE_JOBS_URL.format(slug=board.slug),
                limit=READ_LIMIT,
                params={"content": "true"},
            )
            return [_greenhouse_posting(row) for row in _rows(payload, "jobs")]
        if board.provider == "lever":
            payload = await self._http.get_json(
                LEVER_POSTINGS_URL.format(slug=board.slug), limit=READ_LIMIT, params={"mode": "json"}
            )
            return [_lever_posting(row) for row in _rows(payload, None)]
        payload = await self._http.get_json(ASHBY_BOARD_URL.format(slug=board.slug), limit=READ_LIMIT)
        # An unlisted posting is not shown on the public board, so it is not counted.
        return [_ashby_posting(row) for row in _rows(payload, "jobs") if row.get("isListed") is not False]

    def _answer(
        self, symbol: str, board: _Board, postings: Sequence[_Posting], now_ns: int
    ) -> SectionResult:
        now = now_ns / 1_000_000_000
        dates = [p.published for p in postings if p.published is not None]
        if len(dates) == len(postings):
            new: int | None = sum(1 for t in dates if now - WINDOW_S < t <= now)
            prior: int | None = sum(1 for t in dates if now - 2 * WINDOW_S < t <= now - WINDOW_S)
        else:
            new = prior = None
        change = _change_pct(new, prior)
        shown = None if change is None else round(change, 1)
        data: dict[str, Any] = {
            "provider": board.provider,
            "board": board.slug,
            "boardName": board.name,
            "boardUrl": PUBLIC_PAGE_URL[board.provider].format(slug=board.slug),
            "totalOpenings": len(postings),
            "rdOpenings": sum(1 for p in postings if _is_rd(p)),
            "newLast30d": new,
            "newPrior30d": prior,
            "changePct": shown,
            "status": _status(shown),
        }
        as_of = datetime.fromtimestamp(now, UTC).date().isoformat()
        return result(
            SECTION, symbol, "ok", source=SOURCE_NAME[board.provider], fetched_ns=now_ns,
            data=data, as_of=as_of,
        )
