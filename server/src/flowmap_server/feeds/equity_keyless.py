"""Keyless equity book/price/tape fan-in, with an independent grid clock."""

from __future__ import annotations
import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from typing import TYPE_CHECKING
import logging
import math
import numpy as np
from flowmap_server.feeds.base import BookState, CvdAnchor, FeedEvent
from flowmap_server.feeds.equity_book import VenueBook, VenuePrint, merge_books, prints_to_trades
from flowmap_server.feeds.equity_public_tape import TapeMessage, TapeState
from flowmap_server.proto.events import SIDE_SRC_NA, SIDE_UNKNOWN, Marker, Trade

if TYPE_CHECKING:
    from flowmap_server.feeds.equity import EquityFeed
logger = logging.getLogger(__name__)
LAST_PRICE_VENUE = "last-price"
_POLL_FAILURES_BEFORE_NOTICE = 3
_BOOK_FAILURES_BEFORE_NOTICE = 3
_BOOK_HOLD_CYCLES = 3
_BOOK_RETRY_NS = 30 * 10**9
_EMPTY = np.empty(0, dtype=np.float64)


async def keyless_live(
    feed: EquityFeed,
    ref: float | None,
    *,
    has_history: bool,
    closed_marker_text: Callable[[bool], str],
) -> AsyncGenerator[FeedEvent, None]:
    """Live keyless loop.

    Every ``dt_equity_book_ns`` the four Cboe books are read together: their
    new prints become trades and their merged levels become the book. The
    grid advances one column per ``dt_equity_keyless_grid_ns`` on the last
    merged book. A symbol with no fresh Cboe print for
    ``dt_equity_keyless_ns`` polls a last price so the chart still moves.
    Stops with a session_break when the extended trading window closes. ``ref`` seeds from
    the last warmup bar's close and then tracks each print: it is where the
    grid stays centred while the book is empty.
    """
    cfg = feed._cfg
    grid_s = cfg.dt_equity_keyless_grid_ns / 1e9
    book_ns = cfg.dt_equity_book_ns
    hold_ns = book_ns * _BOOK_HOLD_CYCLES
    next_book = feed._now_ns()
    next_price = next_book
    next_grid = next_book
    last_print_ns = next_book
    # Both reads run as their own tasks: a slow response must not hold the
    # one-column-per-grid-tick cadence.
    book_task: asyncio.Task[Sequence[VenueBook]] | None = None
    price_task: asyncio.Task[float | None] | None = None
    held: dict[str, tuple[VenueBook, int]] = {}
    seen: dict[str, tuple[VenuePrint, ...]] = {}
    levels = (_EMPTY, _EMPTY, _EMPTY, _EMPTY)
    tape = feed._public_tape_fn() if feed._public_tape_enabled else None

    async def next_tape_message() -> TapeMessage:
        assert tape is not None
        return await anext(tape)

    tape_task = asyncio.create_task(next_tape_message()) if tape is not None else None
    try:
        while True:
            now = feed._now_ns()
            state, next_open = feed._keyless_state(now) if now >= next_grid else ("open", None)
            if state == "closed":
                feed.feed_state = "closed"
                feed.next_open_ts = next_open
                yield Marker(
                    ts_ns=now,
                    kind="session_break",
                    text=closed_marker_text(has_history),
                )
                return

            if tape_task is not None and tape_task.done():
                try:
                    tape_event = tape_task.result()
                except Exception:
                    tape_event = TapeState(False, "public tape stopped")
                    tape_task = None
                else:
                    tape_task = (
                        asyncio.create_task(next_tape_message()) if tape is not None else None
                    )
                if isinstance(tape_event, TapeState):
                    was_active = feed._public_tape_active
                    feed._public_tape_active = tape_event.available
                    feed.capability.update(
                        tape="tick" if tape_event.available else "poll",
                        trade_side="provider" if tape_event.available else "na",
                        cvd="provider" if tape_event.available else "na",
                        vwap="from_tape" if tape_event.available else "approx",
                        public_tape_state="live" if tape_event.available else tape_event.reason,
                    )
                    if tape_event.available and tape_event.anchor_ns is not None:
                        # Grid bars are arrival-aggregated. Anchor this new
                        # capture at observation time, even if the first
                        # execution is a late print. The Trade keeps its
                        # unmodified source timestamp.
                        yield CvdAnchor(now)
                    elif was_active:
                        yield CvdAnchor(now, available=False)
                        yield Marker(
                            ts_ns=now,
                            kind="gap",
                            text="public trade stream interrupted; CVD scope ended",
                        )
                elif feed._public_tape_active:
                    ref = tape_event.price
                    last_print_ns = now
                    feed.capability["tape_last_source_ns"] = str(tape_event.ts_ns)
                    yield tape_event

            if book_task is None and now >= next_book:
                book_task = asyncio.create_task(
                    feed._read_books_safe(now), name=f"equity-book:{feed.symbol}"
                )
                # Integer-ns arithmetic ONLY: a float offset loses the whole
                # interval to float64 rounding at ns magnitudes (~1.8e18).
                next_book = now + book_ns
            if book_task is not None and book_task.done():
                books = book_task.result()  # _read_books_safe never raises
                book_task = None
                if books:
                    feed.book_failures = 0
                    feed.feed_state = "live"
                    for trade in prints_to_trades(books, seen, now, book_ns, feed._stats):
                        if not feed._public_tape_active:
                            ref = trade.price
                            last_print_ns = now
                            yield trade
                    for book in books:
                        held[book.venue] = (book, now)
                else:
                    feed.book_failures += 1
                    if feed.book_failures == _BOOK_FAILURES_BEFORE_NOTICE:
                        logger.warning(
                            "order book unavailable for %s after %d failed reads",
                            feed.symbol,
                            feed.book_failures,
                        )
                        yield Marker(
                            ts_ns=now,
                            kind="gap",
                            text=(
                                f"order book unavailable after {feed.book_failures} "
                                "failed reads; depth is withheld until it returns"
                            ),
                        )
                    if feed.book_failures >= _BOOK_FAILURES_BEFORE_NOTICE:
                        feed.feed_state = "degraded"
                        next_book = now + _BOOK_RETRY_NS

            # Checked every tick, not only on a read: with retries 30 s apart a
            # book that has stopped answering must still drop after hold_ns.
            if now >= next_grid:
                held = {v: e for v, e in held.items() if now - e[1] <= hold_ns}
                levels = merge_books(book for book, _read_ns in held.values())

            quiet = now - last_print_ns >= cfg.dt_equity_keyless_ns
            if price_task is None and quiet and now >= next_price:
                price_task = asyncio.create_task(
                    feed._poll_price_safe(), name=f"equity-price-poll:{feed.symbol}"
                )
                next_price = now + cfg.dt_equity_keyless_ns
            if price_task is not None and price_task.done():
                price = price_task.result()  # _poll_price_safe never raises
                price_task = None
                if price is not None and math.isfinite(price) and price > 0.0:
                    feed.poll_failures = 0
                    # Display-only: a scraped last price is not a print, so it
                    # carries no size and no side.
                    ref = float(price)
                    yield Trade(
                        ts_ns=now,
                        price=float(price),
                        size=0.0,
                        side=SIDE_UNKNOWN,
                        side_src=SIDE_SRC_NA,
                        venue=LAST_PRICE_VENUE,
                    )
                else:
                    feed.poll_failures += 1
                    if feed.poll_failures == _POLL_FAILURES_BEFORE_NOTICE:
                        logger.warning(
                            "live price unavailable for %s after %d consecutive failed polls",
                            feed.symbol,
                            feed.poll_failures,
                        )
                        yield Marker(
                            ts_ns=now,
                            kind="gap",
                            text=(
                                f"live price unavailable after {feed.poll_failures} "
                                "failed polls; the last trade may be stale"
                            ),
                        )
            # One book per grid tick: the grid advances a column and the
            # current column holds the last merged levels.
            if now >= next_grid:
                bid_px, bid_sz, ask_px, ask_sz = levels
                yield BookState(
                    ts_ns=now,
                    bid_px=bid_px,
                    bid_sz=bid_sz,
                    ask_px=ask_px,
                    ask_sz=ask_sz,
                    source="cboe",
                    anchor_px=ref,
                )
                next_grid = now + cfg.dt_equity_keyless_grid_ns
            if tape_task is None:
                await feed._sleep(grid_s)
            else:
                pending = [task for task in (tape_task, book_task, price_task) if task is not None]
                await asyncio.wait(
                    pending,
                    timeout=max(0, (next_grid - feed._now_ns()) / 1e9),
                    return_when=asyncio.FIRST_COMPLETED,
                )
    finally:
        # Cancelled reads are awaited, so the HTTP session closes only after they end.
        tasks = [task for task in (book_task, price_task, tape_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        close_tape = getattr(tape, "aclose", None)
        if close_tape is not None:
            await close_tape()
