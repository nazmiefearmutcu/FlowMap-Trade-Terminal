"""Equity daily change is measured against the previous regular session.

The equity window is five days of one-minute bars. The change must not start
at the first bar of that window (a multi-day move), but at the previous
session's last close, dated in New York time.
"""

from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

import pytest
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV

from flowmap_server.api import market_cache
from flowmap_server.api.market_cache import daily_change_pct

NY = ZoneInfo("America/New_York")


def _ts_ns(day: int, hour: int, minute: int) -> int:
    """A New York wall-clock instant on November ``day``, 2026, as epoch ns."""
    stamp = datetime.datetime(2026, 11, day, hour, minute, tzinfo=NY)
    return int(stamp.timestamp() * 1_000_000_000)


def _bar(ts_ns: int, close: float) -> OHLCV:
    return OHLCV(
        source="yahoo", symbol="ACME", symbol_raw="ACME",
        source_ts=ts_ns, local_ts=ts_ns, asset_class=AssetClass.EQUITY,
        interval="1m", open=close, high=close + 0.1, low=close - 0.1, close=close,
        volume=100.0, vwap=None, num_trades=None,
    )


def _multi_day_bars() -> list[OHLCV]:
    """Day 1 closes at 100 (the previous session), day 2 trades 100 -> 110."""
    return [
        _bar(_ts_ns(4, 9, 30), 90.0),  # earlier session, opening print
        _bar(_ts_ns(4, 15, 59), 100.0),  # previous session's last close
        _bar(_ts_ns(5, 9, 30), 104.0),  # newest session opens
        _bar(_ts_ns(5, 9, 31), 107.0),
        _bar(_ts_ns(5, 15, 59), 110.0),  # last price
    ]


def test_change_uses_the_previous_session_close_not_the_window_start() -> None:
    price, change = daily_change_pct(_multi_day_bars())
    assert price == pytest.approx(110.0)
    # Against the window start (90) the move would read +22.2 %; the daily
    # change is against the previous close (100): +10 %.
    assert change == pytest.approx(10.0)


def test_change_falls_back_to_the_first_close_of_the_newest_session() -> None:
    bars = [_bar(_ts_ns(5, 9, 30), 104.0), _bar(_ts_ns(5, 15, 59), 110.0)]
    price, change = daily_change_pct(bars)
    assert price == pytest.approx(110.0)
    assert change == pytest.approx((110.0 - 104.0) / 104.0 * 100.0)


def test_session_dates_follow_new_york_not_utc() -> None:
    """15:59 New York is 20:59 UTC the same day: still the previous session.
    An instant just after midnight New York is a new session even though UTC
    is still on the previous calendar day."""
    late_prev = _bar(_ts_ns(4, 23, 30), 100.0)  # still Nov 4 in New York
    early_next = _bar(_ts_ns(5, 0, 5), 120.0)  # Nov 5 in New York
    price, change = daily_change_pct([late_prev, early_next])
    assert price == pytest.approx(120.0)
    assert change == pytest.approx(20.0)


def test_no_usable_closes_gives_no_quote_change() -> None:
    assert daily_change_pct([]) is None


@pytest.mark.parametrize("base", [0.0, -1.0])
def test_non_positive_base_gives_no_change_but_keeps_the_price(base: float) -> None:
    bars = [_bar(_ts_ns(4, 15, 59), base), _bar(_ts_ns(5, 9, 30), 0.0001)]
    price, change = daily_change_pct(bars)
    assert price == pytest.approx(0.0001)
    assert change is None


async def test_equity_quote_reports_the_previous_session_change(monkeypatch) -> None:
    async def fake_bars(symbol: str) -> tuple[OHLCV, ...]:
        return tuple(_multi_day_bars())

    import flowmap_server.feeds._yahoo as yahoo

    monkeypatch.setattr(yahoo, "equity_bars", fake_bars)
    quote = await market_cache._equity_quote("acme")
    assert quote.symbol == "ACME"
    assert quote.price == pytest.approx(110.0)
    assert quote.change_pct == pytest.approx(10.0)
