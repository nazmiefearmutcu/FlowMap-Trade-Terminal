"""Keyless US-equity order book: Cboe's public book viewer.

Cboe publishes, for each of its four US equity exchanges (BZX, BYX, EDGX and
EDGA), the top five displayed price levels per side and the last ten prints of
any listed symbol. The page reloads itself every five seconds; this module reads
the same JSON at the same cadence.

What it is: real displayed orders and real prints on those four books.
What it is not: a consolidated national book. NYSE, Nasdaq and every other venue
are absent, and each side stops at five levels per exchange. The capability the
feed reports says so (``depth: 'L2-snapshot'``, ``depth_scope: 'cboe-top5'``).

Everything here is pure except :class:`CboeBookClient`, so the parsing, the
merge and the print alignment are tested without a network.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import logging
import math
import ssl
from collections.abc import Iterable, Sequence
from urllib.parse import quote

import msgspec
import numpy as np

from crocodile.core.scheduler.calendar import MARKET_TZ, USMarketCalendar

from flowmap_server.feeds.base import DropCounters, ts_ns_sane
from flowmap_server.proto.events import SIDE_SRC_NA, SIDE_UNKNOWN, Trade

__all__ = [
    "CBOE_VENUES",
    "DEPTH_SCOPE",
    "CboeBookClient",
    "VenueBook",
    "VenuePrint",
    "extended_session_state",
    "merge_books",
    "new_prints",
    "parse_venue_book",
    "prints_to_trades",
]

logger = logging.getLogger(__name__)

# The four Cboe US equity books, largest first.
CBOE_VENUES: tuple[str, ...] = ("edgx", "bzx", "byx", "edga")
# Capability tag for this source: which books, and how deep.
DEPTH_SCOPE = "cboe-top5"

_BOOK_URL = "https://www.cboe.com/json/{venue}/book/{symbol}"
_REFERER = "https://www.cboe.com/us/equities/market_statistics/book/{symbol}/"
# One read of the four books must cost one cycle, not the feed loop.
_HTTP_TIMEOUT_S = 8.0
# A venue clock that reads slightly ahead of ours is the same day, not yesterday.
_CLOCK_SLACK_NS = 120 * 10**9
_DAY_NS = 24 * 60 * 60 * 10**9
# Trading window of the Cboe books, New York time: pre-market open to after-hours close.
EXTENDED_OPEN = datetime.time(4, 0)
EXTENDED_CLOSE = datetime.time(20, 0)


class VenuePrint(msgspec.Struct, frozen=True):
    """One print on one Cboe book. ``ts_ns`` is the venue's own stamp, UTC ns."""

    ts_ns: int
    price: float
    size: float


class VenueBook(msgspec.Struct, frozen=True):
    """One Cboe book as read: displayed levels and its latest prints.

    ``bids`` and ``asks`` are ``(price, size)`` pairs, best first. ``prints`` runs
    oldest to newest.
    """

    venue: str
    bids: tuple[tuple[float, float], ...]
    asks: tuple[tuple[float, float], ...]
    prints: tuple[VenuePrint, ...]
    status: str = ""


