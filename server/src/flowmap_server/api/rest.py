"""REST routes: health +
symbol directory + on-disk recording inventory.

Handlers are pure in-memory lookups — network calls are FORBIDDEN here. The
directory is now the FULL bundled universe (``data/universe.py``): the sim
symbol, a curated crypto shortlist, and a curated large-cap US equity list —
each with a capability read off its real feed so the directory can never drift
from what a subscribe actually delivers:

- the sim symbol, capability from :class:`SimFeed`;
- the curated crypto shortlist (live market-wide enumeration is unavailable
  offline in the pinned deps, so the LIST is bundled; live price/mover data for
  these symbols is served separately by ``/api/movers`` + ``/api/quote`` through
  the network cache);
- the curated equity list, capability read off :class:`EquityFeed` (the keyless
  SYNTH tier on this machine; keyed tiers activate with no code change).

``current_directory()`` is shared with the ``/api/universe`` handler
(``api/discovery.py``) so both surfaces stay identical and honest.
"""

from __future__ import annotations

import logging
import os
import time

from fastapi import APIRouter, Request

from flowmap_server import __version__
from flowmap_server.api import _env
from flowmap_server.api.errors import ApiError
from flowmap_server.config import Config
from flowmap_server.data.universe import build_directory, filter_directory
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import wire

