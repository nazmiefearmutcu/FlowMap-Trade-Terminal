"""US-equity feed: Crocodile equity providers and Cboe's book viewer -> FeedEvents.

The feed auto-selects a tier from the credentials in
:class:`~flowmap_server.config.Config` and reports each tier's real capability:

============  ================================================================
Tier          What ``events()`` emits
============  ================================================================
keyless       real displayed depth and real prints from Cboe's four US equity
              books (BZX, BYX, EDGX, EDGA): the top five levels per side on each
              book, read every ``dt_equity_book_ns``. Depth is ``L2-snapshot``
              with ``depth_scope='cboe-top5'``: it is not the consolidated
              national book. Prints carry no aggressor side (``side_src=na``),
              so there is no CVD. Price history before the app started comes
              from Yahoo 1 m bars; no depth is known for that period and none
              is drawn.
alpaca (keyed) real **L1** two-sided top-of-book depth (from the streamed BBO) +
              tick tape with side **inferred** (quote rule vs the streamed L1
              BBO), quotes as ``BBO``.
finnhub (keyed) tick tape with side **inferred** (tick rule); no depth / no
              quotes.
============  ================================================================

**Keyless depth.** Each cycle reads the four books together and merges them by
price (sizes summed, in shares). A book that misses a cycle keeps its last read
for a few cycles so the merged depth does not flicker; after
``_BOOK_FAILURES_BEFORE_NOTICE`` cycles with no book at all the depth is
withheld, a ``gap`` marker says so and the feed reports ``degraded``. The grid
advances one column per ``dt_equity_keyless_grid_ns`` on the last merged book.

**Keyless prints.** Each read returns a book's last ten prints. The new ones are
found by overlap with the previous read (see
:func:`~flowmap_server.feeds.equity_book.new_prints`) and emitted as trades
stamped with the venue's own clock and tagged with the book they printed on.
The tape is therefore a sample: prints on other venues, and prints beyond ten
per book per cycle, are not in it (``tape='poll'``). A symbol with no fresh Cboe
print for ``dt_equity_keyless_ns`` falls back to a Google Finance last price so
the chart still moves; that fallback is a display-only price, tagged
``venue='last-price'`` with size 0.

**Warmup** uses the most recent session's bars only, so bar timestamps stay
~1 m apart and the grid never bridges an overnight gap into thousands of empty
columns. Each bar advances the grid with an empty book anchored at the bar's
close.

**Market-closed** — the :class:`~flowmap_server.feeds.base.Feed` protocol's
``FeedEvent`` union has no ``Status`` (that is a session/protocol message), so
this feed exposes the closed state two ways the session layer reads:

- ``feed.feed_state`` (``"live"`` | ``"closed"``) and ``feed.next_open_ts``
  (UTC ns of the next RTH open) — attributes the session layer maps onto
  ``Status{feed_state='closed', next_open_ts=...}``; and
- an in-band ``Marker{kind='session_break', text='market closed — ...'}``.

When closed, the last session's price history still renders; the feed emits
**no** live trades and no depth, and ``events()`` returns after the
session_break so the session layer can schedule a restart at ``next_open_ts``
(``events()`` is re-callable per the Feed restart contract and re-fetches on the
next call).

The session model authority is
:class:`crocodile.core.scheduler.calendar.USMarketCalendar` (America/New_York,
holiday-aware). The keyed tiers are live in its regular session; the keyless
tier is live from 04:00 to 20:00 New York time on its trading days, because the
Cboe books trade before and after the regular session. All time is UTC ns;
``now_ns_fn`` is injected so tests can pin "closed" (a Saturday) vs "open" (a
weekday RTH minute) with no wall-clock dependency, and ``bars_fn`` / ``book_fn``
/ ``price_fn`` / ``sleep_fn`` are injectable seams so pytest never touches the
network.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import logging
import math
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Protocol, cast

import numpy as np

from crocodile.core.schema.records import OHLCV as EqBar
from crocodile.core.scheduler.calendar import MARKET_TZ, USMarketCalendar
from crocodile.core.sink.base import Sink

from flowmap_server.config import Config
from flowmap_server.feeds.base import (
    BarSample,
    BookState,
    BoundedFeedQueue,
    DropCounters,
    FeedEvent,
    ts_ns_sane,
)
from flowmap_server.feeds.equity_book import (
    DEPTH_SCOPE,
    CboeBookClient,
    VenueBook,
    VenuePrint,
    extended_session_state,
    merge_books,
    prints_to_trades,
)
from flowmap_server.feeds.equity_poll import _GooglePricePoller
from flowmap_server.feeds.equity_sink import _EquitySink
from flowmap_server.proto.events import (
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = ["EQUITY_MARKET", "EQUITY_MARKETS", "LAST_PRICE_VENUE", "EquityFeed"]

logger = logging.getLogger(__name__)

# Subscribe.market string routed to EquityFeed by the session feed factory.
EQUITY_MARKET = "equity"
EQUITY_MARKETS = frozenset({EQUITY_MARKET})
# Venue tag of the keyless last-price fallback (not an exchange print or NBBO).
LAST_PRICE_VENUE = "last-price"
# Consecutive failed keyless price polls before the live tape says so (gap Marker).
_POLL_FAILURES_BEFORE_NOTICE = 3
# Consecutive cycles with no Cboe book at all before the depth is withheld.
_BOOK_FAILURES_BEFORE_NOTICE = 3
# A book that misses cycles keeps its last read for this many cycles.
_BOOK_HOLD_CYCLES = 3
# Keyed tiers: no provider event for this long is a silent socket or a stuck
# provider, not a quiet name, so the feed fails and the session restarts it.
# The check cadence bounds how quickly the calendar close is noticed.
_KEYED_EVENT_TIMEOUT_S = 120.0
_KEYED_CHECK_S = 5.0


BarsFn = Callable[[], Awaitable[Sequence[EqBar]]]
BookFn = Callable[[], Awaitable[Sequence[VenueBook]]]
PriceFn = Callable[[], Awaitable[float | None]]
SleepFn = Callable[[float], Awaitable[None]]
NowFn = Callable[[], int]

_EMPTY = np.empty(0, dtype=np.float64)


def _bar_ts(bar: EqBar) -> int:
    """A bar's canonical UTC-ns timestamp (source over local)."""
    return int(bar.source_ts if bar.source_ts is not None else bar.local_ts)


