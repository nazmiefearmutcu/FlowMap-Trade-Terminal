"""FINRA Reg SHO short-sale volume: parsing, the walk back over days, reuse and failures. No network."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp
from multidict import CIMultiDict, CIMultiDictProxy
import pytest
from yarl import URL

from flowmap_server.research.short_volume import (
    MISSING_DAY_TTL_NS,
    ShortVolumeSource,
    parse_short_volume_file,
)

FIXTURES = Path(__file__).parent / "fixtures"
NEW_YORK = ZoneInfo("America/New_York")
BASE = "https://cdn.finra.org/equity/regsho/daily"
HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market"
HOUR_NS = 3600 * 1_000_000_000


def _ns(year: int, month: int, day: int, hour: int) -> int:
    """The clock reading for a New York wall-clock time."""
    instant = datetime(year, month, day, hour, tzinfo=NEW_YORK).astimezone(UTC)
    return int(instant.timestamp() * 1_000_000_000)


def _status(code: int) -> aiohttp.ClientResponseError:
    request = aiohttp.RequestInfo(
        URL("https://example.invalid/"), "GET", CIMultiDictProxy(CIMultiDict()),
        URL("https://example.invalid/"),
    )
    return aiohttp.ClientResponseError(request, (), status=code)


def _file(day: str, rows: list[tuple[str, float, float, float]]) -> bytes:
    """A CNMS file: header, one row per symbol, and the record-count trailer."""
    lines = [HEADER]
    lines += [f"{day}|{sym}|{short}|{exempt}|{total}|B,Q,N" for sym, short, exempt, total in rows]
    lines.append(str(len(rows)))
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")


class FakeFinra:
    """Stands in for ``Http``: serves the files it holds, answers 403 for the rest.

    ``statuses`` maps a URL to an HTTP status to raise for that URL instead.
    ``fail_with`` raises that status for every URL.
    """

    def __init__(
        self,
        files: dict[str, bytes],
        *,
        fail_with: int | None = None,
        statuses: dict[str, int] | None = None,
    ) -> None:
        self.files = files
        self.fail_with = fail_with
        self.statuses = statuses or {}
        self.calls: list[str] = []

    async def get_bytes(
        self, url: str, *, limit: int, headers: object = None, params: object = None,
        timeout_s: float = 12.0,
    ) -> bytes:
        self.calls.append(url)
        if self.fail_with is not None:
            raise _status(self.fail_with)
        if url in self.statuses:
            raise _status(self.statuses[url])
        if url not in self.files:
            raise _status(403)
        return self.files[url]


class Clock:
    def __init__(self, ns: int) -> None:
        self.ns = ns

    def __call__(self) -> int:
        return self.ns


def _url(day: str) -> str:
    return f"{BASE}/CNMSshvol{day}.txt"


def _week_of_files() -> dict[str, bytes]:
    """Files for Mon 9 to Fri 13 Nov 2026 except Wed 11 (a holiday), plus Fri 6 Nov."""
    nvda = ("NVDA", 100.0, 10.0, 400.0)
    brk = ("BRK/B", 50.0, 5.0, 200.0)
    return {
        _url("20261106"): _file("20261106", [nvda]),
        _url("20261109"): _file("20261109", [nvda, brk]),
        _url("20261110"): _file("20261110", [nvda, brk]),
        _url("20261112"): _file("20261112", [nvda, brk]),
        _url("20261113"): _file("20261113", [nvda, brk]),
    }


# Parsing


def test_real_file_header_rows_and_trailer_parse() -> None:
    rows = parse_short_volume_file((FIXTURES / "short_volume_cnms_20261113.txt").read_bytes())
    assert len(rows) == 8
    brk = rows["BRK.B"]  # FINRA writes BRK/B; the us_symbol form is BRK.B.
    assert brk.short == pytest.approx(825360.417974)
    assert brk.exempt == 367.0
    assert brk.total == pytest.approx(1981230.754409)
    assert "BRK/B" not in rows


def test_a_trailer_that_disagrees_with_the_rows_is_a_truncated_file() -> None:
    raw = f"{HEADER}\r\n20261113|NVDA|1|0|2|B\r\n20261113|AMD|1|0|2|B\r\n3\r\n".encode()
    with pytest.raises(ValueError):
        parse_short_volume_file(raw)


def test_a_file_without_the_reg_sho_header_is_rejected() -> None:
    with pytest.raises(ValueError):
        parse_short_volume_file(b"Date|Symbol|Short\r\n20261113|NVDA|1\r\n")


def test_a_file_without_a_trailer_still_parses() -> None:
    raw = f"{HEADER}\r\n20261113|NVDA|1|0|2|B\r\n".encode()
    assert parse_short_volume_file(raw)["NVDA"].total == 2.0


# The walk back over days


async def test_the_walk_skips_weekends_and_a_missing_day_and_takes_five_files() -> None:
    http = FakeFinra(_week_of_files())
    source = ShortVolumeSource(http, clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")

    assert section.status == "ok"
    assert section.data is not None
    assert section.data["date"] == "2026-11-13"
    assert section.as_of == "2026-11-13"
    # Newest first: 13, 12, 10, 9 and then 6 (11 was missing and is skipped).
    assert [entry["date"] for entry in section.data["days"]] == [
        "2026-11-13", "2026-11-12", "2026-11-10", "2026-11-09", "2026-11-06",
    ]
    weekend = [_url(day) for day in ("20261114", "20261115", "20261107", "20261108")]
    assert not set(http.calls) & set(weekend)
    assert http.calls.count(_url("20261111")) == 1
    assert http.calls.count(_url("20261116")) == 1  # Today's file, not yet published.


async def test_the_data_keys_and_the_five_day_average() -> None:
    http = FakeFinra(_week_of_files())
    source = ShortVolumeSource(http, clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")

    assert section.source == "FINRA Reg SHO"
    assert section.section == "short-volume"
    assert section.data is not None
    assert set(section.data) == {
        "date", "shortVolume", "shortExemptVolume", "totalVolume", "shortRatio",
        "avgShortRatio5d", "days",
    }
    assert section.data["shortVolume"] == 100.0
    assert section.data["shortExemptVolume"] == 10.0
    assert section.data["totalVolume"] == 400.0
    assert section.data["shortRatio"] == pytest.approx(0.25)
    # Every day is 100/400, so the average of the five ratios is 0.25.
    assert section.data["avgShortRatio5d"] == pytest.approx(0.25)


async def test_no_file_at_all_in_the_window_raises() -> None:
    # Every day answering 403 looks like a block, not a holiday week: a fault, not an answer.
    source = ShortVolumeSource(FakeFinra({}), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    with pytest.raises(ConnectionError, match="no FINRA file in the window"):
        await source.short_volume("NVDA")


async def test_after_a_total_outage_the_next_request_asks_again() -> None:
    http = FakeFinra({})
    source = ShortVolumeSource(http, clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    with pytest.raises(ConnectionError):
        await source.short_volume("NVDA")
    http.files.update(_week_of_files())  # FINRA answers again
    section = await source.short_volume("NVDA")
    assert section.status == "ok"


async def test_a_404_counts_as_a_missing_day_like_a_403() -> None:
    files = _week_of_files()
    statuses = {_url("20261111"): 404}
    source = ShortVolumeSource(FakeFinra(files, statuses=statuses), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")
    assert section.status == "ok"
    assert section.data is not None
    assert [entry["date"] for entry in section.data["days"]][-1] == "2026-11-06"


async def test_a_server_error_on_one_day_is_raised_not_a_missing_day() -> None:
    files = _week_of_files()
    statuses = {_url("20261112"): 503}
    source = ShortVolumeSource(FakeFinra(files, statuses=statuses), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await source.short_volume("NVDA")
    assert caught.value.status == 503


# Reuse across symbols and days


async def test_a_second_symbol_reuses_the_parsed_days_without_new_fetches() -> None:
    http = FakeFinra(_week_of_files())
    source = ShortVolumeSource(http, clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    await source.short_volume("NVDA")
    first_round = list(http.calls)
    await source.short_volume("BRK.B")
    second_round = http.calls[len(first_round):]

    # Only today's file (not yet published, never remembered) is asked for again.
    assert second_round == [_url("20261116")]


async def test_a_missing_past_day_is_remembered_for_six_hours_only() -> None:
    http = FakeFinra(_week_of_files())
    clock = Clock(_ns(2026, 11, 16, 10))
    source = ShortVolumeSource(http, clock=clock)  # type: ignore[arg-type]
    await source.short_volume("NVDA")

    clock.ns += HOUR_NS * 5  # Still inside the six hours: not asked again.
    await source.short_volume("NVDA")
    assert http.calls.count(_url("20261111")) == 1

    clock.ns += HOUR_NS * 2  # Past the six hours: asked again.
    await source.short_volume("NVDA")
    assert http.calls.count(_url("20261111")) == 2


async def test_a_transient_block_on_a_past_day_does_not_stick_for_the_process() -> None:
    # 11 Nov answers 403 once (a block), then the file is published. After the memory
    # runs out it must come back into the 5-day window and the average.
    files = _week_of_files()
    files[_url("20261111")] = _file("20261111", [("NVDA", 100.0, 10.0, 400.0)])
    http = FakeFinra(files, statuses={_url("20261111"): 403})
    clock = Clock(_ns(2026, 11, 16, 10))
    source = ShortVolumeSource(http, clock=clock)  # type: ignore[arg-type]
    first = await source.short_volume("NVDA")
    assert first.data is not None
    assert "2026-11-11" not in [entry["date"] for entry in first.data["days"]]

    http.statuses = {}
    clock.ns += MISSING_DAY_TTL_NS
    second = await source.short_volume("NVDA")
    assert second.data is not None
    assert "2026-11-11" in [entry["date"] for entry in second.data["days"]]
    assert len(second.data["days"]) == 5


async def test_today_without_a_file_is_not_remembered() -> None:
    http = FakeFinra(_week_of_files())
    source = ShortVolumeSource(http, clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    await source.short_volume("NVDA")
    await source.short_volume("NVDA")
    assert http.calls.count(_url("20261116")) == 2


async def test_at_most_six_parsed_days_are_kept() -> None:
    files = {_url(f"202611{day:02d}"): _file(f"202611{day:02d}", [("NVDA", 1.0, 0.0, 2.0)])
             for day in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13)}
    clock = Clock(_ns(2026, 11, 6, 10))
    source = ShortVolumeSource(FakeFinra(files), clock=clock)  # type: ignore[arg-type]
    # Walks on four different days cover more than six distinct files in all.
    for day in (6, 10, 13, 17):
        clock.ns = _ns(2026, 11, day, 10)
        await source.short_volume("NVDA")
    assert len(source._parsed) == 6  # noqa: SLF001 - the cap is the behaviour under test


# Symbols that are missing, and ratios


async def test_a_symbol_absent_from_the_newest_file_is_empty_even_if_older_files_have_it() -> None:
    files = _week_of_files()
    files[_url("20261113")] = _file("20261113", [("AAPL", 1.0, 0.0, 2.0)])
    source = ShortVolumeSource(FakeFinra(files), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")
    assert section.status == "empty"
    assert section.reason == "not_in_file"
    assert section.data is None


async def test_a_zero_total_gives_no_ratio_and_is_left_out_of_the_average() -> None:
    files = _week_of_files()
    files[_url("20261113")] = _file("20261113", [("NVDA", 0.0, 0.0, 0.0)])
    source = ShortVolumeSource(FakeFinra(files), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")
    assert section.data is not None
    assert section.data["shortRatio"] is None
    assert section.data["days"][0]["shortRatio"] is None
    assert section.data["avgShortRatio5d"] == pytest.approx(0.25)


async def test_the_average_needs_two_days_with_the_symbol() -> None:
    files = {
        _url("20261113"): _file("20261113", [("NVDA", 100.0, 0.0, 400.0)]),
        _url("20261112"): _file("20261112", [("AAPL", 1.0, 0.0, 2.0)]),
        _url("20261110"): _file("20261110", [("AAPL", 1.0, 0.0, 2.0)]),
        _url("20261109"): _file("20261109", [("AAPL", 1.0, 0.0, 2.0)]),
        _url("20261106"): _file("20261106", [("AAPL", 1.0, 0.0, 2.0)]),
    }
    source = ShortVolumeSource(FakeFinra(files), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("NVDA")
    assert section.data is not None
    assert [entry["date"] for entry in section.data["days"]] == ["2026-11-13"]
    assert section.data["avgShortRatio5d"] is None


async def test_a_class_share_is_found_under_its_dotted_symbol() -> None:
    source = ShortVolumeSource(FakeFinra(_week_of_files()), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    section = await source.short_volume("BRK.B")
    assert section.status == "ok"
    assert section.data is not None
    assert section.data["shortVolume"] == 50.0


async def test_a_source_fault_other_than_a_missing_file_is_raised() -> None:
    source = ShortVolumeSource(FakeFinra({}, fail_with=500), clock=Clock(_ns(2026, 11, 16, 10)))  # type: ignore[arg-type]
    with pytest.raises(aiohttp.ClientResponseError):
        await source.short_volume("NVDA")