def _positive(value: object) -> float | None:
    """``value`` as a finite float above zero, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and number > 0.0 else None


def _levels(raw: object) -> tuple[tuple[float, float], ...]:
    """``[[size, price], ...]`` as ``(price, size)`` pairs; bad rows are dropped."""
    if not isinstance(raw, list):
        return ()
    out: list[tuple[float, float]] = []
    for row in raw:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        size, price = _positive(row[0]), _positive(row[1])
        if size is not None and price is not None:
            out.append((price, size))
    return tuple(out)


def _print_ts(clock: object, now_ns: int) -> int | None:
    """An Eastern ``HH:MM:SS[.ffffff]`` clock reading as UTC ns on today's date.

    The book viewer sends no date. A reading later than now belongs to the
    previous day, apart from a small allowance for clock skew.
    """
    if not isinstance(clock, str):
        return None
    try:
        parsed = datetime.time.fromisoformat(clock.strip())
    except ValueError:
        return None
    today = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=MARKET_TZ).date()
    stamp = datetime.datetime.combine(today, parsed, tzinfo=MARKET_TZ)
    ts_ns = int(stamp.timestamp()) * 10**9 + parsed.microsecond * 1000
    if ts_ns > now_ns + _CLOCK_SLACK_NS:
        ts_ns -= _DAY_NS
    return ts_ns


def _prints(raw: object, now_ns: int) -> tuple[VenuePrint, ...]:
    """``[[clock, size, price, clock_us], ...]`` newest first, as prints oldest first."""
    if not isinstance(raw, list):
        return ()
    out: list[VenuePrint] = []
    for row in raw:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        size, price = _positive(row[1]), _positive(row[2])
        ts_ns = _print_ts(row[3] if len(row) > 3 else row[0], now_ns)
        if ts_ns is None:
            ts_ns = _print_ts(row[0], now_ns)
        if size is None or price is None or ts_ns is None:
            continue
        out.append(VenuePrint(ts_ns=ts_ns, price=price, size=size))
    out.reverse()
    return tuple(out)


def parse_venue_book(venue: str, payload: object, *, now_ns: int) -> VenueBook:
    """One decoded book-viewer response as a :class:`VenueBook`.

    Raises ``ValueError`` for a response that is not a book (a failed request, a
    symbol Cboe does not know). An empty book for a known symbol is valid.
    """
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError(f"{venue}: book request was not successful")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError(f"{venue}: book response carries no data")
    status = str(data.get("status") or "")
    if status.lower() == "unknown":
        raise ValueError(f"{venue}: symbol is not listed on this book")
    return VenueBook(
        venue=venue,
        bids=_levels(data.get("bids")),
        asks=_levels(data.get("asks")),
        prints=_prints(data.get("trades"), now_ns),
        status=status,
    )


def _side(levels: Iterable[tuple[float, float]]) -> tuple[np.ndarray, np.ndarray]:
    """Sum sizes resting at the same price across books."""
    totals: dict[float, float] = {}
    for price, size in levels:
        totals[price] = totals.get(price, 0.0) + size
    prices = np.fromiter(sorted(totals), dtype=np.float64, count=len(totals))
    sizes = np.fromiter((totals[p] for p in prices.tolist()), dtype=np.float64, count=len(totals))
    return prices, sizes


def merge_books(
    books: Iterable[VenueBook],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """The books as one ``(bid_px, bid_sz, ask_px, ask_sz)``, sizes summed per price.

    Nothing is invented or removed: a level is the sum of what the books display
    at that price. Two books read a moment apart can leave the merged inside
    locked or crossed; that is left as read.
    """
    held = list(books)
    bid_px, bid_sz = _side(level for book in held for level in book.bids)
    ask_px, ask_sz = _side(level for book in held for level in book.asks)
    return bid_px, bid_sz, ask_px, ask_sz


def new_prints(previous: Sequence[VenuePrint], current: Sequence[VenuePrint]) -> list[VenuePrint]:
    """The prints in ``current`` that were not in ``previous``.

    Each read returns the last ten prints, so consecutive reads overlap. The new
    ones are found by the longest overlap between the end of the previous read and
    the start of this one, which keeps two genuine prints with the same time,
    price and size. With no overlap every print is new (more than ten printed
    between reads, and the ones in between were never seen).
    """
    cur = list(current)
    prev = list(previous)
    for overlap in range(min(len(cur), len(prev)), 0, -1):
        if cur[:overlap] == prev[len(prev) - overlap:]:
            return cur[overlap:]
    return cur


def extended_session_state(
    calendar: USMarketCalendar, now_ns: int
) -> tuple[str, int | None]:
    """(``"open"``|``"closed"``, next_open_ts) on the Cboe trading window.

    The books trade before and after the regular session, so the window runs
    from ``EXTENDED_OPEN`` to ``EXTENDED_CLOSE`` New York time on every trading
    day. next_open is the next such open after now, in UTC ns."""
    et = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=datetime.timezone.utc).astimezone(
        MARKET_TZ
    )
    for add in range(0, 10):
        day = (et + datetime.timedelta(days=add)).date()
        if calendar.get_market_hours(day) is None:
            continue
        open_dt = datetime.datetime.combine(day, EXTENDED_OPEN, tzinfo=MARKET_TZ)
        close_dt = datetime.datetime.combine(day, EXTENDED_CLOSE, tzinfo=MARKET_TZ)
        if open_dt <= et < close_dt:
            return "open", None
        if et < open_dt:
            return "closed", int(open_dt.timestamp() * 1e9)
    return "closed", None  # pragma: no cover — always a trading day within 10 days


def prints_to_trades(
    books: Sequence[VenueBook],
    seen: dict[str, tuple[VenuePrint, ...]],
    now_ns: int,
    cycle_ns: int,
    stats: DropCounters | None = None,
) -> list[Trade]:
    """The prints these reads add to the tape, oldest first; updates ``seen``.

    A book read for the first time contributes only the prints of the last
    cycle: its older ones happened before the feed was watching. A print with an
    implausible stamp is dropped and counted. No venue publishes the aggressor
    here, so every trade carries an unknown side.
    """
    fresh: list[tuple[VenuePrint, str]] = []
    for book in books:
        previous = seen.get(book.venue)
        if previous is None:
            added = [p for p in book.prints if p.ts_ns >= now_ns - cycle_ns]
        else:
            added = new_prints(previous, book.prints)
        seen[book.venue] = book.prints
        fresh.extend((p, book.venue) for p in added)
    fresh.sort(key=lambda item: item[0].ts_ns)
    trades: list[Trade] = []
    for item, venue in fresh:
        if not ts_ns_sane(item.ts_ns, now_ns=now_ns):
            if stats is not None:
                stats.inc_feed_drops()
            continue
        trades.append(
            Trade(
                # The venue's own stamp, never later than our clock.
                ts_ns=min(item.ts_ns, now_ns),
                price=item.price,
                size=item.size,
                side=SIDE_UNKNOWN,
                side_src=SIDE_SRC_NA,
                venue=venue.upper(),
            )
        )
    return trades


class CboeBookClient:
    """Reads the four Cboe books for one symbol. Owns its aiohttp session."""

    def __init__(self, symbol: str, venues: Sequence[str] = CBOE_VENUES) -> None:
        self._symbol = symbol.upper()
        self._venues = tuple(venues)
        self._session: object | None = None

    async def fetch(self, now_ns: int) -> list[VenueBook]:
        """Every book that answered this cycle; an empty list when none did."""
        import aiohttp
        import certifi

        session = self._session
        if not isinstance(session, aiohttp.ClientSession) or session.closed:
            context = ssl.create_default_context(cafile=certifi.where())
            session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_HTTP_TIMEOUT_S),
                connector=aiohttp.TCPConnector(ssl=context),
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": _REFERER.format(symbol=quote(self._symbol, safe="")),
                },
            )
            self._session = session
        results = await asyncio.gather(
            *(self._fetch_venue(session, venue, now_ns) for venue in self._venues),
            return_exceptions=True,
        )
        books: list[VenueBook] = []
        for venue, result in zip(self._venues, results, strict=True):
            if isinstance(result, VenueBook):
                books.append(result)
            elif isinstance(result, asyncio.CancelledError):
                raise result
            else:
                logger.debug("cboe %s book read failed for %s: %r", venue, self._symbol, result)
        return books

    async def _fetch_venue(self, session: object, venue: str, now_ns: int) -> VenueBook:
        import aiohttp

        assert isinstance(session, aiohttp.ClientSession)
        url = _BOOK_URL.format(venue=venue, symbol=quote(self._symbol, safe=""))
        async with session.get(url) as response:
            response.raise_for_status()
            payload = await response.json(content_type=None)
        return parse_venue_book(venue, payload, now_ns=now_ns)

    async def close(self) -> None:
        import aiohttp

        session = self._session
        self._session = None
        if isinstance(session, aiohttp.ClientSession) and not session.closed:
            with contextlib.suppress(Exception):
                await session.close()
