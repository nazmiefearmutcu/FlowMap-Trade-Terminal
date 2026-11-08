"""FINRA Reg SHO dark-pool collector.

The HTTP session is faked; the warehouse is a real DuckDB file in tmp_path.
"""

from __future__ import annotations

from datetime import date

import pytest

from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.darkpool import DarkPoolCollector

PAYLOAD = "\n".join([
    "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market",
    "20240614|AAPL|600|10|1000|Q",
    "20240614|MSFT|100|0|1000|Q",
    "20240614|BAD|x|0|1000|Q",       # non-numeric volume: skipped
    "20240614|ZERO|5|0|0|Q",         # no traded volume: skipped
    "20240614|SHORT|1|2",            # too few fields: skipped
    "",
])


class _Response:
    def __init__(self, text: str = PAYLOAD, status: int = 200) -> None:
        self._text = text
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def text(self, **_):
        return self._text


class _Session:
    def __init__(self, response=None, error: Exception | None = None) -> None:
        self.urls: list[str] = []
        self._response = response
        self._error = error
        self.closed = False

    def get(self, url, **_):
        self.urls.append(url)
        if self._error is not None:
            raise self._error
        return self._response


@pytest.fixture
def warehouse(tmp_path):
    store = DuckWarehouse(tmp_path / "intel.duckdb")
    yield store
    store.close()


def _collector(warehouse, session) -> DarkPoolCollector:
    collector = DarkPoolCollector(warehouse)

    async def _get_session():
        return session

    collector._get_session = _get_session  # type: ignore[method-assign]
    return collector


async def test_parses_valid_rows_and_flags_heavy_short_selling(warehouse):
    collector = _collector(warehouse, _Session(_Response()))
    rows = await collector.fetch_regsho_daily(date(2024, 6, 14))
    by_symbol = {row["symbol"]: row for row in rows}
    assert set(by_symbol) == {"AAPL", "MSFT"}  # malformed and zero-volume rows dropped
    assert by_symbol["AAPL"]["short_ratio"] == 0.6
    # Reg SHO short-sale volume says nothing about institutional accumulation or
    # distribution, so the old "institutional divergence" label must not come back.
    assert all("is_institutional_divergence" not in row for row in rows)
    stored = warehouse._con.execute("SELECT COUNT(*) FROM darkpool_volume").fetchone()[0]
    assert stored == 2  # exactly the accepted rows reach the warehouse


async def test_symbol_filter_applies_before_storage(warehouse):
    collector = _collector(warehouse, _Session(_Response()))
    rows = await collector.fetch_regsho_daily(date(2024, 6, 14), symbols={"msft"})
    assert [row["symbol"] for row in rows] == ["MSFT"]


async def test_weekend_target_is_moved_back_to_friday(warehouse):
    session = _Session(_Response())
    await _collector(warehouse, session).fetch_regsho_daily(date(2024, 6, 15))  # a Saturday
    assert session.urls and session.urls[0].endswith("CNMSshvol20240614.txt")


async def test_a_non_200_answer_yields_nothing_and_stores_nothing(warehouse):
    collector = _collector(warehouse, _Session(_Response(status=503)))
    assert await collector.fetch_regsho_daily(date(2024, 6, 14)) == []
    assert warehouse._con.execute("SELECT COUNT(*) FROM darkpool_volume").fetchone()[0] == 0


async def test_an_empty_or_header_only_day_yields_nothing_and_stores_nothing(warehouse):
    for body in ("", "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"):
        collector = _collector(warehouse, _Session(_Response(text=body)))
        assert await collector.fetch_regsho_daily(date(2024, 6, 14)) == []
    assert warehouse._con.execute("SELECT COUNT(*) FROM darkpool_volume").fetchone()[0] == 0


async def test_a_transport_failure_yields_nothing(warehouse):
    collector = _collector(warehouse, _Session(error=OSError("network down")))
    assert await collector.fetch_regsho_daily(date(2024, 6, 14)) == []
