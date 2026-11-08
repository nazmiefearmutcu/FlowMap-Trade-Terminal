"""The equity change reference is the previous session's close. NO network.

Yahoo's 5-day, 1-minute window spans several sessions. Measuring the day's change
from the window's first bar made it a five-day change. ``session_reference_close``
picks the close of the last bar dated before the newest bar's New York session,
so the change is always one trading day.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV

from flowmap_server.feeds._yahoo import session_reference_close


def _bar(at: datetime, close: float) -> OHLCV:
    ts = int(at.timestamp() * 1_000_000_000)
    return OHLCV(
        source="yahoo", symbol="AAPL", symbol_raw="AAPL",
        source_ts=ts, local_ts=ts, asset_class=AssetClass.EQUITY,
        interval="1m", open=close, high=close, low=close, close=close, volume=1.0,
        vwap=None, num_trades=None,
    )


# November 2026: US daylight saving ended on 1 November, so New York is UTC-5 here.
# 14:30 UTC is the 09:30 open; 20:59 UTC is the 15:59 close.


def test_no_bars_has_no_reference() -> None:
    assert session_reference_close([]) is None


def test_single_session_falls_back_to_its_first_bar() -> None:
    bars = [_bar(datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc), 100.0),
            _bar(datetime(2026, 11, 2, 20, 59, tzinfo=timezone.utc), 102.0)]
    assert session_reference_close(bars) == 100.0


def test_multi_day_window_measures_from_the_previous_session_close() -> None:
    thu = [_bar(datetime(2026, 10, 29, 14, 30, tzinfo=timezone.utc), 90.0),
           _bar(datetime(2026, 10, 29, 20, 59, tzinfo=timezone.utc), 101.0)]
    fri = [_bar(datetime(2026, 10, 30, 14, 30, tzinfo=timezone.utc), 102.0),
           _bar(datetime(2026, 10, 30, 20, 59, tzinfo=timezone.utc), 103.0)]
    mon = [_bar(datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc), 104.0),
           _bar(datetime(2026, 11, 2, 20, 59, tzinfo=timezone.utc), 110.0)]
    reference = session_reference_close(thu + fri + mon)
    # Friday's close, not the five-day window's first bar (90.0) or Thursday's close.
    assert reference == 103.0
    assert (110.0 - reference) / reference * 100.0 == pytest.approx(6.796, rel=1e-3)


def test_weekend_compares_the_last_session_with_the_one_before_it() -> None:
    # Saturday and Sunday have no bars: the newest session is Friday.
    thu = [_bar(datetime(2026, 10, 29, 14, 30, tzinfo=timezone.utc), 101.0)]
    fri = [_bar(datetime(2026, 10, 30, 14, 30, tzinfo=timezone.utc), 102.0),
           _bar(datetime(2026, 10, 30, 20, 59, tzinfo=timezone.utc), 103.0)]
    assert session_reference_close(thu + fri) == 101.0


def test_session_is_the_new_york_date_not_the_utc_date() -> None:
    # 01:30 UTC on Tuesday is 20:30 on Monday in New York: still Monday's session.
    fri = [_bar(datetime(2026, 10, 30, 20, 59, tzinfo=timezone.utc), 103.0)]
    mon_open = [_bar(datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc), 104.0)]
    mon_late = [_bar(datetime(2026, 11, 3, 1, 30, tzinfo=timezone.utc), 106.0)]
    # A UTC-date reading would make Monday's 14:30 bar the reference (104.0).
    assert session_reference_close(fri + mon_open + mon_late) == 103.0


def test_reference_is_independent_of_the_bars_last_close() -> None:
    thu = [_bar(datetime(2026, 10, 29, 20, 59, tzinfo=timezone.utc), 101.0)]
    mon = [_bar(datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc), 999.0)]
    assert session_reference_close(thu + mon) == 101.0
