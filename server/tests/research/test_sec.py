"""SEC EDGAR sections: parsing, Item 1A, the diff and the language rates. No network."""

from __future__ import annotations

import json

import pytest

from flowmap_server.research.base import Http
from flowmap_server.research.sec import (
    SecSource,
    html_to_paragraphs,
    item_1a,
    language_rates,
    parse_exhibits,
    parse_filings,
    parse_ticker_map,
    risk_diff,
)

CONTACT = "me@example.com"

TICKERS = {
    "0": {"cik_str": 1045810, "ticker": "NVDA", "title": "NVIDIA CORP"},
    "1": {"cik_str": 1067983, "ticker": "BRK-B", "title": "BERKSHIRE HATHAWAY INC"},
    "2": {"cik_str": "x", "ticker": "BAD", "title": "No cik"},
}

SUBMISSIONS = {
    "name": "NVIDIA CORP",
    "filings": {"recent": {
        "form": ["8-K", "10-Q", "8-K", "10-Q", "4", "8-K", "10-K"],
        "filingDate": ["2026-11-12", "2026-08-26", "2026-08-26", "2026-05-20", "2026-05-01", "2026-05-20", "2026-02-25"],
        "accessionNumber": ["0001-26-000082", "0001-26-000075", "0001-26-000073", "0001-26-000050", "0001-26-000040", "0001-26-000049", "0001-26-000010"],
        "primaryDocument": ["a.htm", "q2.htm", "e2.htm", "q1.htm", "f4.xml", "e1.htm", "k.htm"],
        "items": ["5.02,9.01", "", "2.02,9.01", "", "", "2.02,9.01", ""],
    }},
}

INDEX_ROWS = """
<tr><td scope="row">1</td><td scope="row">8-K</td>
<td scope="row"><a href="/ix?doc=/Archives/edgar/data/1045810/000126000073/e2.htm">e2.htm</a> &nbsp;&nbsp;<span>iXBRL</span></td>
<td scope="row">8-K</td><td scope="row">26457</td></tr>
<tr class="evenRow"><td scope="row">2</td><td scope="row">EX-99.1</td>
<td scope="row"><a href="/Archives/edgar/data/1045810/000126000073/pr.htm">pr.htm</a></td>
<td scope="row">EX-99.1</td><td scope="row">341113</td></tr>
<tr><td scope="row">3</td><td scope="row">EX-99.2</td>
<td scope="row"><a href="/Archives/edgar/data/1045810/000126000073/cfo.htm">cfo.htm</a></td>
<td scope="row">EX-99.2</td><td scope="row">256881</td></tr>
"""

RISK_TEXT = "Our business faces many risks that could harm results and the price of our stock in many ways. " * 6


def _quarterly(extra: str) -> str:
    return (
        "<html><head><style>p{}</style></head><body><ix:header><p>hidden xbrl</p></ix:header>"
        "<p>Item 1A. Risk Factors</p><p>Item 2. Unregistered Sales</p>"  # table of contents
        "<p>Part II</p><p>Item 1A. Risk Factors</p>"
        f"<p>{RISK_TEXT}</p><p>Competition could adversely impact our market share.</p>{extra}"
        "<p>Item 2. Unregistered Sales of Equity Securities</p><p>Not part of 1A.</p></body></html>"
    )


def test_ticker_map_uses_dots_for_class_shares_and_skips_bad_rows() -> None:
    assert parse_ticker_map(TICKERS) == {"NVDA": 1045810, "BRK.B": 1067983}
    with pytest.raises(ValueError):
        parse_ticker_map({})


def test_filings_are_newest_first_with_their_items() -> None:
    filings = parse_filings(SUBMISSIONS)
    assert filings[0]["date"] == "2026-11-12"
    assert [f["form"] for f in filings if f["form"] != "4"][:3] == ["8-K", "10-Q", "8-K"]
    assert filings[2]["items"] == "2.02,9.01"
    with pytest.raises(ValueError):
        parse_filings({"filings": {}})


def test_exhibits_are_read_from_the_index_page() -> None:
    assert parse_exhibits(INDEX_ROWS) == [
        ("EX-99.1", "/Archives/edgar/data/1045810/000126000073/pr.htm"),
        ("EX-99.2", "/Archives/edgar/data/1045810/000126000073/cfo.htm"),
    ]


def test_paragraphs_drop_markup_hidden_xbrl_and_entities() -> None:
    paragraphs = html_to_paragraphs("<ix:header><p>x</p></ix:header><p>A&amp;B&nbsp;C</p><div>  two   spaces </div>")
    assert paragraphs == ["A&B C", "two spaces"]


