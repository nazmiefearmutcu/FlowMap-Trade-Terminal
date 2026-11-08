"""Session: one stream per key (feed task, grid, status and the run loop)."""

from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import msgspec

from flowmap_server.core.backfill import (
    DEFAULT_BACKFILL_STRETCH,
    BackfillFn,
)
from flowmap_server.core.grid import Grid
from flowmap_server.core.overview import (
    OverviewCache,
)
from flowmap_server.core.record import Recorder, SessionRecorder
from flowmap_server.core.session_book import BookMixin
from flowmap_server.core.session_boot import BootMixin
from flowmap_server.core.session_common import (
    _BACKOFF_CAP_S,
    _MARKERS_CAP,
    _STABLE_EVENTS,
    _STABLE_NS,
    CAPABILITY_STATUS_INTERVAL_NS,
    FLUSH_INTERVAL_NS,
    GRACE_S,
    SESSION_LOGGER,
    SNAPSHOT_TAPE,
    Clock,
    Timer,
    TimerHandle,
    _default_timer,
)
from flowmap_server.core.session_fanout import FanoutMixin
from flowmap_server.core.session_history import HistoryMixin
from flowmap_server.core.session_queue import ClientTx
from flowmap_server.core.session_recording import RecordingMixin
from flowmap_server.core.stats import SessionStats
from flowmap_server.feeds.base import BarSample, BookState, Feed
from flowmap_server.feeds.crypto import is_crypto_market
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.proto import events, wire

logger = logging.getLogger(SESSION_LOGGER)


