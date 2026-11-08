"""GET /api/export — data egress for finalized columns.

Streams the last-N FINALIZED columns of an active session's ring as CSV or
JSON, so recordings/live streams can leave the terminal for pandas, Excel or
a post-mortem. Read-only; the loopback Host guard and the session token
(when configured) apply exactly as they do to the rest of the API.

Selection: ``symbol=`` narrows the candidate sessions (key symbol or the
feed's own symbol); without it the "active" session is chosen
deterministically — live mode preferred, then the freshest newest finalized
column, then the lexicographically first key. ``columns=N`` (default 240) is
clamped to the ring size — the ring IS the retention bound.

Only PUBLIC core accessors are used (grid.history / grid.to_depth / grid.cfg
/ grid.scale / price_scale.row_to_price), so the export never reaches into
grid internals.

Shape:
- CSV: one header comment line (symbol/market/tick/dt_ns/rows/columns), one
  CSV header row ``t0_ns,price_lo,price_hi,b0,a0,b1,a1,...`` and one row per
  finalized column: its t0_ns, the grid's price extent (row 0 / row N), then
  the raw bid/ask row values (f32, exactly what the wire carries).
- JSON: ``{"symbol", "tick", "columns": [{"t0", "bids": [...], "asks":
  [...]}]}``.

Both bodies are size-capped: a worst-case estimate above ``EXPORT_MAX_BYTES``
is refused with a structured 400 BEFORE any column is copied. The accepted
window is copied on the event loop (the only writer of the ring), and the
bodies are then streamed from that copy, so a concurrent write can never tear
a column or change the column count of one export.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from flowmap_server.api.errors import ApiError
from flowmap_server.core.grid import Grid
from flowmap_server.core.session import Session, SessionManager
from flowmap_server.core.price_scale import row_to_price

__all__ = ["router", "EXPORT_MAX_BYTES", "EXPORT_DEFAULT_COLUMNS"]

router = APIRouter(prefix="/api")

EXPORT_DEFAULT_COLUMNS = 240
# Hard payload bound. A worst-case estimate over this refuses the request up
# front (structured 400) — the generators themselves never exceed it.
EXPORT_MAX_BYTES = 64 * 1024 * 1024

# history()'s before_t is exclusive; this is "everything finalized so far".
_MAX_T_NS = (1 << 62) - 1
# Worst-case serialized width of one f32 value (str(float) <= ~13 chars for
# f32, json.dumps similar; margin included) for the size pre-check.
_BYTES_PER_VALUE = 26

# The session key carries the RAW Subscribe symbol (subscribe refuses only
# "."/".."; separators are rewritten only for recording paths), so quotes,
# commas, even CR/LF can reach this endpoint's ``content-disposition`` header
# (h11 refuses a header value containing CR/LF — the export would 500) and its
# CSV comment line (an embedded newline would forge data rows). Project every
# symbol/market through this before it touches a header or the CSV header.
_UNSAFE_EXPORT_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_export_name(name: str) -> str:
    """Header/filename/CSV-comment-safe projection of a market/symbol string."""
    cleaned = _UNSAFE_EXPORT_CHARS.sub("_", name).strip("._")
    return cleaned or "session"


def _session_sort_key(item: tuple[tuple, object]) -> tuple[str, ...]:
    """Deterministic sort key for the session table.

    Key elements are ``str | None`` (``source`` is None for replay/plain
    subscribes), so a bare ``sorted()`` raises ``TypeError`` (None < str) the
    moment two sessions agree on (market, symbol, mode, band) but differ in
    source. Map None to "" — deterministic, total, never raises."""
    return tuple("" if part is None else str(part) for part in item[0])


def _pick_session(
    manager: SessionManager | None, symbol: str | None
) -> tuple[Session | None, tuple | None]:
    """The export target session and its key, or ``(None, None)``.

    Deterministic "active session" rule: prefer mode='live', then the
    freshest newest finalized column, then key order.
    """
    if manager is None:
        return None, None
    best_key = None
    best_rank: tuple[int, int] | None = None
    best = None
    for key, s in sorted(manager.active_sessions(), key=_session_sort_key):
        sym = str(getattr(s.feed, "symbol", key[1]))
        if symbol is not None and sym != symbol:
            continue
        newest = 0
        try:
            cols = s.grid.history(_MAX_T_NS, 1)
            newest = int(cols[-1].t0_ns) if cols else 0
        except Exception:  # an unreadable grid is just not a candidate
            continue
        is_live = 1 if key[2] == "live" else 0
        rank = (is_live, newest)
        if best_rank is None or rank > best_rank:
            best_key, best_rank, best = key, rank, s
    if best is None:
        return None, best_key
    return best, best_key


@dataclass(frozen=True)
class _Snapshot:
    """Everything one export body needs, copied while the event loop owns the
    grid. The streaming generators read only this, never the live ring."""

    symbol: str
    market: str
    tick: float
    dt_ns: int
    rows: int
    price_lo: float
    price_hi: float
    columns: list[tuple[int, np.ndarray, np.ndarray]]  # (t0_ns, bid f32, ask f32)


def _snapshot(grid: Grid, n: int, symbol: str, market: str) -> _Snapshot:
    """Copy the last ``n`` finalized columns and the grid metadata.

    Called on the event loop (the feed writes the ring there too), with no
    await in between, so the copied columns and the metadata describe one
    consistent instant. Serialization then runs off-loop on these copies only
    (an executor thread must never read the ring while the loop writes it).
    """
    cfg = grid.cfg
    rows = int(cfg.rows)
    scale = grid.scale
    columns: list[tuple[int, np.ndarray, np.ndarray]] = []
    for c in grid.history(_MAX_T_NS, n):
        depth = grid.to_depth(c)
        # Synth grids drop the ask channel on the wire; the export keeps the
        # grid's own ask density rather than failing the whole request.
        ask = depth.ask if depth.ask is not None else c.ask.astype(np.float32)
        columns.append((int(c.t0_ns), np.asarray(depth.bid), np.asarray(ask)))
    return _Snapshot(
        symbol=symbol,
        market=market,
        # The ACTIVE epoch's tick, not cfg.tick: a price-adaptive crypto grid
        # installs a scaled tick (e.g. 1e-6 for DOGE) at its first real mid, and
        # the exported metadata must describe the rows the scale actually maps.
        tick=grid.current_epoch_params().tick,
        dt_ns=int(cfg.dt_ns),
        rows=rows,
        price_lo=row_to_price(scale, 0.0),
        price_hi=row_to_price(scale, float(rows)),
        columns=columns,
    )


def _csv_lines(snap: _Snapshot) -> Iterator[str]:
    """CSV body, one line per finalized column (comment header first)."""
    rows = snap.rows
    price_lo, price_hi = snap.price_lo, snap.price_hi
    # The comment line must stay ONE line and header-safe: the symbol is raw
    # Subscribe text, so project it (see _safe_export_name).
    yield (
        f"# symbol={_safe_export_name(snap.symbol)} market={_safe_export_name(snap.market)} "
        f"tick={snap.tick} "
        f"dt_ns={snap.dt_ns} rows={rows} columns={len(snap.columns)}\n"
    )
    names = ",".join(f"b{i},a{i}" for i in range(rows))
    yield f"t0_ns,price_lo,price_hi,{names}\n"
    for t0_ns, bid_values, ask_values in snap.columns:
        values = ",".join(
            f"{b!r},{a!r}" for b, a in zip(bid_values.tolist(), ask_values.tolist())
        )
        yield f"{t0_ns},{price_lo!r},{price_hi!r},{values}\n"


def _json_chunks(snap: _Snapshot) -> Iterator[str]:
    """JSON body as stream chunks: ``{"symbol","tick","columns":[...]}``."""
    yield (
        '{"symbol":' + json.dumps(snap.symbol)
        + ',"tick":' + json.dumps(snap.tick)
        + ',"columns":['
    )
    last = len(snap.columns) - 1
    for i, (t0_ns, bid_values, ask_values) in enumerate(snap.columns):
        chunk = json.dumps(
            {
                "t0": t0_ns,
                "bids": bid_values.tolist(),
                "asks": ask_values.tolist(),
            },
            separators=(",", ":"),
        )
        yield chunk + ("," if i < last else "")
    yield "]}"


@router.get("/export")
async def export(
    request: Request,
    format: Literal["csv", "json"] = "csv",
    columns: int = EXPORT_DEFAULT_COLUMNS,
    symbol: str | None = None,
) -> StreamingResponse:
    """Stream the last-N finalized columns.

    Async ON PURPOSE: the copy of the ring happens here, on the event loop
    that owns every write to it (see :func:`_snapshot`). Serialization runs
    later on the copied arrays, which Starlette iterates in the worker
    threadpool, so a large export never blocks the loop."""
    if columns < 1:
        raise ApiError(400, "invalid_columns", "columns must be a positive integer")
    manager = getattr(request.app.state, "manager", None)
    session, key = _pick_session(manager, symbol)
    if session is None or key is None:
        wanted = f" for symbol {symbol!r}" if symbol else ""
        raise ApiError(404, "no_active_session", f"no active session{wanted} to export")
    grid = session.grid
    # The ring IS the retention bound: clamp instead of erroring.
    n = min(columns, int(grid.cfg.ring_columns))
    feed = session.feed
    sym = str(getattr(feed, "symbol", key[1]))
    market = str(getattr(feed, "market", key[0]))
    # How many columns the copy WOULD hold, from scalar bounds alone: the size
    # refusal below must not copy a window it is about to reject.
    retained = grid.retained_sequence_range()
    available = 0 if retained is None else min(n, retained[1] - retained[0] + 1)
    if available == 0:
        raise ApiError(
            404, "no_finalized_columns", f"session for {sym!r} has no finalized columns to export"
        )
    rows = int(grid.cfg.rows)
    # Size pre-check (worst case: 3 numbers + rows*2 values per line/row).
    estimated = available * (64 + rows * 2 * _BYTES_PER_VALUE)
    if estimated > EXPORT_MAX_BYTES:
        raise ApiError(
            400,
            "export_too_large",
            (
                f"export too large: ~{estimated} bytes for {available} columns "
                f"x {rows} rows exceeds the {EXPORT_MAX_BYTES}-byte cap; "
                f"request fewer columns"
            ),
        )
    snap = _snapshot(grid, n, sym, market)
    if format == "csv":
        return StreamingResponse(
            _csv_lines(snap),
            media_type="text/csv; charset=utf-8",
            headers={
                "content-disposition": (
                    f'attachment; filename="export-{_safe_export_name(sym)}.csv"'
                )
            },
        )
    return StreamingResponse(
        _json_chunks(snap),
        media_type="application/json",
        headers={
            "content-disposition": (
                f'attachment; filename="export-{_safe_export_name(sym)}.json"'
            )
        },
    )