__all__ = ["router", "current_directory", "CRYPTO_CAPABILITY"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# SimFeed's constructor does no I/O; seed is irrelevant for the capability.
_SIM_CAPABILITY = SimFeed(seed=0).capability

# Crypto directory capability. Mirrors the core
# keys a crypto subscribe delivers — L2 depth, tick tape, exchange-true side and
# CVD. (Per-market marker lists live on the feed itself.)
CRYPTO_CAPABILITY: dict[str, object] = {
    "depth": "L2",
    "tape": "tick",
    "trade_side": "exchange",
    "cvd": "exchange",
}


def _equity_capability() -> dict[str, object]:
    """Equity capability mirrored from :class:`EquityFeed`'s own tier selection
    so the directory never lies about an equity subscribe. Keys are auto-detected
    from env: keyless -> SYNTH on this machine; Alpaca/Finnhub keyed
    tiers activate with no code change. Construction is pure (no I/O)."""
    try:
        cfg = Config.from_env(os.environ)
    except Exception as exc:  # a bad env falls back to keyless defaults
        # Visible, not silent: the message names the setting (never a key value).
        logger.warning("configuration rejected, using keyless defaults: %s", exc)
        cfg = Config()
    return EquityFeed("AAPL", cfg).capability


def _config_error() -> str | None:
    """The reason the environment fails :meth:`Config.from_env`, or ``None``.

    Surfaced on ``/api/health`` as ``config_error`` so a desktop shell can show
    that a malformed setting was ignored (rather than silently running on the
    keyless defaults). The text names the offending variable, never a secret."""
    try:
        Config.from_env(os.environ)
    except Exception as exc:  # reported, not raised: health never 500s
        return str(exc)
    return None


def current_directory() -> tuple[dict[str, object], ...]:
    """The full merged directory with live-derived capabilities (no I/O)."""
    return build_directory(
        sim_symbol=SimFeed.symbol,
        sim_capability=_SIM_CAPABILITY,
        crypto_capability=CRYPTO_CAPABILITY,
        equity_capability=_equity_capability(),
    )


def _health_authorized(request: Request) -> bool:
    """True when the caller presents the session token (or none is configured).

    ``/api/health`` is token-exempt so liveness probes work without a token.
    The operational detail below is not public: only a caller that proves the
    session token gets it. A single ``x-flowmap-token`` header is the only
    accepted carrier, matching the middleware's rule for HTTP requests.
    """
    values = request.headers.getlist("x-flowmap-token")
    provided = values[0] if len(values) == 1 else None
    return _env.session_token_ok(provided)


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    """Liveness, plus the operational snapshot for an authorized caller.

    Without the session token the answer is liveness only: ``status``,
    ``version``, ``protocol_version`` and ``uptime_s``. Any loopback-origin page
    can reach this route, so everything else is withheld from it: the feed
    rows, session ids, stats, config errors, ``recording_enabled`` and
    ``active_sessions``.

    With the token, the body is the full operational snapshot (v3): one row
    per ACTIVE session with its feed kind and live/degraded state, and, when
    the core mounts a stats producer, its ``snapshot()`` dict VERBATIM under
    ``stats``.

    Reads are defensive: the health probe must never 500. A missing manager, a
    core without ``stats``, or a snapshot that raises degrades to
    ``stats: null`` + ``stats_available: false``, still ``status: ok``.
    """
    cfg: Config | None = getattr(request.app.state, "cfg", None)
    started = getattr(request.app.state, "started_monotonic_ns", None)
    uptime_s = max(0.0, (time.monotonic_ns() - started) / 1e9) if started else 0.0
    recording_enabled = bool(getattr(cfg, "recording_enabled", False))
    if not _health_authorized(request):
        return {
            "status": "ok",
            "version": __version__,
            "protocol_version": wire.PROTO_VER,
            "uptime_s": round(uptime_s, 3),
        }
    manager = getattr(request.app.state, "manager", None)
    feeds: list[dict[str, str]] = []
    # Keyed (market, symbol, mode, source, band) and, for replay, + (start_t,
    # end_t); the band is geometry, not identity, so it is not surfaced here.
    # session_id is the join key to stats.staleness_ms (core/stats.py keys by
    # session id) — without it an operator had to string-parse ids to learn
    # WHICH symbol is stale.
    #
    # Sort with a TOTAL key: the tuple carries None (source for replay/plain
    # subscribes; start_t/end_t on unbounded windows) and ints, so a bare
    # sorted() raises TypeError the moment two sessions agree on
    # (market, symbol, mode, band) but differ in shape — exactly the mixed
    # replay-window state. Same treatment as
    # export.py `_session_sort_key` (None → ""), inlined to keep this hot
    # probe dependency-free.
    active = manager.active_sessions() if manager is not None else []
    for key, s in sorted(
        active,
        key=lambda kv: tuple("" if part is None else str(part) for part in kv[0]),
    ):
        feed = s.feed
        feeds.append(
            {
                "market": str(getattr(feed, "market", key[0]) if feed else key[0]),
                "symbol": str(getattr(feed, "symbol", key[1]) if feed else key[1]),
                "mode": str(key[2]),
                "state": str(s.feed_state),
                "session_id": str(s.session_id),
            }
        )
    # The server-wide stats producer (SessionStats). Rendered VERBATIM —
    # whatever keys snapshot() returns go on the wire untouched.
    stats: dict[str, object] | None = None
    snapshot = getattr(getattr(manager, "stats", None), "snapshot", None)
    if callable(snapshot):
        try:
            snap = snapshot()
            if isinstance(snap, dict):
                stats = snap
        except Exception:  # a broken producer must not 500 health
            logger.warning("health stats producer failed", exc_info=True)
    return {
        "status": "ok",
        "version": __version__,
        "protocol_version": wire.PROTO_VER,
        "uptime_s": round(uptime_s, 3),
        "recording_enabled": recording_enabled,
        "active_sessions": len(feeds),
        "feeds": feeds,
        "stats": stats,
        "stats_available": stats is not None,
        "config_error": _config_error(),
    }


@router.get("/recordings")
def recordings(request: Request) -> dict[str, list[dict[str, object]]]:
    """Read-only inventory of on-disk recordings — one row per (market,
    symbol) with its relative path, total size, part count, and the
    first/last recorded timestamps (hour resolution, from the filename
    metadata the recorder already maintains; no Parquet file is opened).

    Sync handler ON PURPOSE: FastAPI serves it from the worker threadpool,
    so walking a large recordings tree never blocks the event loop. The
    server is loopback-only and the surface is read-only listing."""
    manager = getattr(request.app.state, "manager", None)
    recorder = manager.recorder if manager is not None else None
    rows = recorder.inventory() if recorder is not None else []
    return {"recordings": rows}


@router.get("/symbols")
async def symbols(q: str = "") -> dict[str, list[dict[str, object]]]:
    """Merged symbol directory, filtered by case-insensitive substring.

    Returns the FULL bundled universe (kept backward-compatible: the legacy
    sim/crypto/equity shortlist symbols are all still present)."""
    return {"symbols": filter_directory(current_directory(), q=q)}


@router.get("/recordings/availability")
def recording_availability(request: Request, market: str, symbol: str) -> dict:
    manager = getattr(request.app.state, "manager", None)
    recorder = manager.recorder if manager is not None else None
    result = recorder.availability(market, symbol) if recorder is not None else {
        "market": market, "symbol": symbol, "hours": [], "latest_column_ns": None,
        "coverage": "filename-hour-buckets"}
    cfg = manager.cfg if manager is not None else None
    # recording_enabled lets the client explain an empty list: "no
    # recordings" with the switch off is a settings problem, not an empty store.
    return {
        **result,
        "max_columns": cfg.ring_columns if cfg is not None else 0,
        "recording_enabled": bool(cfg is not None and cfg.recording_enabled),
    }


@router.get("/recordings/window")
def recording_window(request: Request, market: str, symbol: str, start_ns: int, end_ns: int) -> dict:
    """Exact selected range, off-loop, using the same bounded replay read.

    Empty/gap/pruned/oversized selections are visible before replacing LIVE.
    No density payload is returned; authoritative attach bounds are reasserted.
    """
    from flowmap_server.core.session import ReplayUnavailableError
    manager = getattr(request.app.state, "manager", None)
    if manager is None or manager.recorder is None:
        raise ApiError(404, "recording_store_missing", "no recording store is configured")
    try:
        feed, _ = manager.replay_feed_blocking(market, symbol, start_ns, end_ns)
    except ReplayUnavailableError as exc:
        logger.info("replay window unavailable for %s/%s: %s", market, symbol, exc)
        raise ApiError(422, "replay_unavailable", "no replayable recording covers this window") from exc
    except ValueError as exc:
        logger.info("replay window rejected for %s/%s: %s", market, symbol, exc)
        raise ApiError(422, "invalid_window", "the requested replay window is invalid") from exc
    return feed.playback()
