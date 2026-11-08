"""SessionManager: keyed session registry, band and source canonicalisation,
subscription admission and replay construction."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import time
import uuid
from collections.abc import Callable

import msgspec

from flowmap_server.config import Config
from flowmap_server.core.backfill import (
    BackfillFn,
)
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.record import Recorder, TailData
from flowmap_server.core.session_capability import replayed_capability
from flowmap_server.core.session_common import (
    REPLAY_STALE_TOL_NS,
    SESSION_LOGGER,
    Clock,
    ReplayStaleError,
    ReplayUnavailableError,
    SessionLimitError,
    Timer,
    _default_timer,
)
from flowmap_server.core.session_core import Session
from flowmap_server.core.session_queue import ClientTx
from flowmap_server.core.stats import SessionStats
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.equity import EQUITY_MARKETS
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.feeds.router import build_feed
from flowmap_server.proto import events

logger = logging.getLogger(SESSION_LOGGER)


# Crypto grid shape FALLBACK (mirrors feeds.sim private constants: mid starts
# at 100.0, tick 0.5; kept local so this module does not reach into sim
# internals). Despite the names this shape prices REAL crypto books too: the
# first book re-anchors p0 to the real mid, which is correct for majors — but
# a sub-cent coin collapses into 1-2 rows at a 0.5 tick. The honest escapes,
# in priority order, are FLOWMAP_CRYPTO_TICK and a feed-declared
# ``preferred_tick`` (see :func:`_crypto_tick_for`); when NEITHER answers, a
# feed that declares ``price_adaptive_tick`` (CryptoFeed does) gets a tick
# scaled to the instrument's price at the first real mid — see
# :func:`_crypto_tick_auto` and ``core.grid.adaptive_tick_for``.
_SIM_MID0 = 100.0

_SIM_TICK = 0.5

_SIM_ROWS = 2048


def _crypto_tick_for(feed: Feed, cfg_tick: float) -> float:
    """Resolve the crypto grid tick: config override, feed declaration, fallback.

    A venue's true tick is the right quantum for its own prices — the sim-shaped
    fallback cannot know it. Priority: an explicit server override wins (the
    operator can see what the venue lists), then a feed that declares
    ``preferred_tick``, then the fallback. Anything non-positive or non-finite
    is treated as "no answer" rather than trusted.
    """
    for candidate in (cfg_tick, getattr(feed, "preferred_tick", None)):
        if isinstance(candidate, (int, float)) and math.isfinite(candidate) and candidate > 0:
            return float(candidate)
    return _SIM_TICK


def _crypto_tick_auto(feed: Feed, cfg_tick: float) -> bool:
    """Whether the grid may TICK-SCALE to the symbol's price magnitude.

    Only when the tick was not declared: an explicit FLOWMAP_CRYPTO_TICK or a
    feed ``preferred_tick`` is an answer and is never second-guessed. Otherwise
    a feed that opts in (``price_adaptive_tick``, CryptoFeed) lets the grid
    replace the sim-shaped fallback with ``adaptive_tick_for(mid, tick)`` at
    the first real mid — BTC/ETH keep 0.5 there; DOGE/SOL-class get a
    power-of-10 fraction of their own price.
    """
    for candidate in (cfg_tick, getattr(feed, "preferred_tick", None)):
        if isinstance(candidate, (int, float)) and math.isfinite(candidate) and candidate > 0:
            return False
    return bool(getattr(feed, "price_adaptive_tick", False))


# Equity grid shape: a cent tick (SEC Rule 612, >=$1 stocks),
# a ~$41 vertical span at 4096 rows, and a nominal $100 p0 that the grid
# re-anchors to the symbol's real price on the first book. mode + cadence are
# derived from the feed's honest capability so the grid can never claim more
# than the feed delivers (SYNTH_PROFILE keyless / L1_BAND keyed).
_EQUITY_TICK = 0.01

_EQUITY_ROWS = 4096

_EQUITY_P0_NOMINAL = 100.0

# Depth-capability string -> grid render mode. Two-sided equity depth (synthetic
# volume-at-price split at the reference price, or real Alpaca L1 top-of-book)
# renders two-channel via MODE_L1_BAND; the honest tier lives in the capability
# badge (SYNTH vs L1), decoupled from the render shape. Legacy one-sided
# SYNTH_PROFILE kept for compatibility.
_EQUITY_DEPTH_MODE: dict[object, int] = {
    "SYNTH": events.MODE_L1_BAND,
    "L1": events.MODE_L1_BAND,
    "SYNTH_PROFILE": events.MODE_SYNTH_PROFILE,
    "L1_BAND": events.MODE_L1_BAND,
}

# Synthetic (keyless) depth tiers run the slower Yahoo-friendly cadence.
_EQUITY_SYNTH_DEPTHS = frozenset({"SYNTH", "SYNTH_PROFILE"})


# Price-grid coverage presets, as (band_up, band_down) fractions of the
# reference price. ``None`` = the legacy fixed-absolute-span grid.
#
# The grid is a LINEAR affine over a FIXED row count, so range and resolution
# are the SAME knob — a wider band can only make every row coarser. Concretely,
# on BTC at $60k with 2048 rows and a $0.5 tick:
#   native  fixed $1024 span   -> $0.50/row   (about +/-0.85% around mid)
#   wide    +/-50%             -> ~$43.5/row  (about $89k of coverage)
#   full    -100% / +1000%     -> ~$403/row   (the live book collapses into a
#                                 couple of rows: a range SCAN mode for finding
#                                 far-out walls, NOT a ladder-reading view)
# Because tick_multiple = ceil(span / (rows*tick)) can only round UP, a preset
# is a literal no-op for any symbol cheap enough that the native span already
# covers the band.
class BandSpec(msgspec.Struct, frozen=True):
    """Coverage around the reference price, and how the rows are spent.

    ``hybrid=False`` keeps the LINEAR grid, where range and resolution are the
    same knob. ``hybrid=True`` switches to the piecewise scale
    (``core/price_scale.py``): a linear CORE at the instrument's native step
    surrounded by logarithmic wings, so the tradeable ladder near the money is
    unchanged AND the far field is covered. That is the only preset for which a
    -99%/+1000% band is a trading view rather than a range scan.
    """

    up: float
    down: float
    hybrid: bool = False
    #: Rows for the linear core; 0 => rows // 2.
    core_rows: int = 0
    #: Grid height override for this band (0 => the market default).
    rows: int = 0


BANDS: dict[str, BandSpec | None] = {
    "native": None,
    "wide": BandSpec(up=0.5, down=0.5),
    "full": BandSpec(up=10.0, down=1.0),
    # -99%/+1000% with the ladder INTACT: 4096 rows, half of them a native-step
    # core. On BTC at $60k that is +/-0.853% at $0.50/row — the coverage AND
    # resolution of the `native` grid — plus wings reaching -99%/+1000% at
    # ~0.34%/row. Registered as a NEW name rather than re-pointing `full`:
    # priceBand is persisted in localStorage, so re-pointing would silently move
    # every existing `full` user onto a piecewise scale on their next load.
    "deep": BandSpec(up=10.0, down=0.99, hybrid=True, core_rows=2048, rows=4096),
}


DEFAULT_BAND = "native"


def canonical_band(band: str | None) -> str:
    """Coerce a wire ``band`` to a known preset name.

    Applied in :meth:`SessionManager._subscribe`, before the value joins the
    session key: ``band`` is unvalidated client text, and each distinct value
    would otherwise mint its own Session — four junk subscribes would exhaust
    ``max_sessions`` at 256 MiB (crypto) / 512 MiB (equity) of ring apiece.
    """
    return band if band in BANDS else DEFAULT_BAND


#: ``Subscribe.source`` values this server recognises. The server never routes
#: on ``source``; the field only widens the session key, so an unknown value is
#: coerced to ``None`` instead of minting a second, identical Session.
KNOWN_SOURCES: frozenset[str] = frozenset({"crocodile", "crypcodile"})


def canonical_source(source: str | None) -> str | None:
    """Coerce a wire ``source`` to ``None`` or a name in :data:`KNOWN_SOURCES`."""
    return source if source in KNOWN_SOURCES else None


class SessionManager:
    """Owns sessions keyed by (market, symbol, mode, source); refcounted."""

    def __init__(
        self,
        cfg: Config,
        *,
        clock: Clock = time.monotonic_ns,
        timer: Timer = _default_timer,
        feed_factory: Callable[[events.Subscribe], Feed] | None = None,
        recorder: Recorder | None = None,
        wall_clock: Clock = time.time_ns,
        backfill_fn: BackfillFn | None = None,
    ) -> None:
        self._cfg = cfg
        self._clock = clock
        self._timer = timer
        self._feed_factory = feed_factory or self._default_feed_factory
        # Recording root shared by all live sessions (None: no recording and
        # no rehydration — the default for deterministic tests; create_app
        # wires one in from Config for the real server).
        self._recorder = recorder
        self._wall_clock = wall_clock
        # First-launch history backfill seam. None disables it — the
        # default for deterministic tests; create_app wires the network seam in.
        self._backfill_fn = backfill_fn
        # Server-wide telemetry producer, mounted at
        # ``stats`` — the api layer resolves it via ``manager.stats.snapshot()``
        # and renders the dict verbatim. Always present (cheap); the getattr
        # Shares the manager's
        # injectable wall clock so staleness ages are deterministic in tests.
        self.stats = SessionStats(
            wall_clock=wall_clock, active_sessions=lambda: len(self._sessions)
        )
        # Keyed by (market, symbol, mode, source, band) — live sessions; a
        # replay key additionally carries (start_t, end_t) because the
        # window is identity (see _subscribe). The band is part of the grid
        # geometry, so two bands are genuinely two grids.
        self._sessions: dict[tuple, Session] = {}
        self._retiring_sessions: set[Session] = set()
        # Per-key creation guard (see _creation_guard): [lock, waiter count].
        self._creating: dict[tuple, list] = {}

    def _default_feed_factory(self, sub: events.Subscribe) -> Feed:
        # Test path: the sim feed is unpaced so tests own the clock. Routing
        # itself lives in feeds.router — see the note there about the copy this
        # replaced. The stats aggregate rides along so live feeds count their
        # drops at the source.
        return build_feed(sub, self._cfg, realtime_sim=False, stats=self.stats)

    def _grid_for(self, feed: Feed, band: str = DEFAULT_BAND) -> Grid:
        if feed.market in EQUITY_MARKETS:
            return self._equity_grid_for(feed, band)
        tick = _crypto_tick_for(feed, self._cfg.crypto_tick)
        auto_tick = _crypto_tick_auto(feed, self._cfg.crypto_tick)
        rows = min(_SIM_ROWS, self._cfg.max_rows)
        step = tick  # tick_multiple 1
        p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        spec = BANDS.get(band)
        if spec is not None and spec.rows > 0:
            rows = min(spec.rows, self._cfg.max_rows)
            p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        if feed.market != "sim":
            p0 = max(0.0, p0)
        return Grid(
            GridCfg(
                tick=tick,
                tick_multiple=1,
                dt_ns=self._cfg.dt_crypto_ns,
                p0=p0,
                rows=rows,
                ring_columns=self._cfg.ring_columns,
                mode=events.MODE_L2,
                band_up=spec.up if spec else None,
                band_down=spec.down if spec else None,
                band_hybrid=spec.hybrid if spec else False,
                core_rows=spec.core_rows if spec else 0,
                auto_tick=auto_tick,
            )
        )

    def _equity_grid_for(self, feed: Feed, band: str = DEFAULT_BAND) -> Grid:
        """Equity-appropriate grid: mode and column cadence honestly
        derived from the feed's capability. Keyless SYNTH_PROFILE runs at the
        1 s keyless grid cadence (the feed re-asserts the resting profile every
        ``dt_equity_keyless_grid_ns`` while polling price every 10 s); keyed
        tiers (L1_BAND) run at the 1 s equity cadence. Cent tick; a nominal
        $100 p0 that the grid re-anchors to the symbol's real price on the
        first book (a >=$1 stock's profile near $180 pulls p0 up)."""
        depth = feed.capability.get("depth")
        mode = _EQUITY_DEPTH_MODE.get(depth, events.MODE_L1_BAND)
        dt = (
            self._cfg.dt_equity_keyless_grid_ns
            if depth in _EQUITY_SYNTH_DEPTHS
            else self._cfg.dt_equity_keyed_ns
        )
        rows = min(_EQUITY_ROWS, self._cfg.max_rows)
        tick = _EQUITY_TICK
        p0 = round((_EQUITY_P0_NOMINAL - rows * tick / 2.0) / tick) * tick
        spec = BANDS.get(band)
        return Grid(
            GridCfg(
                tick=tick,
                tick_multiple=1,
                dt_ns=dt,
                p0=p0,
                rows=rows,
                ring_columns=self._cfg.ring_columns,
                mode=mode,
                band_up=spec.up if spec else None,
                band_down=spec.down if spec else None,
                band_hybrid=spec.hybrid if spec else False,
                core_rows=spec.core_rows if spec else 0,
            )
        )

    @contextlib.asynccontextmanager
    async def _creation_guard(self, key: tuple):
        """Mutex for creating the session of one key.

        Reference-counted so the entry is dropped only after the last holder
        or waiter leaves. Dropping it earlier would let a waiter and a new
        arrival hold two different locks for the same key."""
        entry = self._creating.get(key)
        if entry is None:
            entry = self._creating[key] = [asyncio.Lock(), 0]
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self._creating.get(key) is entry:
                del self._creating[key]

    async def _create_session(self, sub: events.Subscribe, key: tuple, band: str) -> Session:
        """Build, register and return a new session for ``key``.

        Runs only under :meth:`_creation_guard` with no session registered
        for ``key``. The session is registered before it starts, so its
        boot can be shared; :meth:`_subscribe` retires it if boot fails."""
        self._evict_other_bands(key)
        if len(self._sessions) >= self._cfg.max_sessions:
            raise SessionLimitError(
                f"session limit reached ({self._cfg.max_sessions}); cannot open {key!r}"
            )
        if sub.mode == "replay":
            # The recording-backed replay engine: the recorder IS the data
            # source, so a replay session opens NO recorder of its own and
            # runs no backfill (both already gated on mode == "live").
            feed, replay_tail = await self._replay_feed(sub)
        else:
            feed, replay_tail = self._feed_factory(sub), None
            prepare = getattr(feed, "prepare", None)
            if prepare is not None:
                await prepare()
        session = Session(
            f"{sub.market}:{sub.symbol}:{sub.mode}:{uuid.uuid4().hex[:12]}",
            feed=feed,
            grid=(Grid(GridCfg(tick=replay_tail.epochs[-1].tick,
                  tick_multiple=replay_tail.epochs[-1].tick_multiple,
                  rows=replay_tail.epochs[-1].rows, dt_ns=replay_tail.epochs[-1].dt_ns,
                  p0=replay_tail.epochs[-1].p0, ring_columns=self._cfg.ring_columns,
                  mode=events.MODE_L2))
                  if replay_tail is not None else self._grid_for(feed, band)),
            clock=self._clock,
            timer=self._timer,
            # Live mode only: replay sessions never self-record.
            recorder=self._recorder if sub.mode == "live" else None,
            wall_clock=self._wall_clock,
            # Live mode only: a replay session reads its own recording, never
            # a live candle backfill.
            backfill_fn=self._backfill_fn if sub.mode == "live" else None,
            backfill_max_cols=self._cfg.backfill_max_cols if self._cfg.backfill_enabled else 0,
            backfill_stretch=self._cfg.backfill_stretch,
            stats=self.stats,
            rec_flush_interval_s=self._cfg.rec_flush_interval_s,
            retention_min_interval_s=self._cfg.retention_min_interval_s,
        )
        session._on_teardown = self._make_remover(key, session)
        if replay_tail is not None:
            session.replay_tail_t0 = replay_tail.newest_t0_ns
            # A WINDOWED replay ([start_t, end_t)) is immutable history:
            # record the window end so the parked-replay freshness check
            # knows growth past it is expected, not staleness.
            session.replay_window_end_ns = sub.end_t
            # First column is visible BEFORE Hello, including a paused or
            # one-column selection. Same-session reconnect never resets it.
            session._reset_replay_at(0)
        if self.stats is not None:
            self.stats.note_session(session.session_id)
        self._sessions[key] = session
        return session

    async def subscribe(
        self, sub: events.Subscribe, client: ClientTx, _retry: bool = True
    ) -> Session:
        """Attach ``client`` to the session for ``sub``'s key, creating and
        starting the session if needed (≤ ``cfg.max_sessions`` distinct keys).
        The snapshot frames are enqueued into ``client`` before returning, so
        they precede every live broadcast. Refused subscribes (session limit,
        replay unavailable/stale, invalid symbol) are counted in the stats
        aggregate before the error propagates to the WS layer's honest
        refusal path."""
        try:
            return await self._subscribe(sub, client, _retry)
        except (SessionLimitError, ReplayUnavailableError, ValueError):
            if self.stats is not None:
                self.stats.inc_rejected()
            raise

    async def _subscribe(
        self, sub: events.Subscribe, client: ClientTx, _retry: bool = True
    ) -> Session:
        """The subscribe body (see :meth:`subscribe`). ``_retry`` is internal:
        it bounds the single teardown-during-boot re-subscribe so a
        pathological teardown that keeps winning surfaces as an error instead
        of recursing forever."""
        band = canonical_band(sub.band)
        key = (sub.market, sub.symbol, sub.mode, canonical_source(sub.source), band)
        if sub.mode == "replay":
            # The requested recording window is part of the key: W1 and W2
            # are two different replays of the same symbol. Without this the
            # second re-attach silently inherited the FIRST session's window.
            # Distinct windows open
            # distinct sessions; an idle parked variant of the same
            # symbol/mode is evicted on the new key (see _evict_other_bands).
            key = key + (sub.start_t, sub.end_t)
        # The band is part of the key (two clients on the same symbol with
        # different bands must NOT silently share one grid — the second would
        # inherit the first's step and never know). But a band switch on an
        # otherwise-identical key must EVICT the old variant immediately rather
        # than wait out GRACE_S: each session holds a
        # ring_columns*2*rows*2-byte ring (256 MiB crypto / 512 MiB equity), and
        # flipping the preset three times would otherwise pin ~1 GiB for a
        # minute and trip max_sessions.
        session = self._sessions.get(key)
        created = False
        if session is None:
            # Creation is serialized per key. The lookup above and the
            # registration in _create_session are separated by awaits (replay
            # load, feed.prepare), so two subscribers arriving together would
            # each build a session and orphan one.
            async with self._creation_guard(key):
                session = self._sessions.get(key)
                if session is None:
                    session = await self._create_session(sub, key, band)
                    created = True
        if not created and sub.mode == "replay":
            # Parked-replay freshness policy: re-validate the
            # recording before handing the existing session out again. Raises
            # ReplayStaleError — refusing leaves the parked session untouched.
            # The disk probe runs off-loop (see the method): it used to parse
            # the newest part file inline in subscribe, stalling the loop.
            await self._recheck_replay_freshness(session, sub)
        # Unconditional (start() is idempotent/restart-safe): a session whose
        # feed ended normally must not be handed out as a zombie — a new
        # subscriber restarts the run task. First start boots (rehydrates)
        # BEFORE attach below, so the snapshot includes the recorded tail.
        # A boot can take seconds (executor Parquet load, backfill seam) and
        # holds zero clients, so a grace teardown (or `_evict_other_bands` from
        # a rival band) may fire mid-boot; `_teardown` then runs to completion
        # and can never run again. start() now declines to spawn the run task
        # on that dead session, and attach() raises — retry ONCE on the fresh
        # session the remover already installed under the key (L2).
        try:
            started = await session.start()
        except BaseException:
            # The creator's boot failed (or was cancelled) after registration.
            # Nothing else holds the session, so without this it stays in the
            # table, pins its slot and ring, and blocks max_sessions.
            # A waiter that did not create it must leave it alone: another
            # subscriber is still booting it.
            if created:
                if self._sessions.get(key) is session:
                    del self._sessions[key]
                    if self.stats is not None:
                        self.stats.forget_session(session.session_id)
                session.teardown_now()
            raise
        if started is not None:
            try:
                frames = session.attach(client)
            except RuntimeError:
                if self._sessions.get(key) is session:
                    self._sessions.pop(key, None)
                if not _retry:
                    raise
                return await self.subscribe(sub, client, _retry=False)
        else:
            if self._sessions.get(key) is session:
                self._sessions.pop(key, None)
            if not _retry:
                raise RuntimeError(
                    f"session for {key!r} was torn down during boot twice; "
                    f"refusing to hand out a dead session"
                )
            return await self.subscribe(sub, client, _retry=False)
        for frame in frames:
            # Snapshot frames ride the non-column path (no column lag-drops)
            # and are protected: cap eviction must never drop Hello.
            client.offer(frame, col_msg=False, t0_ns=None, protected=True)
        return session

    async def _replay_feed(self, sub: events.Subscribe) -> tuple[ReplayFeed, TailData]:
        """Build the recording-backed replay feed for ``sub``, or refuse.

        Returns the feed and the tail it was built from (the manager records
        the tail's newest ``t0_ns`` on the session so re-attaches can detect a
        recording that has moved on). The recorder is the replay data source:
        a store-less manager (tests) or a symbol with no recording raises
        :class:`ReplayUnavailableError`, which the WS layer turns into an
        explicit refusal — never a live feed under a replay label.

        Honoring ``Subscribe.start_t`` / ``end_t``: a
        windowed subscription loads only ``[start_t, end_t)`` through the
        recorder's public ranged read (:meth:`Recorder.load_tail`, capped at
        the ring).

        A no-window subscription — which used to materialize the ENTIRE
        recording via ``load_all`` (multi-GB RAM for long recordings) — now serves
        the NEWEST bounded window: the same ``ring_columns``
        cap the windowed path uses, overridable via
        ``FLOWMAP_REPLAY_MAX_COLS``. When the recording is longer, the load is
        truncated to that window and a warning is logged; an explicit
        [start_t, end_t) window is never affected by this bound.

        The load runs in the default executor exactly like boot rehydration:
        doing it inline stalled the event loop — and every other session and
        client — for the whole Parquet read."""
        if self._recorder is None:
            raise ReplayUnavailableError("replay needs a recording store; this manager has none")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._replay_feed_blocking, sub.market, sub.symbol, sub.start_t, sub.end_t
        )

    @property
    def cfg(self) -> Config:
        """The server configuration this manager was built from."""
        return self._cfg

    @property
    def recorder(self) -> Recorder | None:
        """The recording store (None when recording is not configured)."""
        return self._recorder

    def active_sessions(self) -> list[tuple[tuple, Session]]:
        """Every registered session as ``(key, session)``, in no particular order.

        A copy: callers (REST probes, export) iterate it on the event loop while
        sessions may be added or retired.
        """
        return list(self._sessions.items())

    def replay_feed_blocking(
        self, market: str, symbol: str, start_t: int | None, end_t: int | None
    ) -> tuple[ReplayFeed, TailData]:
        """Public seam for the recording-window probe (blocking; run off-loop)."""
        return self._replay_feed_blocking(market, symbol, start_t, end_t)

    def _replay_feed_blocking(
        self, market: str, symbol: str, start_t: int | None, end_t: int | None
    ) -> tuple[ReplayFeed, TailData]:
        """Blocking recorder IO + feed construction for :meth:`_replay_feed`
        (runs in the executor)."""
        assert self._recorder is not None
        if start_t is None and end_t is None:
            # Bounded newest-window read: the client asked for
            # "the replay", not "every byte ever recorded". Default cap = the
            # same ring_columns the windowed path applies; the env knob may
            # deepen it deliberately. Truncation is NOT silent: it is flagged
            # by TailData.truncated and logged here; callers that need older
            # data must send an explicit [start_t, end_t) window.
            limit_cols = self._cfg.replay_max_cols or self._cfg.ring_columns
            tail = self._recorder.load_tail(
                market,
                symbol,
                max_age_ns=2**62,
                now_ns=2**62,
                limit_cols=limit_cols,
            )
            if tail is not None and (
                tail.truncated or tail.trades_truncated or tail.markers_truncated
            ):
                logger.warning(
                    "replay load for %s:%s truncated to the newest %d columns "
                    "(columns=%s trades=%s markers=%s); send a "
                    "[start_t, end_t) window for older data or raise "
                    "FLOWMAP_REPLAY_MAX_COLS",
                    market,
                    symbol,
                    limit_cols,
                    tail.truncated,
                    tail.trades_truncated,
                    tail.markers_truncated,
                )
        else:
            if start_t is not None and end_t is not None and end_t <= start_t:
                raise ReplayUnavailableError(
                    f"empty replay window [{start_t}, {end_t}) for "
                    f"{market}:{symbol} — replay unavailable"
                )
            # Ranged read over [start_t, end_t): ``now_ns - max_age_ns`` yields
            # the window's start cutoff, ``end_ns`` bounds it above, and the
            # cap is the ring — a window can never serve more than the newest
            # ring_columns of data anyway. An open-ended start_t uses the
            # sentinel "now" so the cutoff lands exactly on start_t.
            now_ns = end_t if end_t is not None else 2**62
            max_age_ns = now_ns - (start_t if start_t is not None else 0)
            tail = self._recorder.load_tail(
                market,
                symbol,
                max_age_ns=max_age_ns,
                now_ns=now_ns,
                limit_cols=self._cfg.ring_columns + 1,
                end_ns=end_t,
            )
        if tail is None or not tail.columns:
            raise ReplayUnavailableError(f"no recording for {market}:{symbol} — replay unavailable")
        if (start_t is not None or end_t is not None) and (tail.truncated or len(tail.columns) > self._cfg.ring_columns):
            raise ReplayUnavailableError(f"replay window exceeds {self._cfg.ring_columns} columns; choose a shorter interval")
        feed = ReplayFeed(market=market, symbol=symbol, tail=tail,
                          paused=start_t is not None or end_t is not None,
                          recorded_capability=tail.capability)
        # Report what was recorded. The replay engine's literal is the L2 /
        # exchange reading of a crypto venue; a synthetic equity run must not
        # claim real depth or exchange-side trades.
        feed.capability.update(replayed_capability(market, tail.capability))
        return feed, tail

    async def _recheck_replay_freshness(self, session: Session, sub: events.Subscribe) -> None:
        """Re-validate an existing replay session's recording on re-attach.

        The replay feed replays the recording AS IT WAS when the session was
        created; columns recorded after its tail are unreachable from the
        parked feed. When the recording on disk has grown past the session's
        tail by more than :data:`REPLAY_STALE_TOL_NS` of recorded time, the
        subscribe is REFUSED with :class:`ReplayStaleError` instead of
        accepting.

        A WINDOWED replay (``replay_window_end_ns`` set) is exempt: its
        ``[start_t, end_t)`` content is immutable history, so growth of the
        recording past the window's end is expected — refusing would demand a
        rebuild that returns the same window. (Growth BEFORE ``start_t`` is
        equally irrelevant: it can never enter the window.)

        The refusal touches nothing: the parked session keeps its clients and
        run task, and once the recording stops growing — or the session
        retires after its grace and a fresh one is built from the new tail —
        a re-subscribe succeeds again. An unreadable/absent recording counts
        as NOT stale: the probe must never invent staleness it cannot see.

        The probe (``newest_column_t0`` — open + parse of one Parquet part,
        up to ~4 MB) runs in the default executor: it used to run inline in
        subscribe, re-introducing exactly the event-loop stall the replay
        load itself was moved off-loop for."""
        if self._recorder is None or session.replay_tail_t0 is None:
            return
        if session.replay_window_end_ns is not None:
            return  # bounded window: immutable history, growth is expected
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            self._recheck_replay_freshness_blocking,
            session,
            sub.market,
            sub.symbol,
        )

    def _recheck_replay_freshness_blocking(
        self, session: Session, market: str, symbol: str
    ) -> None:
        """Blocking probe + staleness verdict for
        :meth:`_recheck_replay_freshness` (runs in the executor)."""
        assert self._recorder is not None
        tail_t0 = session.replay_tail_t0
        assert tail_t0 is not None
        disk_t0 = self._recorder.newest_column_t0(market, symbol)
        if disk_t0 is None or disk_t0 <= tail_t0 + REPLAY_STALE_TOL_NS:
            return
        raise ReplayStaleError(
            f"replay_stale: recording for {market}:{symbol} has grown "
            f"past the parked session's tail (recorded through {disk_t0}, "
            f"session tail {tail_t0}, tolerance {REPLAY_STALE_TOL_NS} ns) — "
            f"re-subscribe once the old session retires"
        )

    def _evict_other_bands(self, key: tuple) -> None:
        """Tear down idle sessions that share ``key``'s symbol/mode/source.

        Called before creating a new variant of the same stream. For a live
        key the variants are bands; for a replay key they are bands AND
        [start_t, end_t) windows. Idle variants (no attached clients) are
        torn down at once — a client cycling preset bands or replay windows
        must not pin one ring per variant for the grace period; a variant
        someone else is still watching is left alone — it is a legitimate
        concurrent session, not a leak.
        """
        market, symbol, mode, source = key[:4]
        for other in list(self._sessions):
            if other == key or other[:4] != (market, symbol, mode, source):
                continue
            sess = self._sessions.get(other)
            if sess is None or sess.client_count > 0:
                continue
            self._sessions.pop(other, None)
            sess.teardown_now()
            # The remover's identity guard does not run for a variant popped
            # here, so its staleness entries are dropped explicitly.
            if self.stats is not None:
                self.stats.forget_session(sess.session_id)

    def _make_remover(self, key: tuple, session: Session) -> Callable[[], None]:
        def _remove() -> None:
            close_task = session._recording_close_task
            if close_task is not None:
                self._retiring_sessions.add(session)

                def closed(done: asyncio.Task) -> None:
                    self._retiring_sessions.discard(session)
                    if not done.cancelled():
                        done.exception()

                close_task.add_done_callback(closed)
            # Identity-guarded: a stale grace timer from a torn-down session
            # must never evict a fresh session that reused the key.
            if self._sessions.get(key) is session:
                del self._sessions[key]
                # Drop the session's staleness entry too — a dead session must
                # not linger in the stats as an "active" staleness subject.
                if self.stats is not None:
                    self.stats.forget_session(session.session_id)

        return _remove

    async def unsubscribe(self, session: Session, client: ClientTx) -> None:
        session.detach(client)

    async def flush_all(self) -> None:
        """Server-shutdown hook (the api.app lifespan): flush every active
        session's buffered recording rows to disk. Without it, up to
        REC_FLUSH_COLS buffered columns plus trades are lost on every
        sidecar kill. ``return_exceptions`` so one broken session cannot
        skip the others'; ``flush_recording_now`` already logs and contains
        its own failures."""
        sessions = list(self._sessions.values())
        if sessions:
            await asyncio.gather(
                *(s.flush_recording_now() for s in sessions),
                return_exceptions=True,
            )
        closing = [s._recording_close_task for s in self._retiring_sessions
                   if s._recording_close_task is not None]
        if closing:
            await asyncio.gather(*(asyncio.shield(task) for task in closing), return_exceptions=True)