def test_item_1a_takes_the_real_section_not_the_table_of_contents() -> None:
    section = item_1a(html_to_paragraphs(_quarterly("")))
    assert section[0] == RISK_TEXT.strip()
    assert section[-1] == "Competition could adversely impact our market share."
    assert item_1a(["Item 2. Other"]) == []


def test_the_diff_lists_added_and_removed_paragraphs_and_counts_rewordings() -> None:
    previous = ["Stable paragraph about supply.", "Old risk about a lawsuit that ended.",
                "We rely on a limited number of suppliers for our wafers and memory."]
    current = ["Stable paragraph about supply.", "A government investigation may lead to fines.",
               "We rely on a limited number of suppliers for our wafers and our memory."]
    diff = risk_diff(previous, current)
    assert diff["added"] == ["A government investigation may lead to fines."]
    assert diff["removed"] == ["Old risk about a lawsuit that ended."]
    assert diff["modifiedCount"] == 1
    assert diff["triggers"] == ["investigation"]


def test_long_paragraphs_are_cut() -> None:
    diff = risk_diff([], ["x" * 1000])
    assert len(diff["added"][0]) == 400 and diff["added"][0].endswith("…")
    assert diff["addedCount"] == 1


def test_language_rates_skip_the_safe_harbour_and_count_per_1000_words() -> None:
    paragraphs = [
        "Revenue may grow and we expect demand to remain volatile.",
        "This release contains forward-looking statements that may could might.",
    ]
    rates = language_rates(paragraphs)
    assert rates["words"] == 10
    assert rates["hedgingPer1k"] == 200.0  # may, expect
    assert rates["uncertaintyPer1k"] == 100.0  # volatile
    assert {"term": "may", "count": 1} in rates["topTerms"]
    assert language_rates([])["hedgingPer1k"] is None


class _Fake:
    def __init__(self, pages: dict[str, bytes]) -> None:
        self.pages = pages
        self.seen: list[tuple[str, str]] = []

    async def __call__(self, url: str, limit: int, contact: str) -> bytes:
        self.seen.append((url, contact))
        for key, body in self.pages.items():
            if url.endswith(key):
                return body
        raise KeyError(url)


def _pages() -> dict[str, bytes]:
    return {
        "company_tickers.json": json.dumps(TICKERS).encode(),
        "CIK0001045810.json": json.dumps(SUBMISSIONS).encode(),
        "/q2.htm": _quarterly("<p>A government investigation may lead to fines.</p>").encode(),
        "/q1.htm": _quarterly("").encode(),
        "0001-26-000073-index.html": INDEX_ROWS.encode(),
        "0001-26-000049-index.html": INDEX_ROWS.replace("000126000073", "000126000049").encode(),
        "000126000073/pr.htm": b"<p>Revenue may grow. Demand is volatile.</p>",
        "000126000049/pr.htm": b"<p>Revenue grew strongly across every market.</p>",
    }


async def test_risk_factors_compare_the_two_newest_quarterly_filings() -> None:
    fake = _Fake(_pages())
    source = SecSource(Http(), fetch=fake, clock=lambda: 7)
    answer = await source.risk_factors("NVDA", CONTACT)
    assert answer.status == "ok" and answer.as_of == "2026-08-26"
    data = answer.data or {}
    assert (data["form"], data["previousForm"], data["previousFiledDate"]) == ("10-Q", "10-Q", "2026-05-20")
    assert data["added"] == ["A government investigation may lead to fines."]
    assert data["triggers"] == ["investigation"]
    assert data["url"].endswith("0001-26-000075-index.html")
    assert all(contact == CONTACT for _, contact in fake.seen)


async def test_language_compares_the_two_newest_earnings_releases() -> None:
    source = SecSource(Http(), fetch=_Fake(_pages()))
    answer = await source.management_language("NVDA", CONTACT)
    data = answer.data or {}
    assert answer.status == "ok"
    assert (data["filedDate"], data["previousFiledDate"]) == ("2026-08-26", "2026-05-20")
    assert data["words"] == 6
    assert data["hedgingPer1k"] == pytest.approx(166.67)
    assert data["previousHedgingPer1k"] == 0.0
    assert data["hedgingChange"] == pytest.approx(166.67)
    assert data["url"].endswith("000126000073/pr.htm")


