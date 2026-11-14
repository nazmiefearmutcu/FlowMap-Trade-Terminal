"""Hiring activity: board reads, the R&D rule, 30-day windows, discovery and memory. No network."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from collections.abc import Mapping
from typing import Any

import aiohttp
import pytest

from flowmap_server.data.market_map import read_capped_bytes
from flowmap_server.research import hiring as hiring_module
from flowmap_server.research.base import failure_reason
from flowmap_server.research.hiring import (
    HiringSource,
    _is_rd,
    _names_match,
    _Posting,
    _slug_candidates,
)

FIXTURES = Path(__file__).parent / "fixtures"
DAY_NS = 86_400 * 1_000_000_000
NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
NOW_NS = int(NOW.timestamp()) * 1_000_000_000
LIMIT = 16 * 1024 * 1024

GH_BOARD = "https://boards-api.greenhouse.io/v1/boards/{}"
GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/{}/jobs"
LEVER = "https://api.lever.co/v0/postings/{}"
ASHBY = "https://api.ashbyhq.com/posting-api/job-board/{}"


def _http_error(status: int) -> aiohttp.ClientResponseError:
    info = aiohttp.RequestInfo(url=aiohttp.client.URL("https://x.test/"), method="GET", headers={})  # type: ignore[arg-type]
    return aiohttp.ClientResponseError(info, (), status=status)


def _fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_bytes())


class _Http:
    """Serves canned replies by URL. A URL with no reply answers 404, as the boards do."""

    def __init__(self, replies: Mapping[str, object] | None = None) -> None:
        self.replies: dict[str, object] = dict(replies or {})
        self.calls: list[tuple[str, dict[str, str], int]] = []

    async def get_json(
        self,
        url: str,
        *,
        limit: int,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
    ) -> object:
        self.calls.append((url, dict(params or {}), limit))
        reply = self.replies.get(url)
        if reply is None:
            raise _http_error(404)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def urls(self) -> list[str]:
        return [url for url, _, _ in self.calls]


class _Names:
    def __init__(self, table: dict[str, str]) -> None:
        self.table = table

    async def name(self, symbol: str) -> str | None:
        return self.table.get(symbol)


class _Clock:
    def __init__(self, ns: int) -> None:
        self.ns = ns

    def __call__(self) -> int:
        return self.ns


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def _gh_job(first_published: str | None, title: str = "Account Manager", dept: str = "Sales") -> dict[str, Any]:
    return {
        "title": title,
        "departments": [{"id": 1, "name": dept}],
        "first_published": first_published,
        "updated_at": "2026-11-14T00:00:00-05:00",
    }


def _gh_counts(new: int, prior: int) -> dict[str, list[dict[str, Any]]]:
    """Greenhouse jobs: ``new`` published a day ago, ``prior`` published 45 days ago."""
    jobs = [_gh_job(_iso(NOW - timedelta(days=1))) for _ in range(new)]
    jobs += [_gh_job(_iso(NOW - timedelta(days=45))) for _ in range(prior)]
    return {"jobs": jobs}


def _source(replies: Mapping[str, object] | None = None, table: dict[str, str] | None = None,
            clock: _Clock | None = None) -> tuple[HiringSource, _Http, _Clock]:
    http = _Http(replies)
    the_clock = clock or _Clock(NOW_NS)
    source = HiringSource(http, _Names(table or {}), clock=the_clock)
    return source, http, the_clock


# --- provider replies -> counts -------------------------------------------------------


async def test_greenhouse_fixture_counts_and_the_request_asks_for_departments() -> None:
    source, http, _ = _source({
        GH_BOARD.format("datadog"): {"name": "Datadog"},
        GH_JOBS.format("datadog"): _fixture("hiring_greenhouse_jobs.json"),
    })
    answer = await source.hiring("DDOG")
    assert answer.status == "ok"
    assert answer.source == "Greenhouse"
    assert answer.as_of == "2026-11-15"
    assert answer.data == {
        "provider": "greenhouse",
        "board": "datadog",
        "boardName": "Datadog",
        "boardUrl": "https://boards.greenhouse.io/datadog",
        "totalOpenings": 6,
        "rdOpenings": 4,
        "newLast30d": 1,
        "newPrior30d": 1,
        "changePct": 0.0,
        "status": "steady",
    }
    jobs_call = [c for c in http.calls if c[0] == GH_JOBS.format("datadog")][0]
    assert jobs_call[1] == {"content": "true"}
    assert all(limit == LIMIT for _, _, limit in http.calls)


async def test_lever_fixture_counts_and_the_board_has_no_name_in_its_reply() -> None:
    source, http, _ = _source({LEVER.format("spotify"): _fixture("hiring_lever_postings.json")},
                              table={})
    # SPOT is curated; the board reply is the postings list, read with mode=json.
    answer = await source.hiring("SPOT")
    assert answer.status == "ok"
    assert answer.source == "Lever"
    assert answer.data == {
        "provider": "lever",
        "board": "spotify",
        "boardName": None,
        "boardUrl": "https://jobs.lever.co/spotify",
        "totalOpenings": 6,
        "rdOpenings": 3,
        "newLast30d": 4,
        "newPrior30d": 1,
        "changePct": 300.0,
        "status": "expanding",
    }
    assert http.calls[0][1] == {"mode": "json"}


async def test_ashby_fixture_counts_listed_postings_and_has_no_prior_window() -> None:
    source, _, _ = _source({ASHBY.format("snowflake"): _fixture("hiring_ashby_jobs.json")})
    answer = await source.hiring("SNOW")
    assert answer.status == "ok"
    assert answer.source == "Ashby"
    assert answer.data == {
        "provider": "ashby",
        "board": "snowflake",
        "boardName": None,
        "boardUrl": "https://jobs.ashbyhq.com/snowflake",
        "totalOpenings": 6,
        "rdOpenings": 4,
        "newLast30d": 2,
        "newPrior30d": 0,
        "changePct": None,
        "status": None,
    }


async def test_an_unlisted_ashby_posting_is_not_an_opening() -> None:
    now = NOW
    replies = {ASHBY.format("snowflake"): {"jobs": [
        {"title": "Account Manager", "department": "Sales", "team": "Sales",
         "publishedAt": _iso(now - timedelta(days=1)), "isListed": True},
        {"title": "Account Manager", "department": "Sales", "team": "Sales",
         "publishedAt": _iso(now - timedelta(days=1)), "isListed": False},
    ]}}
    source, _, _ = _source(replies)
    answer = await source.hiring("SNOW")
    assert answer.data is not None
    assert answer.data["totalOpenings"] == 1
    assert answer.data["newLast30d"] == 1


async def test_a_board_with_no_openings_is_ok_with_zeros() -> None:
    source, _, _ = _source({
        GH_BOARD.format("datadog"): {"name": "Datadog"},
        GH_JOBS.format("datadog"): {"jobs": []},
    })
    answer = await source.hiring("DDOG")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["totalOpenings"] == 0
    assert answer.data["rdOpenings"] == 0
    assert answer.data["newLast30d"] == 0
    assert answer.data["newPrior30d"] == 0
    assert answer.data["changePct"] is None
    assert answer.data["status"] is None


async def test_a_reply_without_its_job_list_is_malformed() -> None:
    source, _, _ = _source({
        GH_BOARD.format("datadog"): {"name": "Datadog"},
        GH_JOBS.format("datadog"): {"nope": []},
    })
    with pytest.raises(ValueError):
        await source.hiring("DDOG")


# --- the R&D rule ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "groups", "expected"),
    [
        ("Research Scientist", (), True),
        ("Researcher, Growth", (), True),
        ("Engineers", (), True),
        ("Sales Engineer", ("Sales",), True),
        ("Account Executive", ("Engineering",), True),
        ("Data Analyst", ("Finance",), True),
        ("Datadog Sales Lead", ("Sales",), False),
        ("Dataset Curator", ("Operations",), False),
        ("AI/ML Lead", (), True),
        ("R&D Manager", (), True),
        ("Machine Learning Engineer", (), True),
        ("Hardware Operations Lead", (), True),
        ("Marketing Manager", ("Marketing",), False),
        ("Account Executive", ("Sales Development",), False),
        ("Email Specialist", ("Email",), False),
    ],
)
def test_the_rd_rule_matches_whole_words_only(title: str, groups: tuple[str, ...], expected: bool) -> None:
    assert _is_rd(_Posting(title, groups, None)) is expected


# --- 30-day windows and the change -------------------------------------------------------


async def test_a_board_with_only_dated_postings_counts_the_windows() -> None:
    jobs = [
        _gh_job(_iso(NOW)),
        _gh_job(_iso(NOW - timedelta(days=30))),
        _gh_job(_iso(NOW - timedelta(days=30) + timedelta(seconds=1))),
        _gh_job(_iso(NOW - timedelta(days=60))),
        _gh_job(_iso(NOW + timedelta(seconds=1))),
        _gh_job("2025-01-01T00:00:00+00:00"),
    ]
    replies = {GH_BOARD.format("datadog"): {"name": "Datadog"}, GH_JOBS.format("datadog"): {"jobs": jobs}}
    source, _, _ = _source(replies)
    answer = await source.hiring("DDOG")
    assert answer.data is not None
    assert answer.data["newLast30d"] == 2
    assert answer.data["newPrior30d"] == 1
    assert answer.data["changePct"] == 100.0
    assert answer.data["status"] == "expanding"


async def test_a_missing_first_publish_date_is_none_not_an_estimate() -> None:
    jobs = [_gh_job(_iso(NOW - timedelta(days=1))), _gh_job(None)]
    replies = {GH_BOARD.format("datadog"): {"name": "Datadog"}, GH_JOBS.format("datadog"): {"jobs": jobs}}
    source, _, _ = _source(replies)
    answer = await source.hiring("DDOG")
    assert answer.data is not None
    assert answer.data["totalOpenings"] == 2
    assert answer.data["newLast30d"] is None
    assert answer.data["newPrior30d"] is None


@pytest.mark.parametrize(
    ("new", "prior", "change", "status"),
    [
        (10, 10, 0.0, "steady"),
        (11, 10, 10.0, "steady"),     # exactly +10 % is steady
        (12, 10, 20.0, "expanding"),
        (9, 10, -10.0, "steady"),     # exactly -10 % is steady
        (8, 10, -20.0, "slowing"),
        (0, 5, -100.0, "slowing"),
        (5, 0, None, None),           # no prior window: no change
        (0, 0, None, None),
    ],
)
async def test_the_change_and_its_status_edges(new: int, prior: int, change: float | None, status: str | None) -> None:
    replies = {GH_BOARD.format("datadog"): {"name": "Datadog"}, GH_JOBS.format("datadog"): _gh_counts(new, prior)}
    source, _, _ = _source(replies)
    answer = await source.hiring("DDOG")
    assert answer.data is not None
    assert answer.data["newLast30d"] == new
    assert answer.data["newPrior30d"] == prior
    assert answer.data["changePct"] == change
    assert answer.data["status"] == status


# --- discovery -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("board", "company", "expected"),
    [
        ("Datadog", "Datadog, Inc.", True),
        ("Data", "Datadog", False),
        ("Datadog", "Data", False),
        ("Block", "Block, Inc.", True),
        ("SoFi", "SoFi Technologies, Inc.", True),
        ("Spotify", "Spotify Technology S.A.", True),
        ("Lockheed Martin", "Lockheed Martin Corporation", True),
        ("Lockheed Gear", "Lockheed Martin Corporation", False),
        ("", "Datadog", False),
    ],
)
def test_the_name_match_rule(board: str, company: str, expected: bool) -> None:
    assert _names_match(board, company) is expected


def test_slug_candidates_are_three_at_most_in_order() -> None:
    assert _slug_candidates("Lockheed Martin Corporation") == ["lockheedmartin", "lockheed", "lockheed-martin"]
    assert _slug_candidates("Datadog, Inc.") == ["datadog"]
    assert _slug_candidates("Inc.") == []


async def test_discovery_probes_three_slugs_in_order_and_stops_at_the_limit() -> None:
    source, http, _ = _source(table={"LMT": "Lockheed Martin Corporation"})
    answer = await source.hiring("LMT")
    assert answer.status == "not_applicable"
    assert answer.reason == "no_public_board"
    assert answer.source == "Public job boards"
    assert http.urls() == [
        GH_BOARD.format("lockheedmartin"),
        GH_BOARD.format("lockheed"),
        GH_BOARD.format("lockheed-martin"),
    ]


async def test_a_404_while_probing_is_not_a_failure_and_the_first_matching_name_wins() -> None:
    replies = {
        GH_BOARD.format("lockheed"): {"name": "Lockheed Martin"},
        GH_JOBS.format("lockheed"): {"jobs": [_gh_job(_iso(NOW - timedelta(days=2)), "Software Engineer")]},
    }
    source, http, _ = _source(replies, table={"LMT": "Lockheed Martin Corporation"})
    answer = await source.hiring("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["provider"] == "greenhouse"
    assert answer.data["board"] == "lockheed"
    assert answer.data["boardName"] == "Lockheed Martin"
    assert answer.data["boardUrl"] == "https://boards.greenhouse.io/lockheed"
    assert answer.data["rdOpenings"] == 1
    assert GH_BOARD.format("lockheed-martin") not in http.urls()


async def test_a_board_whose_name_does_not_match_is_skipped() -> None:
    replies = {
        GH_BOARD.format("lockheedmartin"): {"name": "Lockheed Gear"},
        GH_BOARD.format("lockheed"): {"name": "Lockheed Martin"},
        GH_JOBS.format("lockheed"): {"jobs": []},
    }
    source, http, _ = _source(replies, table={"LMT": "Lockheed Martin Corporation"})
    answer = await source.hiring("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["board"] == "lockheed"
    assert GH_BOARD.format("lockheed-martin") not in http.urls()


async def test_a_failure_other_than_404_while_probing_raises() -> None:
    replies = {GH_BOARD.format("lockheedmartin"): _http_error(500)}
    source, _, _ = _source(replies, table={"LMT": "Lockheed Martin Corporation"})
    with pytest.raises(aiohttp.ClientResponseError):
        await source.hiring("LMT")


async def test_a_known_board_that_answers_404_raises() -> None:
    source, _, _ = _source({})  # DDOG's board is curated; no reply means 404
    with pytest.raises(aiohttp.ClientResponseError):
        await source.hiring("DDOG")


async def test_an_unknown_company_is_not_applicable_without_any_request() -> None:
    source, http, _ = _source(table={})
    answer = await source.hiring("QQQQ")
    assert answer.status == "not_applicable"
    assert answer.reason == "unknown_company"
    assert http.calls == []


async def test_a_discovery_miss_is_remembered_for_seven_days() -> None:
    clock = _Clock(NOW_NS)
    source, http, _ = _source(table={"LMT": "Lockheed Martin Corporation"}, clock=clock)
    assert (await source.hiring("LMT")).reason == "no_public_board"
    probes = len(http.calls)
    assert probes == 3

    clock.ns += 7 * DAY_NS - 1_000_000_000
    assert (await source.hiring("LMT")).reason == "no_public_board"
    assert len(http.calls) == probes

    clock.ns += 1_000_000_000
    assert (await source.hiring("LMT")).reason == "no_public_board"
    assert len(http.calls) == probes + 3


async def test_a_discovered_board_is_not_probed_again_within_seven_days() -> None:
    clock = _Clock(NOW_NS)
    replies = {
        GH_BOARD.format("lockheed"): {"name": "Lockheed Martin"},
        GH_JOBS.format("lockheed"): {"jobs": []},
    }
    source, http, _ = _source(replies, table={"LMT": "Lockheed Martin Corporation"}, clock=clock)
    assert (await source.hiring("LMT")).status == "ok"
    assert (await source.hiring("LMT")).status == "ok"
    assert http.urls().count(GH_BOARD.format("lockheed")) == 1
    assert http.urls().count(GH_JOBS.format("lockheed")) == 2


async def test_close_is_a_no_op() -> None:
    source, _, _ = _source()
    await source.close()


def test_the_module_reads_the_16_mb_cap() -> None:
    assert hiring_module.READ_LIMIT == LIMIT


# --- fix round 1 ---------------------------------------------------------------------


class _Moving(_Http):
    """Greenhouse board ``lockheed`` moves away the moment its jobs are asked for."""

    async def get_json(self, url: str, **kwargs: Any) -> object:
        if url == GH_JOBS.format("lockheed"):
            self.replies.pop(GH_BOARD.format("lockheed"), None)
        return await super().get_json(url, **kwargs)


async def test_a_discovered_board_whose_jobs_404_is_forgotten_and_found_again_in_the_same_request() -> None:
    replies = {
        GH_BOARD.format("lockheed"): {"name": "Lockheed Martin"},
        GH_BOARD.format("lockheed-martin"): {"name": "Lockheed Martin"},
        GH_JOBS.format("lockheed-martin"): {"jobs": [_gh_job(_iso(NOW - timedelta(days=2)), "Engineer")]},
    }
    http = _Moving(replies)
    source = HiringSource(http, _Names({"LMT": "Lockheed Martin Corporation"}), clock=_Clock(NOW_NS))
    answer = await source.hiring("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["board"] == "lockheed-martin"
    assert answer.data["rdOpenings"] == 1
    assert GH_JOBS.format("lockheed") in http.urls()
    assert http.urls().count(GH_BOARD.format("lockheed")) == 2  # probed again after the forget


async def test_a_discovered_board_that_moved_with_no_successor_is_not_applicable() -> None:
    replies = {GH_BOARD.format("lockheed"): {"name": "Lockheed Martin"}}
    http = _Moving(replies)
    source = HiringSource(http, _Names({"LMT": "Lockheed Martin Corporation"}), clock=_Clock(NOW_NS))
    answer = await source.hiring("LMT")
    assert answer.status == "not_applicable"
    assert answer.reason == "no_public_board"


async def test_a_curated_board_whose_jobs_404_raises() -> None:
    source, _, _ = _source({GH_BOARD.format("datadog"): {"name": "Datadog"}})  # jobs: no reply, 404
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await source.hiring("DDOG")
    assert caught.value.status == 404


async def test_a_curated_lever_board_answering_404_raises() -> None:
    source, _, _ = _source({})
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await source.hiring("SPOT")
    assert caught.value.status == 404


async def test_a_curated_ashby_board_answering_404_raises() -> None:
    source, _, _ = _source({})
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await source.hiring("SNOW")
    assert caught.value.status == 404


async def test_the_lever_request_url_is_the_postings_endpoint() -> None:
    source, http, _ = _source({LEVER.format("spotify"): _fixture("hiring_lever_postings.json")})
    await source.hiring("SPOT")
    assert http.calls[0][0] == "https://api.lever.co/v0/postings/spotify"


async def test_a_curated_greenhouse_board_without_a_name_raises() -> None:
    source, _, _ = _source({GH_BOARD.format("datadog"): {"content": "x"}})
    with pytest.raises(ValueError):
        await source.hiring("DDOG")


async def test_status_is_read_from_the_change_as_shown() -> None:
    # 3301 vs 3000 is +10.03 %: shown as 10.0, so the status is steady, as the shown value says.
    replies = {GH_BOARD.format("datadog"): {"name": "Datadog"}, GH_JOBS.format("datadog"): _gh_counts(3301, 3000)}
    source, _, _ = _source(replies)
    answer = await source.hiring("DDOG")
    assert answer.data is not None
    assert answer.data["changePct"] == 10.0
    assert answer.data["status"] == "steady"


class _Stream:
    async def read(self, size: int) -> bytes:
        return b""


class _OversizeResponse:
    content_length = 17 * 1024 * 1024
    content = _Stream()


class _Oversize:
    """A fake Http whose reply is a body over the cap, read by the real capped reader."""

    async def get_json(self, url: str, *, limit: int, **kwargs: Any) -> object:
        response: Any = _OversizeResponse()  # duck-typed like aiohttp's response
        return await read_capped_bytes(response, limit=limit)


async def test_a_board_over_the_cap_is_too_large_not_malformed() -> None:
    source = HiringSource(_Oversize(), _Names({}), clock=_Clock(NOW_NS))
    with pytest.raises(ValueError) as caught:
        await source.hiring("DDOG")
    assert failure_reason(caught.value) == "too_large"
