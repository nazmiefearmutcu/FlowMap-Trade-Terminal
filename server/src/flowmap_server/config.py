"""FlowMap server configuration.

Single env-first config source. The server binds loopback only;
any ``FLOWMAP_HOST`` outside ``("127.0.0.1", "localhost")`` is rejected with
``ValueError`` rather than silently accepted.

Every numeric knob is range-checked in :meth:`Config.from_env` and a violation
raises ``ValueError`` naming the env var and its allowed range. This is
load-bearing, not cosmetics: the sidecar runs supervised (auto-restart), so a
typo'd env value used to become an opaque crash loop — ``np.zeros`` dying
inside ``Grid.__init__`` for ``FLOWMAP_RING_COLUMNS=1000000`` (~8 GB of ring
per session), a bind error for ``FLOWMAP_PORT=99999`` — instead of one clear
boot error. Only ABSURD values are rejected; every default and every
previously-plausible value parses exactly as before.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import msgspec

_ALLOWED_HOSTS = ("127.0.0.1", "localhost")
_DEFAULT_DATA_DIR = "~/.flowmap/recordings"

# Inclusive ranges for the env-driven numeric knobs (see module docstring).
# Tuples of (lo, hi) so each message names the range it enforces.
_PORT_RANGE = (1, 65_535)
_RING_COLUMNS_RANGE = (256, 65_536)
_MAX_SESSIONS_RANGE = (1, 16)
_BOOK_TOP_N_RANGE = (1, 200_000)
# Column cadences: at least 1 ms (a 1 ns typo pins a core: the realtime sim
# paces one interval per dt_ns on the event loop that serves uvicorn and /ws),
# at most one hour per column (anything larger is a unit mixup — seconds/ms
# pasted into an ns field — not a cadence).
_DT_NS_RANGE = (1_000_000, 3_600 * 1_000_000_000)
# Keyless equity book reads go to a public web endpoint that reloads itself
# every 5 s. Nothing faster than 2 s is accepted.
_DT_EQUITY_BOOK_NS_RANGE = (2 * 1_000_000_000, 3_600 * 1_000_000_000)
# Crypto grid tick override (FLOWMAP_CRYPTO_TICK): 0 = auto; anything absurd
# above this is a unit mixup, not a tick.
_CRYPTO_TICK_RANGE = (0.0, 1e12)
# Boolean switches accept these spellings, case-insensitively. Anything else is
# an error: a silently ignored "FALSE" or "off" used to leave recording ON.
_TRUE_WORDS = frozenset({"1", "true", "yes", "on"})
_FALSE_WORDS = frozenset({"0", "false", "no", "off"})
# Fields that must never appear in a repr, traceback or log line.
_SECRET_FIELDS = frozenset({"alpaca_key", "alpaca_secret", "finnhub_key"})
_RECORDING_GB_CAP_RANGE = (0.0, 1_000_000.0)
_BACKFILL_MAX_COLS_RANGE = (0, 65_536)
# Recording flush cadence (time-based, FLOWMAP_FLUSH_INTERVAL_S): a Windows
# hard-close (TerminateProcess — no lifespan shutdown, no flush_all) loses at
# most this many seconds of buffered recording per active session. Positive
# and at most one hour.
_REC_FLUSH_INTERVAL_S_RANGE = (0.001, 3_600.0)
# Minimum wall-clock interval between retention walks (per session). Default
# 60 s: the rglob+stat pass over the whole recording tree used to run after
# EVERY cadence flush (~every 16 s per session). 0 disables the gating (walk
# after every flush — the old behavior).
_RETENTION_MIN_INTERVAL_S_RANGE = (0.0, 86_400.0)
# Bounded replay load (FLOWMAP_REPLAY_MAX_COLS). A no-window replay subscribe
# used to materialize the ENTIRE recording (multi-GB RAM for long recordings)
# even though any window the client can look at is bounded by the grid ring;
# the no-window path now serves the NEWEST bounded window. 0 (default) = use
# ``ring_columns`` (the same cap the windowed path already applies); a
# positive value overrides it (deeper replay than the ring is legitimate —
# the feed replays columns through, the grid keeps only the newest ring).
# An explicit [start_t, end_t) window is NEVER trimmed by this knob; it stays
# exact apart from the pre-existing ring cap.
_REPLAY_MAX_COLS_RANGE = (0, 65_536)


def _int_in_range(env: Mapping[str, str], name: str, default: str, lo: int, hi: int) -> int:
    raw = env.get(name, default)
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer in [{lo}, {hi}]; got {raw!r}") from None
    if not (lo <= value <= hi):
        raise ValueError(f"{name} must be in [{lo}, {hi}]; got {raw!r}")
    return value


def _float_in_range(env: Mapping[str, str], name: str, default: str, lo: float, hi: float) -> float:
    raw = env.get(name, default)
    # A Turkish-locale operator types "20,0": one decimal comma with no point
    # reads as the decimal separator. Both "20,0" and "20.0" are accepted.
    text = str(raw).strip()
    if "," in text and "." not in text:
        text = text.replace(",", ".")
    try:
        value = float(text)
    except ValueError:
        raise ValueError(f"{name} must be a number in [{lo}, {hi}]; got {raw!r}") from None
    # NaN fails both comparisons; +inf fails the upper bound. Name the var.
    if not (lo <= value <= hi):
        raise ValueError(f"{name} must be in [{lo}, {hi}]; got {raw!r}")
    return value


def _bool_env(env: Mapping[str, str], name: str, default: str) -> bool:
    """A boolean switch. Unknown spellings are refused, naming the variable."""
    raw = env.get(name, default)
    word = str(raw).strip().lower()
    if word in _TRUE_WORDS:
        return True
    if word in _FALSE_WORDS:
        return False
    raise ValueError(
        f"{name} must be one of 0/1, false/true, no/yes or off/on; got {raw!r}"
    )


class Config(msgspec.Struct, frozen=True):
    """Immutable server configuration resolved from environment variables."""

    host: str = "127.0.0.1"
    port: int = 8720
    ring_columns: int = 32_768
    max_sessions: int = 4
    recording_gb_cap: float = 20.0
    recording_enabled: bool = True
    # Recording root. from_env expands "~"; direct
    # construction may carry an unexpanded default — consumers should
    # ``Path(cfg.data_dir).expanduser()`` defensively.
    data_dir: str = _DEFAULT_DATA_DIR
    alpaca_key: str | None = None
    alpaca_secret: str | None = None
    finnhub_key: str | None = None
    dt_crypto_ns: int = 250_000_000
    dt_equity_keyed_ns: int = 10**9
    # Keyless equity. dt_equity_book_ns is how often the four Cboe books are
    # read (5 s, the cadence Cboe's own book viewer reloads at).
    # dt_equity_keyless_grid_ns is the grid's COLUMN cadence (1 s): the last
    # merged book is re-asserted every column so the heatmap's right edge keeps
    # advancing between reads. dt_equity_keyless_ns is how long a symbol may go
    # without a Cboe print before the last-price fallback is polled (10 s).
    dt_equity_book_ns: int = 5 * 10**9
    dt_equity_keyless_ns: int = 10 * 10**9
    dt_equity_keyless_grid_ns: int = 10**9
    max_rows: int = 4096
    # First-launch price history (candles, so the client's eager
    # requestHistory returns real prices instead of a cold ring).
    # ``backfill_max_cols`` bounds the span: at most this many candles are
    # fetched and seeded before the first snapshot, one column each. Kept modest
    # (not ``ring_columns`` = 32768, which at 1 m candles would be ~22 days of
    # REST paging and blow past Yahoo's 7-day 1 m window) — 512 aligns with the
    # snapshot depth (SNAPSHOT_COLS) and bounds REST cost to a handful of pages.
    # The seeded columns carry price, volume and CVD, and no depth.
    backfill_enabled: bool = True
    backfill_max_cols: int = 512
    # Levels per side kept when a crypto book is emitted (see feeds/crypto.py
    # BOOK_TOP_N). The cap exists so one array build cannot blow up on a venue
    # that streams a very deep book; it is NOT a fidelity choice, and it is the
    # binding constraint on how far out the wide/full price bands can ever show
    # resting size.
    book_top_n: int = 20_000
    # Crypto grid tick override (0 = auto). The default crypto grid tick is the
    # sim-shaped 0.5 — correct for majors, but a sub-cent coin collapses into
    # 1-2 rows. A feed that knows its venue tick may declare ``preferred_tick``;
    # this env knob (FLOWMAP_CRYPTO_TICK) overrides both for the whole server
    # when neither path can answer. With no override and no declaration, a
    # feed opting into ``price_adaptive_tick`` (CryptoFeed) gets a tick scaled
    # to the instrument's price magnitude at the first real mid — see
    # core.grid.adaptive_tick_for (BTC/ETH keep 0.5; DOGE/PEPE get 1e-6-class).
    crypto_tick: float = 0.0
    # Time-based recording flush cadence in seconds (FLOWMAP_FLUSH_INTERVAL_S,
    # default 10): in addition to the REC_FLUSH_COLS column-count cadence, a
    # session flushes whenever its buffers have been accumulating for this
    # long — a Windows hard app-close (TerminateProcess, no shutdown hooks)
    # therefore loses at most ~this many seconds of recording, not a whole
    # 64-column part.
    rec_flush_interval_s: float = 10.0
    # Minimum wall-clock seconds between retention walks per session
    # (FLOWMAP_RETENTION_MIN_INTERVAL_S, default 60). The rglob+stat pass over
    # the whole recording tree used to run after every cadence flush; the cap
    # moves at GB scales, so a per-minute re-walk was pure disk churn. 0
    # restores the walk-after-every-flush behavior.
    retention_min_interval_s: float = 60.0
    # Bound on the columns a NO-WINDOW replay subscribe may materialize
    # (FLOWMAP_REPLAY_MAX_COLS). 0 = follow ``ring_columns``; a positive value
    # is an explicit depth. The client's [start_t, end_t) window is never
    # affected by this knob (see _REPLAY_MAX_COLS_RANGE).
    replay_max_cols: int = 0
    # Shut the sidecar down when its stdin reaches EOF (FLOWMAP_EXIT_ON_STDIN_EOF).
    # The desktop shell holds the write end of that pipe, so EOF
    # means the shell has exited; the lifespan flush then runs before exit.
    exit_on_stdin_eof: bool = False

    def __repr__(self) -> str:
        """Every field, with exchange/provider keys masked (never printed)."""
        parts = []
        for name in self.__struct_fields__:
            value = getattr(self, name)
            if name in _SECRET_FIELDS and value is not None:
                parts.append(f"{name}=***")
                continue
            parts.append(f"{name}={value!r}")
        return f"Config({', '.join(parts)})"

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        host = env.get("FLOWMAP_HOST", "127.0.0.1")
        if host not in _ALLOWED_HOSTS:
            raise ValueError(
                f"FLOWMAP_HOST must be one of {_ALLOWED_HOSTS} (loopback only, "
                f"spec); got {host!r}"
            )

        # Alpaca credentials are only usable as a pair.
        alpaca_key = env.get("ALPACA_API_KEY")
        alpaca_secret = env.get("ALPACA_API_SECRET")
        if not (alpaca_key and alpaca_secret):
            alpaca_key = None
            alpaca_secret = None

        # 0 = auto (feed-declared preferred_tick, else the sim-shaped fallback).
        crypto_tick = _float_in_range(env, "FLOWMAP_CRYPTO_TICK", "0.0", *_CRYPTO_TICK_RANGE)

        ring_columns = _int_in_range(env, "FLOWMAP_RING_COLUMNS", "32768", *_RING_COLUMNS_RANGE)
        return cls(
            host=host,
            port=_int_in_range(env, "FLOWMAP_PORT", "8720", *_PORT_RANGE),
            ring_columns=ring_columns,
            # Column cadence for the sim + crypto grid. Overridable so the
            # scroll-back e2e can drive the sim fast enough to overrun the
            # client's full-res budget in seconds. Default 250 ms (4 cols/s).
            dt_crypto_ns=_int_in_range(
                env, "FLOWMAP_DT_CRYPTO_NS", str(250_000_000), *_DT_NS_RANGE
            ),
            dt_equity_book_ns=_int_in_range(
                env, "FLOWMAP_DT_EQUITY_BOOK_NS", str(5 * 10**9), *_DT_EQUITY_BOOK_NS_RANGE
            ),
            dt_equity_keyless_ns=_int_in_range(
                env, "FLOWMAP_DT_EQUITY_KEYLESS_NS", str(10 * 10**9), *_DT_NS_RANGE
            ),
            dt_equity_keyless_grid_ns=_int_in_range(
                env, "FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS", str(10**9), *_DT_NS_RANGE
            ),
            max_sessions=_int_in_range(
                env, "FLOWMAP_MAX_SESSIONS", "4", *_MAX_SESSIONS_RANGE
            ),
            recording_gb_cap=_float_in_range(
                env, "FLOWMAP_RECORDING_GB_CAP", "20.0", *_RECORDING_GB_CAP_RANGE
            ),
            recording_enabled=_bool_env(env, "FLOWMAP_RECORDING_ENABLED", "1"),
            # An empty value means "unset": Path("") would be the CWD, the very
            # launch-directory dependence (the warehouse agrees).
            data_dir=str(
                Path(env.get("FLOWMAP_DATA_DIR") or _DEFAULT_DATA_DIR).expanduser()
            ),
            alpaca_key=alpaca_key,
            alpaca_secret=alpaca_secret,
            book_top_n=_int_in_range(env, "FLOWMAP_BOOK_TOP_N", "20000", *_BOOK_TOP_N_RANGE),
            crypto_tick=crypto_tick,
            # An empty key is "no key", like an absent Alpaca pair (normalized
            # to None) — the equity tier test is a truthiness check.
            finnhub_key=env.get("FINNHUB_API_KEY") or None,
            backfill_enabled=_bool_env(env, "FLOWMAP_BACKFILL_ENABLED", "1"),
            backfill_max_cols=_int_in_range(
                env, "FLOWMAP_BACKFILL_MAX_COLS", "512", *_BACKFILL_MAX_COLS_RANGE
            ),
            rec_flush_interval_s=_float_in_range(
                env, "FLOWMAP_FLUSH_INTERVAL_S", "10.0", *_REC_FLUSH_INTERVAL_S_RANGE
            ),
            retention_min_interval_s=_float_in_range(
                env,
                "FLOWMAP_RETENTION_MIN_INTERVAL_S",
                "60.0",
                *_RETENTION_MIN_INTERVAL_S_RANGE,
            ),
            replay_max_cols=_int_in_range(
                env, "FLOWMAP_REPLAY_MAX_COLS", "0", *_REPLAY_MAX_COLS_RANGE
            ),
            exit_on_stdin_eof=_bool_env(env, "FLOWMAP_EXIT_ON_STDIN_EOF", "0"),
        )
