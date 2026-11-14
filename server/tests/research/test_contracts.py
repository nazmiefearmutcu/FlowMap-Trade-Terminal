"""The government-contracts source: payload, reply parsing, whole-word filter, statuses. No network."""

from __future__ import annotations

from datetime import UTC, date, datetime
import json
from pathlib import Path
from typing import Any

import pytest

from flowmap_server.research.base import Http
from flowmap_server.research.contracts import (
    MAX_AWARDS,
    ContractsSource,
    build_payload,
    parse_awards,
)
from flowmap_server.research.names import CompanyNames, legal_core

FIXTURE = Path(__file__).parent / "fixtures" / "contracts_lockheed_reply.json"
# 2026-11-15 12:00 UTC.
NOW_NS = int(datetime(2026, 11, 15, 12, tzinfo=UTC).timestamp()) * 1_000_000_000
TODAY = date(2026, 11, 15)


def _reply() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return payload


def _row(
    recipient: str, amount: object, *, description: str | None = None, gid: str | None = None,
    award_id: str = "AWD",
) -> dict[str, Any]:
    return {
        "Award ID": award_id,
        "Recipient Name": recipient,
        "Awarding Agency": "Department of Defense",
        "Awarding Sub Agency": "Department of the Navy",
        "Award Amount": amount,
        "Start Date": "2024-01-02",
        "Description": description,
        "generated_internal_id": gid,
    }


class _FakeHttp(Http):
    """Records the POST and answers with a canned reply, or raises it."""

    def __init__(self, reply: object = None, error: BaseException | None = None) -> None:
        super().__init__()
        self._reply = reply
        self._error = error
        self.posts: list[tuple[str, object, int]] = []

    async def post_json(
        self, url: str, payload: object, *, limit: int, headers: Any = None, timeout_s: float = 0.0
    ) -> object:
        self.posts.append((url, payload, limit))
        if self._error is not None:
            raise self._error
        return self._reply


def _names(listing: dict[str, str]) -> CompanyNames:
    rows = [{"symbol": symbol, "name": name} for symbol, name in listing.items()]

    async def fetch() -> object:
        return {"data": {"rows": rows}}

    return CompanyNames(Http(), fetch=fetch)


LMT_NAMES = {"LMT": "Lockheed Martin Corporation"}


async def test_the_real_reply_parses_to_its_awards() -> None:
    awards = parse_awards(_reply())
    assert len(awards) == 5
    first = awards[0]
    assert first.award_id == "DEAC0494AL85000"
    assert first.recipient == "LOCKHEED MARTIN CORP"
    assert first.amount == pytest.approx(48063737196.35)
    assert first.start_date == "1993-10-15"
    assert first.description is None
    assert first.url == "https://www.usaspending.gov/award/CONT_AWD_DEAC0494AL85000_8900_-NONE-_-NONE-"
    assert awards[1].description == "LRIP LOT 12 ADVANCE ACQUISITION CONTRACT"