def _bar_finite(bar: EqBar) -> bool:
    """True iff the bar's OHLCV are all finite and volume is non-negative.

    Yahoo bars can carry gaps, and NaN/inf can still slip through resampling.
    Such a bar would poison the price overlay, so it is skipped, never emitted."""
    vals = (bar.open, bar.high, bar.low, bar.close, bar.volume)
    return all(v is not None and math.isfinite(v) for v in vals) and bar.volume >= 0.0


def _empty_book(ts_ns: int, anchor: float | None) -> BookState:
    """A book with no levels: it advances the grid and draws nothing.

    ``anchor`` is the price the grid should stay centred on while there is no
    quote to centre on."""
    return BookState(
        ts_ns=int(ts_ns),
        bid_px=_EMPTY,
        bid_sz=_EMPTY,
        ask_px=_EMPTY,
        ask_sz=_EMPTY,
        anchor_px=anchor,
    )


class _FeedEnd:
    """Queue sentinel for the keyed path: the provider task finished."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


# What the keyed provider task puts on the feed queue: an event or the end.
_EquityItem = FeedEvent | _FeedEnd


def _closed_marker_text(has_history: bool) -> str:
    """session_break text that says whether price history is actually on screen."""
    if has_history:
        return "market closed — price history from the last session"
    return "market closed — no cached history available"


class EquityFeed:
    """Live US-equity feed (implements the Feed protocol).

    ``events()`` is re-callable (Feed restart contract): each call builds fresh
    state, re-fetches bars, and re-evaluates the session window. The tier is
    fixed at construction from ``cfg`` credentials.
    """

    market = EQUITY_MARKET

    def __init__(
        self,
        symbol: str,
        cfg: Config,
        *,
        now_ns_fn: NowFn | None = None,
        bars_fn: BarsFn | None = None,
        book_fn: BookFn | None = None,
        price_fn: PriceFn | None = None,
        sleep_fn: SleepFn | None = None,
        provider_factory: Callable[[_EquitySink], object] | None = None,
        calendar: USMarketCalendar | None = None,
        stats: DropCounters | None = None,
    ) -> None:
        self.symbol = symbol.upper()
        self._cfg = cfg
        self._now_ns: NowFn = now_ns_fn or time.time_ns
        self._bars_fn = bars_fn
        self._book_fn = book_fn
        self._price_fn = price_fn
        self._sleep: SleepFn = sleep_fn or asyncio.sleep
        self._provider_factory = provider_factory
        self._calendar = calendar or USMarketCalendar()

        self._tier = self._select_tier()
        # A per-instance copy: a shared module-level dict would leak any per-feed write.
        self.capability: dict[str, object] = dict(_CAPABILITY[self._tier])

        # Session state the session layer reads to emit Status. Reset at
        # the start of every events() call so a re-called feed starts honest.
        self.feed_state: str = "live"
        self.next_open_ts: int | None = None
        # Consecutive keyless price polls that returned no usable price.
        self.poll_failures = 0
        # Consecutive keyless cycles in which no Cboe book answered.
        self.book_failures = 0

        # Lazily-created default keyless clients (network; never in tests).
        self._poller: _GooglePricePoller | None = None
        self._book_client: CboeBookClient | None = None
        # Server-wide telemetry aggregate (duck-typed). Feeds the
        # drop counters at the source: queue evictions + ts-gate drops.
        self._stats = stats

    def _select_tier(self) -> str:
        cfg = self._cfg
        if cfg.alpaca_key and cfg.alpaca_secret:
            return "alpaca"
        if cfg.finnhub_key:
            return "finnhub"
        return "keyless"

    @property
    def tier(self) -> str:
        """Selected tier: ``"alpaca"`` | ``"finnhub"`` | ``"keyless"``."""
        return self._tier

    def _select_warmup_bars(self, bars: Sequence[EqBar]) -> list[EqBar]:
        """The most recent session's finite, plausibly-stamped bars (grouped by
        ET date), sorted by time. Restricting to one session keeps warmup
        timestamps ~1 m apart so the grid never bridges an overnight/weekend
        gap into empty columns. Bars with implausible stamps
        (non-positive, 1970-era — the ms/ns mixup signature — or absurdly
        future) are dropped at this live-ingestion boundary, never re-gated
        later from recordings."""
        now = self._now_ns()
        finite = sorted(
            (
                b
                for b in bars
                if _bar_finite(b) and ts_ns_sane(_bar_ts(b), now_ns=now)
            ),
            key=_bar_ts,
        )
        if not finite:
            return []
        last_date = self._et_date(_bar_ts(finite[-1]))
        return [b for b in finite if self._et_date(_bar_ts(b)) == last_date]

    @staticmethod
    def _et_date(ts_ns: int) -> datetime.date:
        return (
            datetime.datetime.fromtimestamp(ts_ns / 1e9, tz=datetime.timezone.utc)
            .astimezone(MARKET_TZ)
            .date()
        )

    # -- session model ---------------------------------------------------------

    def _session_state(self, now_ns: int) -> tuple[str, int | None]:
        """(``"open"``|``"closed"``, next_open_ts). Open == RTH per the
        calendar; next_open is the next RTH open strictly after now."""
        dt = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=datetime.timezone.utc)
        if self._calendar.is_market_open(dt):
            return "open", None
        return "closed", self._next_open_ns(dt)

    def _keyless_state(self, now_ns: int) -> tuple[str, int | None]:
        """(``"open"``|``"closed"``, next_open_ts) on the keyless trading window."""
        return extended_session_state(self._calendar, now_ns)

    def is_closed_now(self) -> bool:
        """Whether a keyless warmup can terminate without entering live polling."""
        return self._keyless_state(self._now_ns())[0] == "closed"

    def _next_open_ns(self, now_dt: datetime.datetime) -> int | None:
        et = now_dt.astimezone(MARKET_TZ)
        for add in range(0, 10):
            day = (et + datetime.timedelta(days=add)).date()
            hours = self._calendar.get_market_hours(day)
            if hours is None:
                continue
            open_dt, _close_dt = hours
            if et < open_dt:
                return int(open_dt.timestamp() * 1e9)
        return None  # pragma: no cover — always a trading day within 10 days

    # -- feed protocol ---------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Fresh canonical event stream (re-callable; resumes live)."""
        self.feed_state = "live"
        self.next_open_ts = None
        self.poll_failures = 0
        self.book_failures = 0
        if self._tier == "keyless":
            async for ev in self._keyless_events():
                yield ev
        else:
            async for ev in self._keyed_events():
                yield ev

    # -- keyless (fully implemented) -------------------------------------------

    async def closed_history_events(self) -> AsyncIterator[FeedEvent]:
        """Finite closed-market preparation, even if the calendar opens during I/O.

        Session boot calls this only after is_closed_now(); it cannot get stuck
        in the unbounded live poll loop while no client has attached yet.
        """
        async for ev in self._keyless_events(history_only=True):
            yield ev

    async def _keyless_events(self, *, history_only: bool = False) -> AsyncIterator[FeedEvent]:
        try:
            bars = await self._fetch_bars()
        except Exception:  # a 429 storm must degrade, not kill the feed
            logger.warning(
                "keyless bar fetch failed for %s; starting with no price history",
                self.symbol,
                exc_info=True,
            )
            bars = []
        warmup = self._select_warmup_bars(bars)
        last_bar_ts = 0
        ref: float | None = None
        if warmup and not history_only and not self.is_closed_now():
            # History further back than the grid can hold would be pushed out by
            # the empty columns between it and now. Keep its last close as the
            # anchor and draw nothing for it.
            reach_ns = self._cfg.ring_columns * self._cfg.dt_equity_keyless_grid_ns
            if self._now_ns() - _bar_ts(warmup[-1]) > reach_ns:
                ref = float(warmup[-1].close)
                warmup = []
        for i, bar in enumerate(warmup):
            ts = _bar_ts(bar)
            last_bar_ts = max(last_bar_ts, ts)
            ref = float(bar.close)
            # No depth is known for the time before this process read a book,
            # so the grid advances on an empty one, centred on the bar's close.
            yield _empty_book(ts, ref)
            # Real published bar prices drive the historical overlay. They
            # must not appear as received prints or invent an aggressor side.
            yield BarSample(ts, float(bar.open), float(bar.high), float(bar.low), ref, float(bar.volume))
            if i % 8 == 7:
                # A full session can finalize thousands of 1s columns. Let an
                # unsubscribe/cancellation or another symbol switch through.
                await asyncio.sleep(0)

        now = self._now_ns()
        state, next_open = self._keyless_state(now)
        if state == "closed" or history_only:
            self.feed_state = "closed"
            self.next_open_ts = next_open
            # session_break at the end of the visible history (last bar), or
            # now when there were no warmup bars. A closed market emits no live
            # trades and no depth.
            yield Marker(
                ts_ns=last_bar_ts or now,
                kind="session_break",
                text=_closed_marker_text(bool(warmup)),
            )
            return

        try:
            async for ev in self._keyless_live(ref, has_history=bool(warmup)):
                yield ev
        finally:
            await self._close_clients()

    async def _keyless_live(
        self, ref: float | None, *, has_history: bool
    ) -> AsyncIterator[FeedEvent]:
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
        cfg = self._cfg
        grid_s = cfg.dt_equity_keyless_grid_ns / 1e9
        book_ns = cfg.dt_equity_book_ns
        hold_ns = book_ns * _BOOK_HOLD_CYCLES
        next_book = self._now_ns()
        next_price = next_book
        last_print_ns = next_book
        # Both reads run as their own tasks: a slow response must not hold the
        # one-column-per-grid-tick cadence.
        book_task: asyncio.Task[Sequence[VenueBook]] | None = None
        price_task: asyncio.Task[float | None] | None = None
        held: dict[str, tuple[VenueBook, int]] = {}
        seen: dict[str, tuple[VenuePrint, ...]] = {}
        levels = (_EMPTY, _EMPTY, _EMPTY, _EMPTY)
        try:
            while True:
                now = self._now_ns()
                state, next_open = self._keyless_state(now)
                if state == "closed":
                    self.feed_state = "closed"
                    self.next_open_ts = next_open
                    yield Marker(
                        ts_ns=now,
                        kind="session_break",
                        text=_closed_marker_text(has_history),
                    )
                    return

                if book_task is None and now >= next_book:
                    book_task = asyncio.create_task(
                        self._read_books_safe(now), name=f"equity-book:{self.symbol}"
                    )
                    # Integer-ns arithmetic ONLY: a float offset loses the whole
                    # interval to float64 rounding at ns magnitudes (~1.8e18).
                    next_book = now + book_ns
                if book_task is not None and book_task.done():
                    books = book_task.result()  # _read_books_safe never raises
                    book_task = None
                    if books:
                        self.book_failures = 0
                        self.feed_state = "live"
                        for trade in prints_to_trades(books, seen, now, book_ns, self._stats):
                            ref = trade.price
                            last_print_ns = now
                            yield trade
                        for book in books:
                            held[book.venue] = (book, now)
                    else:
                        self.book_failures += 1
                        if self.book_failures == _BOOK_FAILURES_BEFORE_NOTICE:
                            logger.warning(
                                "order book unavailable for %s after %d failed reads",
                                self.symbol,
                                self.book_failures,
                            )
                            yield Marker(
                                ts_ns=now,
                                kind="gap",
                                text=(
                                    f"order book unavailable after {self.book_failures} "
                                    "failed reads; depth is withheld until it returns"
                                ),
                            )
                        if self.book_failures >= _BOOK_FAILURES_BEFORE_NOTICE:
                            self.feed_state = "degraded"
                    # A book that has not answered for hold_ns is dropped, never
                    # re-drawn as if it were still resting.
                    held = {v: e for v, e in held.items() if now - e[1] <= hold_ns}
                    levels = merge_books(book for book, _read_ns in held.values())

                quiet = now - last_print_ns >= cfg.dt_equity_keyless_ns
                if price_task is None and quiet and now >= next_price:
                    price_task = asyncio.create_task(
                        self._poll_price_safe(), name=f"equity-price-poll:{self.symbol}"
                    )
                    next_price = now + cfg.dt_equity_keyless_ns
                if price_task is not None and price_task.done():
                    price = price_task.result()  # _poll_price_safe never raises
                    price_task = None
                    if price is not None and math.isfinite(price) and price > 0.0:
                        self.poll_failures = 0
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
                        self.poll_failures += 1
                        if self.poll_failures == _POLL_FAILURES_BEFORE_NOTICE:
                            logger.warning(
                                "live price unavailable for %s after %d consecutive failed polls",
                                self.symbol,
                                self.poll_failures,
                            )
                            yield Marker(
                                ts_ns=now,
                                kind="gap",
                                text=(
                                    f"live price unavailable after {self.poll_failures} "
                                    "failed polls; the last trade may be stale"
                                ),
                            )
                # One book per grid tick: the grid advances a column and the
                # current column holds the last merged levels.
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
                await self._sleep(grid_s)
        finally:
            for task in (book_task, price_task):
                if task is not None and not task.done():
                    task.cancel()

    async def _fetch_bars(self) -> Sequence[EqBar]:
        if self._bars_fn is not None:
            return await self._bars_fn()
        return await self._default_fetch_bars()

    async def _default_fetch_bars(self) -> Sequence[EqBar]:
        from flowmap_server.feeds._yahoo import equity_bars

        return await equity_bars(self.symbol)

    async def _read_books_safe(self, now_ns: int) -> Sequence[VenueBook]:
        try:
            if self._book_fn is not None:
                return await self._book_fn()
            if self._book_client is None:
                self._book_client = CboeBookClient(self.symbol)
            return await self._book_client.fetch(now_ns)
        except Exception:  # a missed cycle is reported by the loop; never kill it
            logger.debug("keyless book read failed for %s", self.symbol, exc_info=True)
            return []

    async def _poll_price_safe(self) -> float | None:
        try:
            if self._price_fn is not None:
                return await self._price_fn()
            if self._poller is None:
                self._poller = _GooglePricePoller(self.symbol)
            return await self._poller.poll()
        except Exception:  # a stale tape is honest; never kill the loop
            logger.debug("keyless price poll failed for %s", self.symbol, exc_info=True)
            return None

    async def _close_clients(self) -> None:
        if self._poller is not None:
            await self._poller.close()
            self._poller = None
        if self._book_client is not None:
            await self._book_client.close()
            self._book_client = None

    # -- keyed (structured; lightly tested — no live keys on this machine) ------

    def _closed_now(self) -> bool:
        """Mark the feed closed (for the session layer) when RTH is over."""
        state, next_open = self._session_state(self._now_ns())
        if state != "closed":
            return False
        self.feed_state = "closed"
        self.next_open_ts = next_open
        return True

    async def _keyed_events(self) -> AsyncIterator[FeedEvent]:
        # Keyed tiers follow the same RTH window as the keyless path: outside it
        # they emit a closed session_break and no live stream, never a live status.
        if self._closed_now():
            yield Marker(
                ts_ns=self._now_ns(),
                kind="session_break",
                text=_closed_marker_text(False),
            )
            return
        # Bounded fan-in: same drop-oldest contract as the crypto bridge.
        queue: BoundedFeedQueue[_EquityItem] = BoundedFeedQueue(
            on_drop=self._stats.inc_feed_drops if self._stats is not None else None
        )
        sink = _EquitySink(
            queue.put_nowait,
            use_quote_rule=(self._tier == "alpaca"),
            stats=self._stats,
        )
        provider = self._make_provider(sink)
        runner = asyncio.create_task(
            self._drive_keyed(provider, sink, queue),
            name=f"equity-feed-{self._tier}:{self.symbol}",
        )
        loop = asyncio.get_running_loop()
        last_event = loop.time()
        next_calendar_check = last_event
        try:
            while True:
                # The calendar is checked on its own cadence, not only when the stream
                # goes quiet: liquid names keep printing after the RTH close, and those
                # prints must not keep the feed reported as live.
                if loop.time() >= next_calendar_check:
                    next_calendar_check = loop.time() + _KEYED_CHECK_S
                    if self._closed_now():
                        yield Marker(
                            ts_ns=self._now_ns(),
                            kind="session_break",
                            text=_closed_marker_text(False),
                        )
                        return
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=_KEYED_CHECK_S)
                except TimeoutError:
                    if loop.time() - last_event >= _KEYED_EVENT_TIMEOUT_S:
                        # Raised, not returned: the session restarts the feed with backoff
                        # and reports degraded, the same as a crashed crypto connector.
                        raise RuntimeError(
                            f"no {self._tier} equity events for {_KEYED_EVENT_TIMEOUT_S:g}s "
                            f"({self.symbol})"
                        ) from None
                    continue
                last_event = loop.time()
                if isinstance(ev, _FeedEnd):
                    if ev.exc is not None:
                        raise ev.exc
                    return
                yield ev
        finally:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runner

    def _make_provider(self, sink: _EquitySink) -> object:
        if self._provider_factory is not None:
            return self._provider_factory(sink)
        from crocodile.equity.providers.factory import make_provider
        from crocodile.equity.reference.registry import InstrumentRegistry

        # The engine writes to a Sink; _EquitySink is that surface (see _drive_keyed).
        out = cast(Sink, sink)
        if self._tier == "alpaca":
            return make_provider(
                "alpaca",
                [self.symbol],
                ["trade", "quote"],
                out=out,
                registry=InstrumentRegistry(),
                key=self._cfg.alpaca_key,
                secret=self._cfg.alpaca_secret,
            )
        return make_provider(
            "finnhub",
            [self.symbol],
            ["trade"],
            out=out,
            registry=InstrumentRegistry(),
            token=self._cfg.finnhub_key,
        )

    @staticmethod
    async def _drive_keyed(
        provider: object, sink: _EquitySink, queue: BoundedFeedQueue[_EquityItem]
    ) -> None:
        from crocodile.equity.client.collect import collect
        from crocodile.equity.providers.base import Provider

        watched = _WatchedProvider(provider)
        try:
            # _EquitySink implements the put/flush surface collect drives; it is not a
            # Sink subclass because its put accepts the wider object it is fed. The
            # watcher supplies the run() surface collect() drives (a Provider subclass
            # would inherit the engine's whole base class).
            await collect(
                [cast(Provider, watched)], cast(Sink, sink), max_reconnects=-1
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # forwarded to the consumer
            queue.put_nowait(_FeedEnd(exc))
        else:
            # collect() only logs a provider exception, so the failure is read back
            # from the watcher. A keyed provider runs with max_reconnects=-1 and
            # must never return normally; a clean return is an unexpected end.
            if watched.error is not None:
                queue.put_nowait(_FeedEnd(watched.error))
            else:
                queue.put_nowait(
                    _FeedEnd(RuntimeError("equity provider ended without an error"))
                )


class _RunnableProvider(Protocol):
    """The crocodile provider surface a keyed watcher drives: its ``run`` coroutine."""

    async def run(self, *, max_reconnects: int) -> None: ...


class _WatchedProvider:
    """Wraps a crocodile provider to record how its ``run`` ended.

    ``collect`` isolates provider exceptions and logs them, so the caller cannot
    see them. This wrapper keeps the exception and re-raises it unchanged so the
    supervised behaviour of collect() is untouched.
    """

    def __init__(self, provider: object) -> None:
        self._provider = cast(_RunnableProvider, provider)
        self.error: BaseException | None = None
        self.name = getattr(provider, "name", repr(provider))

    async def run(self, *, max_reconnects: int) -> None:
        try:
            await self._provider.run(max_reconnects=max_reconnects)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = exc
            raise


# Per-tier capability descriptors (dual-market parity table).
#
# ``cvd`` is stated EXPLICITLY per tier so the client can badge it honestly.
# Keyless prints carry NO aggressor side (SIDE_UNKNOWN is never counted
# in grid.on_trade), so its cvd_cum is meaningless -> ``na``; the keyed tiers
# infer side (quote/tick rule) so their CVD is honestly ``inferred`` — never the
# exchange-true ``exchange`` that crypto/sim get. Unavailable capabilities use an
# explicit value (finnhub ``depth: 'N/A'``) rather than omission.
_CAPABILITY: dict[str, dict[str, object]] = {
    "keyless": {
        # Real displayed depth, re-read whole each cycle, from Cboe's four books
        # only: the scope says it is not the consolidated national book.
        "depth": "L2-snapshot",
        "depth_scope": DEPTH_SCOPE,
        "tape": "poll",
        "trade_side": "na",
        "cvd": "na",
        "vwap": "approx",
        "markers": ["gap", "session_break"],
    },
    "alpaca": {
        "depth": "L1",
        "tape": "tick",
        "trade_side": "inferred",
        "cvd": "inferred",
        "vwap": "from_tape",
        # No halt or gap marker: keyed records are not scanned for halts or stalls.
        # session_break is emitted by the calendar gate in _keyed_events.
        "markers": ["session_break"],
    },
    "finnhub": {
        "depth": "N/A",
        "tape": "tick",
        "trade_side": "inferred",
        "cvd": "inferred",
        "vwap": "from_tape",
        "markers": ["session_break"],
    },
}