class Session(BootMixin, RecordingMixin, FanoutMixin, BookMixin, HistoryMixin):
    """One live stream per (market, symbol, mode[, source]): feed + grid.

    Broadcast fan-out pre-encodes each message once and offers the same bytes
    to every attached client; lag/drop bookkeeping happens inside each
    :class:`ClientTx`.
    """

    def __init__(
        self,
        session_id: str,
        *,
        feed: Feed,
        grid: Grid,
        clock: Clock = time.monotonic_ns,
        timer: Timer = _default_timer,
        on_teardown: Callable[[], None] | None = None,
        flush_interval_ns: int = FLUSH_INTERVAL_NS,
        restart_backoff_base_s: float = 1.0,
        grace_s: float = GRACE_S,
        recorder: Recorder | None = None,
        wall_clock: Clock = time.time_ns,
        backfill_fn: BackfillFn | None = None,
        backfill_max_cols: int = 0,
        backfill_stretch: int = DEFAULT_BACKFILL_STRETCH,
        stats: SessionStats | None = None,
        rec_flush_interval_s: float = 10.0,
        retention_min_interval_s: float = 60.0,
    ) -> None:
        self.session_id = session_id
        self.run_task: asyncio.Task | None = None
        self._feed = feed
        self._grid = grid
        self._clock = clock
        self._timer = timer
        self._on_teardown = on_teardown
        self._flush_interval_ns = flush_interval_ns
        self._backoff_base_s = restart_backoff_base_s
        self._backoff_s = restart_backoff_base_s
        self._grace_s = grace_s
        # Server-wide telemetry aggregate. None (bare tests)
        # simply skips every counter — behavior is identical without it.
        self._stats = stats
        # Full-jitter source for restart backoff: all sessions of a venue that
        # died together used to restart in lockstep every backoff step.
        self._rng = random.Random()

        self._init_recording(
            recorder=recorder,
            wall_clock=wall_clock,
            rec_flush_interval_s=rec_flush_interval_s,
            retention_min_interval_s=retention_min_interval_s,
            backfill_fn=backfill_fn,
            backfill_max_cols=backfill_max_cols,
            backfill_stretch=backfill_stretch,
        )

        self._clients: set[ClientTx] = set()
        self._grace_handle: TimerHandle | None = None
        self._closed = False

        # Pre-encoded finalized columns (col_seq -> joined depth+bar frame
        # bytes), LRU-capped at the snapshot window. _snapshot_frames serves
        # attaches from this cache instead of re-encoding up to 512 columns
        # (~8-16 MB) inline on the event loop per attach; entries are written
        # ONCE at finalize time by the exact encoder calls the snapshot path
        # used to make, so the wire bytes are identical.
        self._enc_cache: OrderedDict[int, bytes] = OrderedDict()

        self._last_col_seq: int | None = None  # dedup: grid may re-return a column
        # Forming depth column last broadcast. Re-sent only when it changes:
        # between book updates the integral is constant (see _flush_partial).
        self._last_partial_depth: events.DepthColumn | None = None
        self._last_partial_bar: events.BarColumn | None = None
        self._last_flush_ns = clock()
        self._feed_state: events.FeedState = "live"
        self._next_capability_status_ns = clock() + CAPABILITY_STATUS_INTERVAL_NS
        self._last_capability_status_payload: bytes | None = None
        self._recovery_start_ns = clock()
        self._recovery_events = 0
        self._tape: deque[events.Trade] = deque(maxlen=SNAPSHOT_TAPE)
        # Last Trade.seq stamped at ingest (see _next_trade_seq).
        self._trade_seq = 0
        self._markers: deque[events.Marker] = deque(maxlen=_MARKERS_CAP)
        self._bbo: events.BBO | None = None
        self._instant_book: bytes | None = None

    def _init_recording(
        self,
        *,
        recorder: Recorder | None,
        wall_clock: Clock,
        rec_flush_interval_s: float,
        retention_min_interval_s: float,
        backfill_fn: BackfillFn | None,
        backfill_max_cols: int,
        backfill_stretch: int,
    ) -> None:
        """Recording, overview, replay-tail and boot/backfill state (see __init__)."""
        # Recording (module docstring): the root opens the per-symbol writer
        # and serves load_tail at boot; wall_clock (injectable) is the
        # freshness reference — recorded timestamps are UTC wall ns.
        self._recorder_root = recorder
        self._wall_clock = wall_clock
        self._rec: SessionRecorder | None = None
        # Logical recording id, remembered after the recorder is gone (see
        # _recording_identity): history reads must keep addressing the same
        # on-disk timeline even when recording was disabled mid-session.
        self._known_recording_id: str | None = None
        # Proven legacy cadence segments from successful preload only. A new
        # writer UUID must not hide compatible old no-ID depth after eviction.
        self._legacy_history_segments: list[tuple[int, int, int]] = []
        self._overview_cache = OverviewCache()
        self._overview_lock = asyncio.Lock()
        # One worker for every overview step. asyncio.to_thread cannot be
        # cancelled, so a cancelled request used to leave its thread mutating
        # the unlocked OverviewCache while the next request ran. A
        # single worker runs the orphan to completion before the successor.
        self._overview_executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="flowmap-overview"
        )
        self._overview_prewarm_task: asyncio.Task | None = None
        self._overview_source_generation: str | None = None
        # True while the last overview step overran its deadline (see
        # _overview_call); published as capability.overview_degraded.
        self._overview_degraded = False
        # Consecutive in-memory append failures (see _record / _REC_APPEND_FAIL_LIMIT).
        self._rec_append_failures = 0
        # Flush-failure retry state (see _REC_RETRY_* above): consecutive
        # failures size the cooldown; the retry is skipped while the cooldown
        # is active. Both reset on any successful flush.
        self._rec_failures = 0
        self._rec_retry_at: int | None = None
        # Time-based flush cadence (FLOWMAP_FLUSH_INTERVAL_S): buffers are
        # flushed once they have been accumulating this long even below the
        # REC_FLUSH_COLS column cadence, so a hard close loses seconds, not a
        # whole part. _rec_cadence_ns restarts at every successful flush.
        self._rec_flush_interval_ns = max(0, int(rec_flush_interval_s * 1e9))
        self._rec_cadence_ns = self._clock()
        # Retention walk min-interval (FLOWMAP_RETENTION_MIN_INTERVAL_S): the
        # rglob+stat pass over the recording root runs at most this often.
        self._retention_min_interval_ns = max(0, int(retention_min_interval_s * 1e9))
        self._last_retention_ns: int | None = None
        # Newest t0_ns of the recording this session's replay feed was built
        # from. None for live sessions; SessionManager sets it when it builds
        # a replay session and re-checks it on every re-attach to the same
        # key (parked-replay freshness policy).
        self.replay_tail_t0: int | None = None
        # Exclusive end of a WINDOWED replay ([start_t, end_t)); None for an
        # unbounded one. A bounded window is immutable history — growth of the
        # recording past its end is expected, so the parked-replay freshness
        # re-check is a no-op for such sessions (see _recheck_replay_freshness).
        self.replay_window_end_ns: int | None = None
        # Per-connection stats hook: the WS layer installs a callable returning
        # {"latency_ms": float, "clock_skew_ms": float} measured on THIS
        # connection; Status broadcasts consume it for real values instead of
        # hardcoded 0.0. None means no hook, so the broadcast reports zeros.
        self.conn_stats: Callable[[], dict] | None = None
        self._cols_since_flush = 0
        self._flush_task: asyncio.Task | None = None
        self._recording_close_task: asyncio.Task | None = None
        self._recording_finish_lock = asyncio.Lock()
        # Stall watchdog state (see _REC_STALL_S): when the in-flight flush
        # task was created, and whether its stall was already reported.
        self._flush_started_ns: int | None = None
        self._flush_stall_logged = False
        # Published to clients (capability.recording_health and
        # recording_degraded) while a flush is wedged, so a stopped recording is
        # visible to the user. Cleared when the stalled write completes.
        self._recording_wedged = False
        self._boot_done = False
        self._start_lock = asyncio.Lock()

        # First-launch history backfill: a cold subscribe seeds the ring
        # with reconstructed candle history so the client's eager requestHistory
        # returns real data. Runs in _boot only when no Parquet tail rehydrated.
        # When it seeds columns the session badges Hello/Status capability with
        # ``history: 'reconstructed'`` (candle volume-at-price, not resting L2).
        self._backfill_fn = backfill_fn
        self._backfill_max_cols = backfill_max_cols
        self._backfill_stretch = backfill_stretch
        self._history_reconstructed = False
        # A keyless equity feed replays its provider warmup on every attach.
        # A preloaded tail already owns those timestamps; never append the
        # same session again after it with increasing seq and decreasing time.
        self._equity_warmup_before_ns = 0
        self._preparing_closed_history = False
        self._closed_history_prepared = False

    # -- lifecycle -------------------------------------------------------------

    async def start(self) -> asyncio.Task | None:
        """Boot (open recorder + rehydrate, once) and start the feed task.

        Idempotent and restart-safe. The boot phase runs BEFORE the run task
        exists and before the caller attaches, so the first subscriber's
        snapshot already contains the rehydrated tail; the lock makes a
        concurrent second subscriber wait for the same boot instead of racing
        it. ``load_tail`` executes in the default executor — the event loop
        (other sessions, other clients) never blocks on Parquet IO.

        Returns ``None`` when the session was torn down while booting (a
        grace-timer or band-replacement teardown fires during the seconds-long
        boot await — boot holds no clients, so it is teardown-eligible). In
        that case ``_teardown`` has already run and can NEVER run again
        (``_closed`` is a one-way latch), so starting ``run()`` here would leak
        a live feed task plus a full ring, broadcasting to zero clients
        forever; the caller re-subscribes instead.
        """
        async with self._start_lock:
            # A session retired by a failed earlier start or by
            # teardown must never boot again: that would reopen a recorder
            # nothing will ever close.
            if self._closed:
                return None
            if self.run_task is None or self.run_task.done():
                if not self._boot_done:
                    # Set the flag only AFTER boot returns: if the awaiting
                    # subscriber is cancelled inside the load_tail executor
                    # (CancelledError bypasses _boot's except Exception), the
                    # flag stays False so a later subscriber retries boot
                    # instead of running with recording/rehydration silently off.
                    await self._boot()
                    self._boot_done = True
                elif not self._closed_history_prepared:
                    await self._prepare_closed_history()
                if self._closed:
                    return None
                self.run_task = asyncio.create_task(self.run(), name=f"session-{self.session_id}")
                if self._recorder_root is not None and self._overview_prewarm_task is None:
                    self._overview_prewarm_task = asyncio.create_task(
                        self._prewarm_overview_index(), name=f"history-index-{self.session_id}"
                    )
        return self.run_task

    @property
    def feed(self) -> Feed:
        """The feed this session drains (a live adapter or a recording replay)."""
        return self._feed

    @property
    def grid(self) -> Grid:
        """The density grid that serves snapshots, history and export."""
        return self._grid

    @property
    def feed_state(self) -> events.FeedState:
        """Last published feed state: live, degraded, closed or reconnecting."""
        return self._feed_state

    def teardown_now(self) -> None:
        """Tear down immediately, skipping the detach grace period.

        Used when a session is being REPLACED (a price-band switch on the same
        symbol): waiting out ``GRACE_S`` would pin a whole ring
        (``ring_columns*2*rows*2`` bytes) for a minute and can trip
        ``max_sessions``. Safe on an already-closed or still-watched session —
        ``_teardown`` returns early in both cases.
        """
        if self._grace_handle is not None:
            self._grace_handle.cancel()
            self._grace_handle = None
        self._teardown()

    def _teardown(self) -> None:
        if self._clients or self._closed:  # re-attached during grace / already down
            return
        self._closed = True
        self._grace_handle = None
        if self.run_task is not None:
            self.run_task.cancel()
        if self._overview_prewarm_task is not None:
            self._overview_prewarm_task.cancel()
        # No overview request can arrive once the session is retired: let the
        # worker thread exit instead of idling until the session is collected.
        self._overview_executor.shutdown(wait=False)
        # Retire the writer asynchronously after the cancelled feed has
        # drained its admitted flush. Disk close and the retention walk must
        # never run in this timer callback on the server's event loop.
        if self._rec is not None or self.run_task is not None:
            self._recording_close_task = asyncio.create_task(
                self._finish_recording_teardown(), name=f"recording-close-{self.session_id}"
            )
        if self._on_teardown is not None:
            self._on_teardown()

    # -- feed loop -------------------------------------------------------------

    def feed_control(self, ev) -> None:
        """Forward a replay transport control (Seek/SetSpeed/Pause/Resume) to
        the feed. Feeds without a control surface — every live feed — ignore
        it, so this is safe to call on any session."""
        ctrl = getattr(self._feed, "control", None)
        if ctrl is not None:
            ctrl(ev)
            if isinstance(self._feed, ReplayFeed):
                if isinstance(ev, events.Seek):
                    self._reset_replay_at(self._feed._cursor)
                else:
                    self._publish_status()

    def _reset_replay_at(self, i: int) -> None:
        """One synchronous generation boundary, including queued wire frames."""
        feed = self._feed
        assert isinstance(feed, ReplayFeed)
        previous_id = self.session_id
        self.session_id = f"{feed.market}:{feed.symbol}:replay:{uuid.uuid4().hex[:12]}"
        if self._stats is not None:
            self._stats.forget_session(previous_id)
            self._stats.note_session(self.session_id)
        self._grid.reset_replay()
        self._enc_cache.clear()
        self._overview_cache = OverviewCache()
        self._last_col_seq = None
        self._tape.clear()
        self._markers.clear()
        self._bbo = self._instant_book = None
        for client in self._clients:
            while len(client):
                client.drain(2**31)
        self._last_partial_depth = None
        self._last_partial_bar = None
        # A small recorded context makes a paused seek useful immediately.
        # These are actual intervals, never an old book integrated through gaps.
        first = max(0, i - 63)
        for j in range(first, i + 1):
            self._on_replay_book(feed.snapshot_at(j), broadcast=False)
        # Consume the displayed interval exactly once. Its authoritative bar
        # already includes its trades; tape is populated without integrating it.
        for j in range(first, i + 1):
            for ev in feed._by_t0.get(feed._t0s[j], ()):
                if isinstance(ev, events.Trade):
                    self._tape.append(ev)
                elif isinstance(ev, events.Marker):
                    self._markers.append(ev)
        feed._cursor = i + 1
        if self._clients:
            # Built once: every attached client gets the same immutable bytes.
            frames = self._snapshot_frames()
            for client in self._clients:
                for frame in frames:
                    client.offer(frame, col_msg=False, protected=True)

    def _publish_status(self) -> None:
        """Broadcast the current feed state with a fresh capability snapshot."""
        latency_ms, skew_ms = self._conn_latency_skew()
        self._broadcast(wire.encode(events.Status(feed_state=self._feed_state,
                        capability=self._capability(), latency_ms=latency_ms,
                        clock_skew_ms=skew_ms)), col=False)

    async def run(self) -> None:
        """Drain ``feed.events()`` into the grid and broadcast; restart the
        feed with exponential backoff (cap 30 s) on crash, reporting
        transitions via ``Status``. A real live crypto stream also restarts on
        a clean socket EOF; finite replay/sim and market-closed feeds may end.

        On ANY exit (normal end, cancellation — teardown or server shutdown)
        buffered recording rows are flushed so the on-disk tail stays fresh
        for the next rehydration. The final flush is awaited (off-loop
        Parquet write) so the data is on disk before the run task is
        considered done."""
        flush_task = asyncio.create_task(
            self._partial_flusher(), name=f"session-{self.session_id}-partial-flush"
        )
        try:
            while True:
                try:
                    if self._closed_history_prepared:
                        self._closed_history_prepared = False
                        # Do not immediately retry an empty/failed preparation
                        # after attach. A later subscriber retries before its
                        # bounded snapshot; an opening market resumes live.
                        if isinstance(self._feed, EquityFeed) and self._feed.is_closed_now():
                            return
                    await self._consume()
                    if (
                        is_crypto_market(self._feed.market)
                        and not isinstance(self._feed, ReplayFeed)
                        and not self._feed.capability.get("replay", False)
                    ):
                        # A clean websocket close is still loss of a live
                        # stream. Reuse the bounded recovery path instead of
                        # leaving attached clients on a permanently idle LIVE
                        # session until their next subscription.
                        raise RuntimeError("live crypto feed ended unexpectedly")
                    self._emit_closed_if_needed()
                    return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if self._stats is not None:
                        self._stats.inc_restart()
                    # Full jitter (AWS-style): sleep a UNIFORM draw from
                    # [0, backoff) instead of the bare backoff. Sessions of a
                    # venue that died together used to restart in lockstep
                    # every step (thundering herd at 1-2-4..30 s); the backoff
                    # STATE still doubles deterministically below — only the
                    # sleep is de-synchronized.
                    delay_s = self._rng.uniform(0.0, self._backoff_s)
                    logger.exception(
                        "feed crashed, restarting in %.1fs (backoff %.1fs)",
                        delay_s,
                        self._backoff_s,
                    )
                    try:
                        self._set_feed_state("degraded")
                    except Exception:
                        # A broadcast/encode failure must not kill the restart loop.
                        logger.exception("failed to broadcast degraded Status")
                    await asyncio.sleep(delay_s)
                    self._backoff_s = min(self._backoff_s * 2.0, _BACKOFF_CAP_S)
        finally:
            flush_task.cancel()
            try:
                await flush_task
            except asyncio.CancelledError:
                pass
            await self.flush_recording_now()
            if self._closed:
                await self._close_recording()

    async def _consume(self) -> None:
        async for ev in self._feed.events():
            if isinstance(ev, (BookState, BarSample)) and ev.ts_ns < self._equity_warmup_before_ns:
                continue
            if self._stats is not None:
                # Liveness: age of the last feed-event ARRIVAL (wall clock, so
                # venue stamps can't fake freshness) feeds stats.staleness_ms.
                self._stats.note_live_sample(self.session_id)
            feed_flag = getattr(self._feed, "feed_state", None)
            if feed_flag == "degraded":
                # The feed reports its own degradation (keyless equity withholds
                # a stale profile). An event that arrives alongside the report
                # must not clear it: the flag holds until the feed says live.
                self._mirror_feed_degraded()
            elif self._feed_state != "live" and not (
                isinstance(ev, events.Marker) and feed_flag == "closed"
            ):  # first actual event after a restart, not a repeated closed marker
                self._recovery_start_ns = self._clock()
                self._recovery_events = 0
                self._set_feed_state("live")
            if self._backoff_s != self._backoff_base_s:
                # Reset only after the restarted feed proves stable (see
                # _STABLE_NS/_STABLE_EVENTS): flappers must keep escalating.
                self._recovery_events += 1
                if (
                    self._recovery_events >= _STABLE_EVENTS
                    or self._clock() - self._recovery_start_ns >= _STABLE_NS
                ):
                    self._backoff_s = self._backoff_base_s
            if isinstance(ev, BookState):
                if ev.ts_ns < self._equity_warmup_before_ns:
                    continue
                self._on_book(ev)
            elif isinstance(ev, BarSample):
                if ev.ts_ns < self._equity_warmup_before_ns:
                    continue
                self._grid.on_bar_sample(ev.ts_ns, ev.o, ev.h, ev.l, ev.c, ev.volume)
                if isinstance(self._feed, EquityFeed) and self._feed.tier == "keyless":
                    # A closed feed can be restarted on reattach. Its provider
                    # warmup is immutable at each sampled bar timestamp: do not
                    # integrate that same bar volume or append it a second time.
                    # The +1ns cutoff leaves every later live book admissible.
                    self._equity_warmup_before_ns = ev.ts_ns + 1
            elif isinstance(ev, events.Trade):
                if ev.seq == 0:
                    # Stamped once, at ingest: a trade that already carries its
                    # seq keeps it, so the same fill is never numbered twice.
                    ev = msgspec.structs.replace(ev, seq=self._next_trade_seq())
                if not isinstance(self._feed, ReplayFeed):
                    self._grid.on_trade(ev.ts_ns, ev.price, ev.size, ev.side)
                self._tape.append(ev)
                self._record(lambda r, t=ev: r.record_trade(t))
                self._broadcast(wire.encode(ev), col=False)
            elif isinstance(ev, events.Marker):
                self._markers.append(ev)
                self._record(lambda r, m=ev: r.record_marker(m))
                self._broadcast(wire.encode(ev), col=False)
            elif isinstance(ev, events.BBO):
                if self._bbo is None or ev.ts_ns >= self._bbo.ts_ns:
                    self._bbo = ev
                    self._broadcast(wire.encode(ev), col=False)
            else:
                # Forward-compat: a feed speaking a newer FeedEvent dialect
                # must not crash the session — log and skip.
                logger.warning("ignoring unknown feed event type %s", type(ev).__name__)
            now = self._clock()
            if now - self._last_flush_ns >= self._flush_interval_ns:
                self._flush_partial(now)
            # Time-based recording flush cadence (FLOWMAP_FLUSH_INTERVAL_S):
            # buffers that have been accumulating longer than the cadence are
            # flushed even below REC_FLUSH_COLS, so a Windows hard close
            # (TerminateProcess — no lifespan flush_all) loses at most ~the
            # cadence in seconds, not a whole 64-column part. A stalled feed
            # buffers no rows, so per-event checking bounds the loss window.
            if self._recording_flush_due(now):
                self._flush_recording()

    def _conn_latency_skew(self) -> tuple[float, float]:
        """Real per-connection latency/skew for Status frames.

        The WS layer installs ``conn_stats``: a
        callable returning ``{"latency_ms": float, "clock_skew_ms": float}``
        measured on THIS connection. Both Status fields used to be hardcoded
        0.0 while the measurement sat unused in the WS layer. Fully
        defensive: no hook (bare-core tests) or a raising/malformed hook
        yields the historical 0.0 values. The latest skew also feeds the
        manager-wide stats aggregate so /api/health carries it even before
        the WS layer calls ``record_clock_skew`` itself."""
        fn = self.conn_stats
        if fn is None:
            return 0.0, 0.0
        try:
            d = fn()
            latency = float(d.get("latency_ms", 0.0))
            skew = float(d.get("clock_skew_ms", 0.0))
        except Exception:  # a bad hook must not kill the broadcast
            logger.debug("conn_stats hook failed", exc_info=True)
            return 0.0, 0.0
        if self._stats is not None:
            self._stats.record_clock_skew(skew)
        return latency, skew

    def _emit_closed_if_needed(self) -> None:
        """After a feed loop ends *normally*, an equity feed may report a
        closed RTH window (``feed.feed_state == 'closed'``). When it
        does, broadcast a terminal ``Status{feed_state='closed', next_open_ts}``
        so the client shows the closed banner + countdown, then leave the run
        task ended. This is distinct from the crash path in :meth:`run`, which
        restarts with backoff on EXCEPTIONS — a normal 'closed' end must NOT
        hot-loop restart. Feeds with no ``feed_state`` attribute (sim/crypto)
        end normally and emit nothing here.

        The session stays registered (refcounted) while a client is attached;
        a later re-subscribe restarts the feed (``start()`` is idempotent), so
        the client wakes the stream after the next open. Known limitation: the
        wake at ``next_open_ts`` is client-driven, not a server-scheduled timer. The weekend demo is a
        closed banner + last-session SYNTH warmup that resumes on re-subscribe.
        """
        if getattr(self._feed, "feed_state", None) != "closed":
            return
        # Warmup can finish in less than one flush interval. Publish the last
        # sampled close before stopping the periodic flusher on a closed feed.
        self._flush_partial()
        if self._feed_state == "closed":
            return
        # Direct broadcast (not _set_feed_state) so next_open_ts rides along; a
        # later restart's first event flips _feed_state back to live.
        self._feed_state = "closed"
        latency_ms, skew_ms = self._conn_latency_skew()
        status = events.Status(
            feed_state="closed",
            capability=self._capability(),
            latency_ms=latency_ms,
            clock_skew_ms=skew_ms,
            next_open_ts=getattr(self._feed, "next_open_ts", None),
        )
        self._broadcast(wire.encode(status), col=False)

    def _mirror_feed_degraded(self) -> None:
        """Broadcast a ``degraded`` Status when the feed reports it.

        Only the ``degraded`` flag is mirrored here. ``live`` and ``closed`` keep
        their existing paths: an event flips the state back to live, and the
        closed path publishes its own terminal Status with ``next_open_ts``."""
        if getattr(self._feed, "feed_state", None) == "degraded" and self._feed_state != "degraded":
            self._set_feed_state("degraded")

    def _set_feed_state(self, state: events.FeedState) -> None:
        if state == self._feed_state:
            return
        self._feed_state = state
        latency_ms, skew_ms = self._conn_latency_skew()
        status = events.Status(
            feed_state=state,
            capability=self._capability(),
            latency_ms=latency_ms,
            clock_skew_ms=skew_ms,
        )
        self._broadcast(wire.encode(status), col=False)

    def _publish_capability_status(self) -> None:
        """Changed public health/counters reach clients at most once a second.

        The existing Status dialect carries this telemetry. It runs from the
        clock task, so a quiet source can still expose capture finalization;
        canonical book counters do not fabricate upstream frame counts.
        """
        if not isinstance(self._feed, ReplayFeed) and "source_book_events" not in self._feed.capability:
            return
        now = self._clock()
        if now < self._next_capability_status_ns:
            return
        self._next_capability_status_ns = now + (250_000_000 if isinstance(self._feed, ReplayFeed) else CAPABILITY_STATUS_INTERVAL_NS)
        capability = self._capability()
        payload = msgspec.json.encode(capability)
        if payload == self._last_capability_status_payload:
            return
        self._last_capability_status_payload = payload
        latency_ms, skew_ms = self._conn_latency_skew()
        status = events.Status(
            feed_state=self._feed_state,
            capability=capability,
            latency_ms=latency_ms,
            clock_skew_ms=skew_ms,
        )
        self._broadcast(wire.encode(status), col=False)
