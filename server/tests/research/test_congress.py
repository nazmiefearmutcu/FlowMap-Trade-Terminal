"""House transaction reports: index, report text, committees and the background reader. No network."""

from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import zipfile

import pytest

from flowmap_server.research.base import Http, SectionUnavailable
from flowmap_server.research.congress import (
    COMMITTEES_URL,
    LEGISLATORS_URL,
    MEMBERSHIP_URL,
    HouseTradesSource,
    parse_committees,
    parse_index,
    parse_legislators,
    parse_report_text,
    report_rows,
)

FIXTURES = Path(__file__).parent / "fixtures"
PDF = (FIXTURES / "congress_ptr_20034280.pdf").read_bytes()
# 2026-11-15 12:00 UTC
NOW_NS = 1_794_744_000 * 10**9

HEADER = "Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID"
INDEX_2026 = "\n".join([
    HEADER,
    "Hon.\tTaylor\tDavid J.\t\tP\tOH02\t2026\t4/2/2026\t20034280",
    "Hon.\tTaylor\tDavid J.\t\tP\tOH02\t2026\t5/2/2026\t20039999",
    "\tAaron\tRichard\t\tW\tMI04\t2026\t4/15/2026\t8068",
    "Hon.\tBroken\tRow\t\tP\tXX\t2026\tnot a date\t1",
])
INDEX_2025 = HEADER + "\n"

LEGISLATORS = [
    {"id": {"bioguide": "T000490"}, "name": {"last": "Taylor"},
     "terms": [{"type": "rep", "state": "OH", "district": 2}]},
    {"id": {"bioguide": "S000001"}, "name": {"last": "Senator"},
     "terms": [{"type": "sen", "state": "OH"}]},
]
MEMBERSHIP = {"HSAG": [{"bioguide": "T000490"}], "HSAG03": [{"bioguide": "T000490"}], "HSIF": [{"bioguide": "T000490"}]}
COMMITTEES = [
    {"type": "house", "thomas_id": "HSAG", "name": "House Committee on Agriculture"},
    {"type": "house", "thomas_id": "HSIF", "name": "House Committee on Energy and Commerce"},
    {"type": "senate", "thomas_id": "SSAF", "name": "Senate Committee on Agriculture"},
]


def _zip(text: str, year: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"{year}FD.txt", text)
        archive.writestr(f"{year}FD.xml", "<xml/>")
    return buffer.getvalue()


def test_index_keeps_transaction_reports_only() -> None:
    rows = parse_index(INDEX_2026, 2026)
    assert [r.doc_id for r in rows] == ["20034280", "20039999"]
    first = rows[0]
    assert (first.member, first.state, first.district, first.filing_date) == ("David J. Taylor", "OH", 2, "2026-04-02")
    with pytest.raises(ValueError):
        parse_index("Name\tOther\n", 2026)


def test_a_real_report_gives_its_rows() -> None:
    rows, readable = report_rows(PDF)
    assert readable
    assert rows == [
        {"ticker": "IBP", "assetType": "ST", "type": "Purchase", "transactionDate": "2026-03-24",
         "notificationDate": "2026-03-25", "amount": "$1,001 - $15,000"},
        {"ticker": "KR", "assetType": "ST", "type": "Sale", "transactionDate": "2026-03-24",
         "notificationDate": "2026-03-25", "amount": "$1,001 - $15,000"},
    ]


def test_report_text_rows_with_partial_sales_options_and_wrapped_amounts() -> None:
    text = (
        "Apple Inc. (AAPL) [ST] S (partial) 01/02/2026 01/10/2026 $15,001 -\n$50,000 "
        "NVIDIA call (NVDA) [OP] P 02/03/2026 02/05/2026 Over $50,000,000 "
        "Treasury Bill [GS] P 02/03/2026 02/05/2026 $1,001 - $15,000 "
        "Bad (XYZ) [ST] P 13/45/2026 01/01/2026 $1,001 - $15,000"
    )
    rows = parse_report_text(text)
    assert [(r["ticker"], r["type"], r["amount"]) for r in rows] == [
        ("AAPL", "Partial sale", "$15,001 - $50,000"),
        ("NVDA", "Purchase", "Over $50,000,000"),
    ]


def test_committees_are_full_house_committees_by_member() -> None:
    assert parse_legislators(LEGISLATORS) == {("taylor", "OH", 2): "T000490"}
    assert parse_committees(MEMBERSHIP, COMMITTEES) == {"T000490": ["Agriculture", "Energy and Commerce"]}


class _Fake:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.pages: dict[str, bytes] = {
            "2026FD.zip": _zip(INDEX_2026, 2026),
            "2025FD.zip": _zip(INDEX_2025, 2025),
            "20034280.pdf": PDF,
            LEGISLATORS_URL: json.dumps(LEGISLATORS).encode(),
            MEMBERSHIP_URL: json.dumps(MEMBERSHIP).encode(),
            COMMITTEES_URL: json.dumps(COMMITTEES).encode(),
        }

    async def __call__(self, url: str, limit: int) -> bytes:
        self.calls.append(url)
        for key, body in self.pages.items():
            if url.endswith(key):
                return body
        raise ConnectionError("not found")