async def test_a_company_answer_keeps_its_own_awards_largest_first() -> None:
    source = ContractsSource(_FakeHttp(_reply()), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.status == "ok"
    assert answer.source == "USAspending.gov"
    assert answer.as_of == "2026-11-15"
    assert answer.data is not None
    data = answer.data
    assert data["query"] == "lockheed martin"
    assert data["windowDays"] == 365
    assert data["source"] == "USAspending.gov"
    recipients = [row["recipient"] for row in data["awards"]]
    # SIKORSKY is in the reply but its recipient name does not contain the company's.
    assert recipients == [
        "LOCKHEED MARTIN CORP",
        "LOCKHEED MARTIN CORPORATION",
        "LOCKHEED MARTIN SERVICES, LLC",
        "LOCKHEED MARTIN CORP",
    ]
    amounts = [row["amount"] for row in data["awards"]]
    assert amounts == sorted(amounts, reverse=True)
    assert data["listedTotal"] == pytest.approx(sum(amounts))
    assert data["matchedCount"] == 4
    assert data["awards"][0]["subAgency"] == "Department of Energy"
    assert data["awards"][0]["url"].startswith("https://www.usaspending.gov/award/CONT_AWD_")


async def test_the_whole_word_filter_keeps_the_company_and_drops_a_similar_name() -> None:
    reply = {
        "results": [
            _row("MARTIN MARIETTA MATERIALS", 9e9),
            _row("LOCKHEED MARTIN SPACE", 5e9),
            _row("LOCKHEED MARTIN CORPORATION", 4e9),
            _row("LOCKHEED MARTINIQUE", 3e9),
            _row("MARTIN MARIETTA", 2e9),
        ]
    }
    source = ContractsSource(_FakeHttp(reply), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    assert [row["recipient"] for row in answer.data["awards"]] == [
        "LOCKHEED MARTIN SPACE",
        "LOCKHEED MARTIN CORPORATION",
    ]


async def test_at_most_ten_largest_kept_awards_are_reported() -> None:
    rows = [_row("LOCKHEED MARTIN CORPORATION", float(amount)) for amount in range(1, 13)]
    source = ContractsSource(_FakeHttp({"results": rows}), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.data is not None
    amounts = [row["amount"] for row in answer.data["awards"]]
    assert len(amounts) == MAX_AWARDS == 10
    assert amounts == [float(amount) for amount in range(12, 2, -1)]
    assert answer.data["listedTotal"] == pytest.approx(sum(amounts))
    assert answer.data["matchedCount"] == 12


async def test_the_payload_is_the_documented_request_for_a_fixed_clock() -> None:
    http = _FakeHttp({"results": []})
    source = ContractsSource(http, _names(LMT_NAMES), clock=lambda: NOW_NS)
    await source.contracts("LMT")
    assert len(http.posts) == 1
    url, payload, limit = http.posts[0]
    assert url == "https://api.usaspending.gov/api/v2/search/spending_by_award/"
    assert limit == 4 * 1024 * 1024
    assert payload == {
        "filters": {
            "recipient_search_text": ["lockheed martin"],
            "award_type_codes": ["A", "B", "C", "D"],
            "time_period": [{"start_date": "2025-11-15", "end_date": "2026-11-15"}],
        },
        "fields": [
            "Award ID", "Recipient Name", "Awarding Agency", "Awarding Sub Agency",
            "Award Amount", "Start Date", "Description", "generated_internal_id",
        ],
        "sort": "Award Amount",
        "order": "desc",
        "limit": 25,
        "page": 1,
    }
    assert payload == build_payload("lockheed martin", TODAY)


async def test_an_unknown_ticker_is_not_applicable_and_makes_no_request() -> None:
    http = _FakeHttp({"results": []})
    source = ContractsSource(http, _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("ZZZZ")
    assert answer.status == "not_applicable"
    assert answer.reason == "unknown_company"
    assert answer.data is None
    assert http.posts == []


async def test_no_kept_award_is_empty_with_no_awards_reason() -> None:
    reply = {"results": [_row("MARTIN MARIETTA MATERIALS", 9e9)]}
    source = ContractsSource(_FakeHttp(reply), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.status == "empty"
    assert answer.reason == "no_awards"
    assert answer.data is None
    assert answer.as_of == "2026-11-15"

    empty = ContractsSource(_FakeHttp({"results": []}), _names(LMT_NAMES), clock=lambda: NOW_NS)
    assert (await empty.contracts("LMT")).status == "empty"


async def test_a_fetch_failure_raises() -> None:
    http = _FakeHttp(error=OSError("connection reset"))
    source = ContractsSource(http, _names(LMT_NAMES), clock=lambda: NOW_NS)
    with pytest.raises(OSError):
        await source.contracts("LMT")


async def test_a_listing_failure_raises() -> None:
    async def fetch() -> object:
        raise OSError("listing down")

    names = CompanyNames(Http(), fetch=fetch)
    source = ContractsSource(_FakeHttp({"results": []}), names, clock=lambda: NOW_NS)
    with pytest.raises(OSError):
        await source.contracts("LMT")


def test_a_reply_without_a_results_list_is_malformed() -> None:
    with pytest.raises(ValueError):
        parse_awards({"messages": []})
    with pytest.raises(ValueError):
        parse_awards(["not", "an", "object"])


async def test_a_null_amount_on_an_unrelated_row_does_not_change_the_answer() -> None:
    clean = {"results": [_row("LOCKHEED MARTIN CORPORATION", 4e9, award_id="A1")]}
    noisy = {
        "results": [
            _row("SIKORSKY AIRCRAFT CORPORATION", None, award_id="S1"),
            _row("LOCKHEED MARTIN CORPORATION", 4e9, award_id="A1"),
        ]
    }
    names = _names(LMT_NAMES)
    expected = await ContractsSource(_FakeHttp(clean), names, clock=lambda: NOW_NS).contracts("LMT")
    answer = await ContractsSource(_FakeHttp(noisy), names, clock=lambda: NOW_NS).contracts("LMT")
    assert answer == expected
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["matchedCount"] == 1
    assert answer.data["listedTotal"] == pytest.approx(4e9)


async def test_a_null_amount_on_a_matching_row_is_kept_last_with_amount_none() -> None:
    reply = {
        "results": [
            _row("LOCKHEED MARTIN SPACE", None, award_id="N1"),
            _row("LOCKHEED MARTIN CORPORATION", 4e9, award_id="A1"),
        ]
    }
    source = ContractsSource(_FakeHttp(reply), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    awards = answer.data["awards"]
    assert [row["awardId"] for row in awards] == ["A1", "N1"]
    assert awards[-1]["amount"] is None
    assert answer.data["matchedCount"] == 2
    # The None-amount award is left out of the sum.
    assert answer.data["listedTotal"] == pytest.approx(4e9)


@pytest.mark.parametrize("amount", [None, "1,000", "NaN", True])
async def test_a_non_numeric_amount_on_a_matching_row_is_kept_with_amount_none(amount: object) -> None:
    reply = {"results": [_row("LOCKHEED MARTIN CORPORATION", amount, award_id="X1")]}
    source = ContractsSource(_FakeHttp(reply), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["awards"][0]["amount"] is None
    assert answer.data["listedTotal"] is None
    assert answer.data["matchedCount"] == 1


async def test_a_reply_whose_listed_awards_have_no_amount_has_no_listed_total() -> None:
    reply = {"results": [_row("LOCKHEED MARTIN CORPORATION", None, award_id="X1")]}
    source = ContractsSource(_FakeHttp(reply), _names(LMT_NAMES), clock=lambda: NOW_NS)
    answer = await source.contracts("LMT")
    assert answer.data is not None
    assert answer.data["listedTotal"] is None


def test_description_is_trimmed_and_cut_to_300_characters_and_missing_id_gives_no_url() -> None:
    long_text = "  " + "x" * 400 + "  "
    awards = parse_awards({"results": [_row("LOCKHEED MARTIN CORPORATION", 7.0, description=long_text, gid=None)]})
    assert len(awards[0].description or "") == 300
    assert awards[0].description == "x" * 300
    assert awards[0].url is None


def test_legal_core_drops_the_company_legal_form_words() -> None:
    assert legal_core("Lockheed Martin Corporation") == "lockheed martin"
    assert legal_core("LOCKHEED MARTIN CORP") == "lockheed martin"
