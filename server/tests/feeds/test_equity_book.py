"""Cboe book viewer parsing, merge and print alignment. No network."""

from __future__ import annotations

import datetime

import numpy as np
import pytest

from crocodile.core.scheduler.calendar import MARKET_TZ

from flowmap_server.feeds.equity_book import (
    CBOE_VENUES,
    VenueBook,
    VenuePrint,
    merge_books,
    new_prints,
    parse_venue_book,
)


def _et_ns(y: int, mo: int, d: int, h: int, mi: int = 0, s: int = 0, us: int = 0) -> int:
    dt = datetime.datetime(y, mo, d, h, mi, s, tzinfo=MARKET_TZ)
    return int(dt.timestamp()) * 10**9 + us * 1000


NOW = _et_ns(2026, 7, 15, 12, 50, 22)


def _payload(**data: object) -> dict[str, object]:
    body: dict[str, object] = {
        "symbol": "NVDA",
        "asks": [[155, 160.95], [75, 160.96]],
        "bids": [[100, 160.93], [45, 160.92]],
        "trades": [
            ["12:50:17", "20", "160.91000000", "12:50:17.018000"],
            ["12:50:15", "14", "160.88000000", "12:50:15.088000"],
        ],
        "status": "RegularHours",
    }
    body.update(data)
    return {"success": True, "reload": 5000, "data": body}


def test_the_four_cboe_books_are_read() -> None:
    assert set(CBOE_VENUES) == {"bzx", "byx", "edgx", "edga"}


def test_levels_are_price_size_pairs_best_first() -> None:
    book = parse_venue_book("bzx", _payload(), now_ns=NOW)
    assert book.venue == "bzx"
    assert book.bids == ((160.93, 100.0), (160.92, 45.0))
    assert book.asks == ((160.95, 155.0), (160.96, 75.0))
    assert book.status == "RegularHours"


def test_prints_are_oldest_first_and_carry_the_venue_clock() -> None:
    book = parse_venue_book("bzx", _payload(), now_ns=NOW)
    assert book.prints == (
        VenuePrint(ts_ns=_et_ns(2026, 7, 15, 12, 50, 15, 88_000), price=160.88, size=14.0),
        VenuePrint(ts_ns=_et_ns(2026, 7, 15, 12, 50, 17, 18_000), price=160.91, size=20.0),
    )


def test_a_print_clock_later_than_now_is_the_previous_day() -> None:
    # Read just after midnight ET: a 19:59 print happened yesterday evening.
    after_midnight = _et_ns(2026, 7, 15, 0, 0, 5)
    book = parse_venue_book(
        "edgx",
        _payload(trades=[["19:59:58", "10", "50.0", "19:59:58.500000"]]),
        now_ns=after_midnight,
    )
    assert book.prints[0].ts_ns == _et_ns(2026, 7, 14, 19, 59, 58, 500_000)


def test_a_print_slightly_ahead_of_our_clock_stays_on_today() -> None:
    book = parse_venue_book(
        "edgx",
        _payload(trades=[["12:50:30", "10", "50.0", "12:50:30.000000"]]),
        now_ns=NOW,
    )
    assert book.prints[0].ts_ns == _et_ns(2026, 7, 15, 12, 50, 30)


def test_malformed_rows_are_dropped_not_guessed() -> None:
    book = parse_venue_book(
        "byx",
        _payload(
            bids=[[100, 10.0], [0, 9.99], ["x", 9.98], [50, float("nan")], [25], "junk", [True, 9.5]],
            asks="not a list",
            trades=[
                ["12:50:17", "20", "10.01", "12:50:17.018000"],
                ["12:50:17", "-5", "10.01", "12:50:17.018000"],
                ["bad clock", "5", "10.01", "also bad"],
                ["12:50:16"],
            ],
        ),
        now_ns=NOW,
    )
    assert book.bids == ((10.0, 100.0),)
    assert book.asks == ()
    assert [(p.price, p.size) for p in book.prints] == [(10.01, 20.0)]


def test_an_empty_book_for_a_known_symbol_is_valid() -> None:
    book = parse_venue_book("edga", _payload(bids=[], asks=[], trades=[]), now_ns=NOW)
    assert book.bids == () and book.asks == () and book.prints == ()


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"success": False},
        {"success": True},
        {"success": True, "data": []},
        # Cboe answers 200 for a symbol it does not list.
        {"success": True, "data": {"symbol": "ZZZZQQ", "status": "Unknown", "bids": [], "asks": []}},
    ],
)
def test_a_response_that_is_not_a_book_is_rejected(payload: object) -> None:
    with pytest.raises(ValueError):
        parse_venue_book("bzx", payload, now_ns=NOW)


def _book(venue: str, bids: list[tuple[float, float]], asks: list[tuple[float, float]]) -> VenueBook:
    return VenueBook(venue=venue, bids=tuple(bids), asks=tuple(asks), prints=())


def test_merge_sums_sizes_resting_at_the_same_price() -> None:
    bid_px, bid_sz, ask_px, ask_sz = merge_books(
        [
            _book("bzx", [(10.00, 100.0), (9.99, 50.0)], [(10.01, 30.0)]),
            _book("edgx", [(10.00, 25.0), (9.98, 10.0)], [(10.01, 70.0), (10.02, 5.0)]),
        ]
    )
    assert dict(zip(bid_px.tolist(), bid_sz.tolist(), strict=True)) == {
        9.98: 10.0,
        9.99: 50.0,
        10.00: 125.0,
    }
    assert dict(zip(ask_px.tolist(), ask_sz.tolist(), strict=True)) == {10.01: 100.0, 10.02: 5.0}
    for arr in (bid_px, bid_sz, ask_px, ask_sz):
        assert arr.dtype == np.float64


def test_merge_of_nothing_is_an_empty_book() -> None:
    assert all(arr.size == 0 for arr in merge_books([]))


def _p(second: int, price: float = 10.0, size: float = 1.0) -> VenuePrint:
    return VenuePrint(ts_ns=NOW + second * 10**9, price=price, size=size)


def test_new_prints_are_the_ones_after_the_overlap() -> None:
    previous = [_p(1), _p(2), _p(3)]
    current = [_p(2), _p(3), _p(4), _p(5)]
    assert new_prints(previous, current) == [_p(4), _p(5)]


def test_an_unchanged_read_adds_nothing() -> None:
    read = [_p(1), _p(2), _p(3)]
    assert new_prints(read, read) == []


def test_two_identical_prints_are_both_kept() -> None:
    # Two real fills with the same clock, price and size, then a third.
    previous = [_p(1), _p(2), _p(2)]
    current = [_p(2), _p(2), _p(2)]
    assert new_prints(previous, current) == [_p(2)]


def test_without_overlap_every_print_is_new() -> None:
    assert new_prints([_p(1), _p(2)], [_p(7), _p(8)]) == [_p(7), _p(8)]
    assert new_prints([], [_p(7)]) == [_p(7)]