async def _settle(source: HouseTradesSource, fake: _Fake, pdf_reads: int) -> None:
    for _ in range(200):
        if sum(u.endswith(".pdf") for u in fake.calls) >= pdf_reads and source._done:
            return
        await asyncio.sleep(0.01)


async def test_the_reader_fills_the_section_and_saves_reports(tmp_path: Path) -> None:
    fake = _Fake()
    source = HouseTradesSource(Http(), data_dir=tmp_path, clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    first = await source.trades("IBP")
    await _settle(source, fake, 2)
    answer = await source.trades("ibp")
    await source.close()
    data = answer.data or {}
    assert answer.status == "ok" and first.status == "ok"
    assert data["coverage"] == {"parsed": 1, "total": 2, "unreadable": 0}
    trade = data["trades"][0]
    assert trade["member"] == "David J. Taylor" and trade["state"] == "OH" and trade["district"] == 2
    assert trade["committees"] == ["Agriculture", "Energy and Commerce"]
    assert trade["reportUrl"].endswith("/2026/20034280.pdf")
    assert "last" not in trade
    assert (tmp_path / "house-ptr" / "2026" / "20034280.json").is_file()

    # A new reader reads the saved report from disk, not from the House site.
    again = _Fake()
    reread = HouseTradesSource(Http(), data_dir=tmp_path, clock=lambda: NOW_NS, fetch=again, pause_s=0)
    await reread.trades("KR")
    await asyncio.sleep(0.05)
    answer = await reread.trades("KR")
    await reread.close()
    assert not any(u.endswith("20034280.pdf") for u in again.calls)
    assert (answer.data or {})["trades"][0]["type"] == "Sale"


async def test_an_unknown_ticker_has_no_trades_but_shows_coverage() -> None:
    fake = _Fake()
    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    answer = await source.trades("ZZZZ")
    await source.close()
    assert answer.status == "ok"
    assert (answer.data or {})["trades"] == []


async def test_an_index_that_cannot_be_read_is_a_source_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flowmap_server.research.congress.FIRST_INDEX_WAIT_S", 0.2)
    fake = _Fake()
    del fake.pages["2026FD.zip"]
    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    with pytest.raises(ConnectionError):
        await source.trades("IBP")
    await source.close()


async def test_a_slow_index_is_reported_as_loading(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flowmap_server.research.congress.FIRST_INDEX_WAIT_S", 0.05)
    gate = asyncio.Event()

    async def slow(url: str, limit: int) -> bytes:
        await gate.wait()
        raise ConnectionError("never")

    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=slow, pause_s=0)
    with pytest.raises(SectionUnavailable) as caught:
        await source.trades("IBP")
    assert caught.value.reason == "index_loading"
    await source.close()


async def test_the_index_failure_reason_reaches_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    from flowmap_server.research.base import SectionCache

    monkeypatch.setattr("flowmap_server.research.congress.FIRST_INDEX_WAIT_S", 0.2)
    fake = _Fake()
    fake.pages["2026FD.zip"] = b"not a zip archive"
    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    answer = await SectionCache().get("house-trades", "IBP", ttl_s=60, source="House Clerk",
                                      load=lambda: source.trades("IBP"))
    await source.close()
    assert (answer.status, answer.reason) == ("unavailable", "malformed")


async def test_reports_are_read_in_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flowmap_server.research.congress.REPORTS_PER_PASS", 1)
    monkeypatch.setattr("flowmap_server.research.congress.BATCH_PAUSE_S", 3600.0)
    fake = _Fake()
    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    await source.trades("IBP")
    await asyncio.sleep(0.2)
    await source.close()
    assert sum(u.endswith(".pdf") for u in fake.calls) == 1


async def test_answers_say_the_owner_is_not_read() -> None:
    source = HouseTradesSource(Http(), clock=lambda: NOW_NS, fetch=_Fake(), pause_s=0)
    answer = await source.trades("IBP")
    await source.close()
    assert (answer.data or {})["ownerKnown"] is False


async def test_rows_saved_by_another_parser_version_are_read_again(tmp_path: Path) -> None:
    folder = tmp_path / "house-ptr" / "2026"
    folder.mkdir(parents=True)
    (folder / "20034280.json").write_text(json.dumps({"parser": 0, "readable": True, "rows": []}), encoding="utf-8")
    fake = _Fake()
    source = HouseTradesSource(Http(), data_dir=tmp_path, clock=lambda: NOW_NS, fetch=fake, pause_s=0)
    await source.trades("IBP")
    await _settle(source, fake, 1)
    await source.close()
    assert any(u.endswith("20034280.pdf") for u in fake.calls)
