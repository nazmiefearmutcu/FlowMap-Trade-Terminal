"""US-equity feed: Crocodile equity providers -> canonical FeedEvents.

Equities have **no free L2 depth**. This feed therefore auto-selects a tier
from the credentials in :class:`~flowmap_server.config.Config` and expresses
each tier's real capability honestly:

============  ================================================================
Tier          What ``events()`` emits
============  ================================================================
keyless       SYNTH depth — a **two-sided** volume-at-price ladder from Yahoo 1 m
              bars (bid below / ask above the reference price) — a display-only
              last-price tape (``side_src=na``, ``venue='synthetic'``) polled
              every ``dt_equity_keyless_ns``, gaps + session_break markers. **No
              tick tape, no CVD** — the machine has no equity keys, so this is
              the only genuinely-available tier and it must be honest.
alpaca (keyed) real **L1** two-sided top-of-book depth (from the streamed BBO) +
              tick tape with side **inferred** (quote rule vs the streamed L1
              BBO), quotes as ``BBO``.
finnhub (keyed) tick tape with side **inferred** (tick rule); no depth / no
              quotes.
============  ================================================================

**SYNTH volume-at-price** (keyless): each 1 m bar's whole volume is placed at
its typical price ``(H+L+C)/3`` snapped to a cent bucket, accumulated into a
*cumulative* profile. One :class:`BookState` is emitted per bar, its SHAPE
rescaled so the **combined** peak == ``PROFILE_PEAK_TARGET`` and then split at a
**reference price** (that bar's close during warmup, the live last price when
running) into a bid channel (``price <= ref``) and an ask channel (``price >
ref``) — engine ``split_ladder`` semantics. The grid, which time-weights the
previous book over each interval, thus renders a **two-sided** depth-over-time
whose bid/ask boundary walks with price (grid ``mode=L1_BAND``, two channels on
the wire; the badge stays honestly ``SYNTH``). The emitted sizes are a bounded
*relative* intensity, not a share count: a liquid name's cumulative shares (tens
of millions) cast to the grid's float16 ring would overflow to ``inf``, so the
single combined-peak scale bounds every texel while preserving between-bucket
ratios (the point-of-control) and the cross-side bid/ask comparison exactly.
Warmup uses **the most recent session's bars only**, so bar timestamps stay
~1 m apart and the grid never bridges an overnight gap into thousands of empty
columns.

**Market-closed** — the :class:`~flowmap_server.feeds.base.Feed` protocol's
``FeedEvent`` union has no ``Status`` (that is a session/protocol message), so
this feed exposes the closed state two ways the session layer reads:

- ``feed.feed_state`` (``"live"`` | ``"closed"``) and ``feed.next_open_ts``
  (UTC ns of the next RTH open) — attributes the session layer maps onto
  ``Status{feed_state='closed', next_open_ts=...}``; and
- an in-band ``Marker{kind='session_break', text='market closed — ...'}``.

When closed, the warmup SYNTH profile from the last session still renders; the
feed emits **no** live trades (a stale last price is not a print) and does NOT
spam empty live columns — ``events()`` returns after the session_break so the session layer
can schedule a restart at ``next_open_ts`` (``events()`` is re-callable per the
Feed restart contract and re-fetches on the next call).

The session model authority is
:class:`crocodile.core.scheduler.calendar.USMarketCalendar` (America/New_York,
holiday-aware); live polling is gated on its RTH window. All time is UTC ns;
``now_ns_fn`` is injected so tests can pin "closed" (a Saturday) vs "open" (a
weekday RTH minute) with no wall-clock dependency, and ``bars_fn`` / ``price_fn``
/ ``sleep_fn`` are injectable seams so pytest never touches the network.
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

from crocodile.core.schema.records import OHLCV as EqBar
from crocodile.core.scheduler.calendar import MARKET_TZ, USMarketCalendar
from crocodile.core.sink.base import Sink
from crocodile.equity.depth.vap import reference_price as eq_reference_price

from flowmap_server.config import Config
from flowmap_server.feeds.base import (
    BarSample,
    BookState,
    BoundedFeedQueue,
    DropCounters,
    FeedEvent,
    ts_ns_sane,
)
from flowmap_server.feeds.equity_poll import _GooglePricePoller
from flowmap_server.feeds.equity_profile import (
    DEFAULT_PROFILE_TICK,
    PROFILE_PEAK_TARGET,
    _bar_finite,
    _bar_ts,
    _ProfileBuilder,
)
from flowmap_server.feeds.equity_sink import _EquitySink
from flowmap_server.proto.events import (
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = ["DEFAULT_PROFILE_TICK", "EQUITY_MARKET", "EQUITY_MARKETS", "EquityFeed", "PROFILE_PEAK_TARGET"]

logger = logging.getLogger(__name__)

# Subscribe.market string routed to EquityFeed by the session feed factory.
EQUITY_MARKET = "equity"
EQUITY_MARKETS = frozenset({EQUITY_MARKET})
# Keyless last-price display venue tag (not an exchange print or NBBO).
SYNTH_VENUE = "synthetic"
# Live keyless bar refresh cadence (Yahoo: at least 60 s per symbol).
BAR_REFRESH_NS = 60 * 10**9
# Consecutive failed keyless price polls before the live tape says so (gap Marker).
_POLL_FAILURES_BEFORE_NOTICE = 3
# Keyed tiers: no provider event for this long is a silent socket or a stuck
# provider, not a quiet name, so the feed fails and the session restarts it.
# The check cadence bounds how quickly the calendar close is noticed.
_KEYED_EVENT_TIMEOUT_S = 120.0
_KEYED_CHECK_S = 5.0


BarsFn = Callable[[], Awaitable[Sequence[EqBar]]]
PriceFn = Callable[[], Awaitable[float | None]]
SleepFn = Callable[[float], Awaitable[None]]
NowFn = Callable[[], int]


class _FeedEnd:
    """Queue sentinel for the keyed path: the provider task finished."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