async def test_an_unknown_ticker_is_not_a_sec_registrant() -> None:
    source = SecSource(Http(), fetch=_Fake(_pages()))
    answer = await source.risk_factors("ZZZZ", CONTACT)
    assert (answer.status, answer.reason) == ("not_applicable", "not_sec_registrant")


async def test_fewer_than_two_risk_sections_is_empty() -> None:
    pages = _pages()
    pages["/q1.htm"] = b"<p>Item 1A. Risk Factors</p><p>No material changes.</p>"
    pages["/k.htm"] = b"<p>nothing</p>"
    answer = await SecSource(Http(), fetch=_Fake(pages)).risk_factors("NVDA", CONTACT)
    assert (answer.status, answer.reason) == ("empty", "fewer_than_two_filings")


async def test_a_failed_ticker_map_read_raises_and_a_later_one_keeps_the_old_map() -> None:
    pages = _pages()
    fake = _Fake(pages)
    mono = [0.0]
    source = SecSource(Http(), fetch=fake, monotonic=lambda: mono[0])
    assert (await source.risk_factors("NVDA", CONTACT)).status == "ok"
    del pages["company_tickers.json"]
    mono[0] += 2 * 24 * 3600
    assert (await source.risk_factors("NVDA", CONTACT)).status == "ok"
    with pytest.raises(KeyError):
        await SecSource(Http(), fetch=_Fake(pages)).risk_factors("NVDA", CONTACT)


def test_a_reworded_paragraph_that_gains_a_trigger_is_flagged() -> None:
    previous = ["Our auditors identified a control issue that may be significant to our accounts."]
    current = ["Our auditors identified a material weakness that may be significant to our accounts."]
    diff = risk_diff(previous, current)
    assert diff["modifiedCount"] == 1 and diff["added"] == []
    assert diff["triggers"] == ["material weakness"]


def test_triggers_are_whole_words() -> None:
    assert risk_diff([], ["Settings apply by defaulting to the old plan."])["triggers"] == []
    assert risk_diff([], ["A default on our notes would hurt us."])["triggers"] == ["default"]


def test_a_large_rewrite_is_compared_in_bounded_time() -> None:
    import random
    import time as clock

    words = [f"w{i}" for i in range(4000)]
    rng = random.Random(7)
    previous = [" ".join(rng.choice(words) for _ in range(120)) for _ in range(150)]
    current = [" ".join(rng.choice(words) for _ in range(120)) for _ in range(150)]
    started = clock.perf_counter()
    diff = risk_diff(previous, current)
    assert clock.perf_counter() - started < 10.0
    assert diff["addedCount"] + diff["modifiedCount"] == 150


def test_repeated_page_headers_are_not_risk_text() -> None:
    paragraphs = ["Item 1A. Risk Factors", "First risk.", "Item 1A. Risk Factors (continued)", "Second risk.", "Item 2. Other"]
    assert item_1a(paragraphs) == ["First risk.", "Second risk."]


def test_a_real_edgar_index_page_gives_its_exhibits() -> None:
    from pathlib import Path

    page = (Path(__file__).parent / "fixtures" / "sec_filing_index.html").read_text(encoding="utf-8")
    assert parse_exhibits(page) == [
        ("EX-99.1", "/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm"),
        ("EX-99.2", "/Archives/edgar/data/1045810/000104581026000073/q2fy27cfocommentary.htm"),
    ]


async def test_a_failed_ticker_map_refresh_waits_before_trying_again() -> None:
    pages = _pages()
    fake = _Fake(pages)
    mono = [0.0]
    source = SecSource(Http(), fetch=fake, monotonic=lambda: mono[0])
    await source.risk_factors("NVDA", CONTACT)
    del pages["company_tickers.json"]
    mono[0] += 25 * 3600
    await source.risk_factors("NVDA", CONTACT)
    tries = sum(url.endswith("company_tickers.json") for url, _ in fake.seen)
    mono[0] += 30
    await source.risk_factors("NVDA", CONTACT)
    assert sum(url.endswith("company_tickers.json") for url, _ in fake.seen) == tries


def test_trigger_plurals_count() -> None:
    assert risk_diff([], ["Several government investigations are ongoing."])["triggers"] == ["investigation"]


def test_page_numbers_and_contents_links_are_not_risk_text() -> None:
    paragraphs = ["Item 1A. Risk Factors", "First risk.", "34", "Table of Contents", "ii", "Second risk.", "Item 2. Other"]
    assert item_1a(paragraphs) == ["First risk.", "Second risk."]