# What the keyed provider task puts on the feed queue: an event or the end.
_EquityItem = FeedEvent | _FeedEnd


def _closed_marker_text(has_profile: bool) -> str:
    """session_break text that says whether a profile is actually on screen."""
    if has_profile:
        return "market closed — SYNTH profile from last session"
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
        price_fn: PriceFn | None = None,
        sleep_fn: SleepFn | None = None,
        provider_factory: Callable[[_EquitySink], object] | None = None,
        calendar: USMarketCalendar | None = None,
        profile_tick: float = DEFAULT_PROFILE_TICK,
        bar_refresh_ns: int = BAR_REFRESH_NS,
        stats: DropCounters | None = None,
    ) -> None:
        self.symbol = symbol.upper()
        self._cfg = cfg
        self._now_ns: NowFn = now_ns_fn or time.time_ns
        self._bars_fn = bars_fn
        self._price_fn = price_fn
        self._sleep: SleepFn = sleep_fn or asyncio.sleep
        self._provider_factory = provider_factory
        self._calendar = calendar or USMarketCalendar()
        self._profile_tick = profile_tick
        self._bar_refresh_ns = bar_refresh_ns

        self._tier = self._select_tier()
        # A per-instance copy: a shared module-level dict would leak any per-feed write.
        self.capability: dict[str, object] = dict(_CAPABILITY[self._tier])

        # Session state the session layer reads to emit Status. Reset at
        # the start of every events() call so a re-called feed starts honest.
        self.feed_state: str = "live"
        self.next_open_ts: int | None = None
        # Consecutive keyless price polls that returned no usable price.
        self.poll_failures = 0

        # Lazily-created default keyless price poller (network; never in tests).
        self._poller: _GooglePricePoller | None = None
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

    # -- SYNTH profile (unit-testable in isolation) ----------------------------

    @staticmethod
    def synth_profile(
        bars: Sequence[EqBar],
        *,
        tick: float = DEFAULT_PROFILE_TICK,
        ref: float | None = None,
    ) -> BookState:
        """Aggregate ``bars`` into one **two-sided** volume-at-price BookState.

        The profile's SHAPE is rescaled so its combined peak bucket ==
        ``PROFILE_PEAK_TARGET`` (a bounded relative intensity, not a share count —
        see :meth:`_ProfileBuilder.book_state`) then split at ``ref`` into bid
        (``price <= ref``) and ask (``price > ref``) channels. ``ref`` defaults to
        the last finite bar's close (``crocodile.equity.depth.vap.reference_price``); a
        ``None`` result of that (no finite bars) yields an empty book. ``ts_ns``
        is the newest bar's timestamp (0 if none)."""
        builder = _ProfileBuilder(tick)
        last_ts = 0
        finite: list[EqBar] = []
        for bar in bars:
            if builder.add_bar(bar):
                last_ts = max(last_ts, _bar_ts(bar))
                finite.append(bar)
        if ref is None and finite:
            ref = eq_reference_price(finite)
        return builder.book_state(last_ts, ref)

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

    def is_closed_now(self) -> bool:
        """Whether a keyless warmup can terminate without entering live polling."""
        return self._session_state(self._now_ns())[0] == "closed"

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
                "keyless bar fetch failed for %s; starting with an empty profile "
                "(refresh retries every %ds)",
                self.symbol,
                self._bar_refresh_ns // 10**9,
                exc_info=True,
            )
            bars = []
        warmup = self._select_warmup_bars(bars)
        builder = _ProfileBuilder(self._profile_tick)
        last_bar_ts = 0
        ref: float | None = None
        for i, bar in enumerate(warmup):
            builder.add_bar(bar)
            ts = _bar_ts(bar)
            last_bar_ts = max(last_bar_ts, ts)
            # Reference = this bar's close, so the two-sided split boundary walks
            # with historical price: a genuine bid-below / ask-above depth-over-
            # time as the cumulative volume-profile fills in.
            ref = float(bar.close)
            yield builder.book_state(ts, ref)
            # Real published bar prices drive the historical overlay. They
            # must not appear as received prints or invent an aggressor side.
            yield BarSample(ts, float(bar.open), float(bar.high), float(bar.low), ref, float(bar.volume))
            if i % 8 == 7:
                # A full session can finalize thousands of 1s columns. Let an
                # unsubscribe/cancellation or another symbol switch through.
                await asyncio.sleep(0)

        now = self._now_ns()
        state, next_open = self._session_state(now)
        if state == "closed" or history_only:
            self.feed_state = "closed"
            self.next_open_ts = next_open
            # session_break at the end of the visible profile (last bar), or
            # now when there were no warmup bars. Closed markets render the
            # last session's SYNTH profile and emit NO stale live trades.
            yield Marker(
                ts_ns=last_bar_ts or now,
                kind="session_break",
                text=_closed_marker_text(builder.has_profile()),
            )
            return

        try:
            async for ev in self._keyless_live(builder, last_bar_ts, ref):
                yield ev
        finally:
            await self._close_poller()

    async def _keyless_live(
        self, builder: _ProfileBuilder, last_bar_ts: int, ref: float | None
    ) -> AsyncIterator[FeedEvent]:
        """Live keyless loop: per ``dt_equity_keyless_ns`` poll the last price
        (display-only Trade + the two-sided split reference) and re-assert the
        resting SYNTH profile split at that price every
        ``dt_equity_keyless_grid_ns`` (the grid's column cadence — the heatmap
        right edge advances 1 col/s between the slow 10 s price polls); refresh
        bars every ``bar_refresh_ns``. Stops with a session_break when the RTH
        window closes. ``ref`` seeds from the last warmup bar's close and then
        tracks each valid live price so the bid/ask boundary follows the market."""
        grid_s = self._cfg.dt_equity_keyless_grid_ns / 1e9
        next_refresh = self._now_ns() + self._bar_refresh_ns
        next_poll = self._now_ns()
        # The price scrape runs as its own task: a slow scrape (bounded by
        # _HTTP_TIMEOUT_S) must not hold the one-column-per-grid-tick cadence.
        poll: asyncio.Task | None = None
        stale_announced = False
        try:
            while True:
                now = self._now_ns()
                state, next_open = self._session_state(now)
                if state == "closed":
                    self.feed_state = "closed"
                    self.next_open_ts = next_open
                    yield Marker(
                        ts_ns=now,
                        kind="session_break",
                        text=_closed_marker_text(builder.has_profile()),
                    )
                    return

                if now >= next_refresh:
                    try:
                        for bar in self._select_warmup_bars(await self._fetch_bars()):
                            ts = _bar_ts(bar)
                            if ts > last_bar_ts and builder.add_bar(bar):
                                last_bar_ts = ts
                    except Exception:  # stale profile survives a bad refresh
                        logger.warning(
                            "keyless bar refresh failed for %s; keeping the prior profile",
                            self.symbol,
                            exc_info=True,
                        )
                    next_refresh = now + self._bar_refresh_ns

                # A profile from an earlier ET session must not be re-asserted as the
                # live book (its bars are stamped with that session's clock). Withhold
                # the depth, say which session it is from, and report degraded until a
                # refresh brings the current session.
                stale_date = self._stale_profile_date(last_bar_ts, now)
                if stale_date is not None:
                    self.feed_state = "degraded"
                    if not stale_announced:
                        stale_announced = True
                        yield Marker(
                            ts_ns=now,
                            kind="gap",
                            text=(
                                f"stale profile from {stale_date.isoformat()}: "
                                "live depth withheld until today's bars load"
                            ),
                        )
                else:
                    stale_announced = False
                    self.feed_state = "live"

                if poll is None and now >= next_poll:
                    poll = asyncio.create_task(
                        self._poll_price_safe(), name=f"equity-price-poll:{self.symbol}"
                    )
                    # Integer-ns arithmetic ONLY: a float offset (now + 10.0) loses
                    # the whole poll interval to float64 rounding at ns magnitudes
                    # (~1.8e18, ulp 256 ns) and would poll every column instead.
                    next_poll = now + self._cfg.dt_equity_keyless_ns
                if poll is not None and poll.done():
                    price = poll.result()  # _poll_price_safe never raises
                    poll = None
                    if price is not None and math.isfinite(price) and price > 0.0:
                        self.poll_failures = 0
                        # Display-only tape: google last-price is not a print/NBBO.
                        # The same price is the two-sided split reference so the
                        # bid/ask boundary follows the live market.
                        ref = float(price)
                        yield Trade(
                            ts_ns=now,
                            price=float(price),
                            size=1.0,
                            side=SIDE_UNKNOWN,
                            side_src=SIDE_SRC_NA,
                            venue=SYNTH_VENUE,
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
                if stale_date is None:
                    # Re-assert the resting profile so the grid advances a column and
                    # the current column rolls with the (bar-refreshed) profile, split
                    # two-sided at the latest reference price.
                    yield builder.book_state(now, ref)
                await self._sleep(grid_s)
        finally:
            if poll is not None and not poll.done():
                poll.cancel()

    def _stale_profile_date(self, last_bar_ts: int, now: int) -> datetime.date | None:
        """ET date of the warmup profile when it belongs to an earlier session than
        ``now``; None when the profile is current or there is no profile."""
        if last_bar_ts <= 0:
            return None
        profile_date = self._et_date(last_bar_ts)
        return profile_date if profile_date != self._et_date(now) else None

    async def _fetch_bars(self) -> Sequence[EqBar]:
        if self._bars_fn is not None:
            return await self._bars_fn()
        return await self._default_fetch_bars()

    async def _default_fetch_bars(self) -> Sequence[EqBar]:
        from flowmap_server.feeds._yahoo import equity_bars

        return await equity_bars(self.symbol)

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

    async def _close_poller(self) -> None:
        if self._poller is not None:
            await self._poller.close()
            self._poller = None

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
# ``cvd`` is stated EXPLICITLY per tier so the client can badge it honestly
# Keyless has NO aggressor side (SIDE_UNKNOWN is never counted
# in grid.on_trade), so its cvd_cum is meaningless -> ``na``; the keyed tiers
# infer side (quote/tick rule) so their CVD is honestly ``inferred`` — never the
# exchange-true ``exchange`` that crypto/sim get. Unavailable capabilities use an
# explicit value (finnhub ``depth: 'N/A'``) rather than omission.
_CAPABILITY: dict[str, dict[str, object]] = {
    "keyless": {
        "depth": "SYNTH",
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
