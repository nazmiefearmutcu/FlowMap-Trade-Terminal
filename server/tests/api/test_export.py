"""/api/export: CSV + JSON streaming of the
last-N finalized columns of an active session.

Sessions are real `Session` objects whose Grid is seeded via the PUBLIC
`Grid.preload` rehydration API (small rows/ring for speed) — the endpoint
must go through the same public core accessors (`grid.history`,
`grid.to_depth`, `grid.cfg`, `grid.scale`, `row_to_price`) it uses live.
"""

from __future__ import annotations

import csv
import io
import json
import re

import httpx
import numpy as np
import pytest

from flowmap_server.api.app import create_app
from flowmap_server.api import export as export_mod
from flowmap_server.config import Config
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.price_scale import row_to_price
from flowmap_server.core.session import Session
from flowmap_server.proto import events

ROWS = 8
RING = 16
TICK = 0.5
DT_NS = 250_000_000
P0 = 100.0


class _StubFeed:
    def __init__(self, symbol: str, market: str = "sim") -> None:
        self.market = market
        self.symbol = symbol


def _make_grid(n_cols: int, ring: int = RING, grid_mode: int = events.MODE_L2) -> Grid:
    cfg = GridCfg(
        tick=TICK, tick_multiple=1, dt_ns=DT_NS, p0=P0, rows=ROWS,
        ring_columns=ring, mode=grid_mode,
    )
    grid = Grid(cfg)
    cols = []
    for i in range(n_cols):
        bid = np.arange(ROWS, dtype=np.float16) + i  # distinct, f16-exact
        ask = np.arange(ROWS, dtype=np.float16) * 2.0 + i
        bar = events.BarColumn(
            epoch=0, col_seq=i, t0_ns=i * DT_NS,
            o=100.0, h=101.0, l=99.0, c=100.5,
            vol_buy=1.0 + i, vol_sell=2.0, cvd_cum=0.0,
            vwap_num_cum=100.0, vwap_den_cum=1.0,
        )
        cols.append(FinalizedColumn(epoch=0, col_seq=i, t0_ns=i * DT_NS,
                                    bid=bid, ask=ask, bar=bar))
    grid.preload(cols, [events.EpochParams(epoch=0, tick=TICK, tick_multiple=1,
                                           dt_ns=DT_NS, p0=P0, rows=ROWS)])
    return grid


def _attach(app, symbol: str, n_cols: int = 5, *, mode: str = "live",
            market: str = "sim", ring: int = RING,
            grid_mode: int = events.MODE_L2) -> Session:
    session = Session(
        f"{market}:{symbol}:{mode}:test",
        feed=_StubFeed(symbol, market),
        grid=_make_grid(n_cols, ring, grid_mode),
    )
    app.state.manager._sessions[(market, symbol, mode, None, "0")] = session
    return session


@pytest.fixture
def app(tmp_path):
    return create_app(Config(data_dir=str(tmp_path / "rec"),
                             recording_enabled=False))


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8720"
    ) as c:
        yield c


# --- CSV --------------------------------------------------------------------


async def test_csv_streams_last_n_finalized_columns(app, client):
    _attach(app, "SIM-EXPORT", n_cols=5)
    r = await client.get("/api/export", params={"format": "csv", "columns": 3})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "SIM-EXPORT" in r.headers["content-disposition"]
    lines = r.text.splitlines()
    # Header comment line with symbol/tick, then the CSV header row.
    assert lines[0].startswith("# symbol=SIM-EXPORT")
    assert f"tick={TICK}" in lines[0] and f"rows={ROWS}" in lines[0]
    assert "columns=3" in lines[0]
    assert lines[1].startswith("t0_ns,price_lo,price_hi,")
    data = lines[2:]
    assert len(data) == 3
    t0s = [int(row.split(",")[0]) for row in data]
    # LAST-N finalized columns: the newest three, chronological.
    assert t0s == [2 * DT_NS, 3 * DT_NS, 4 * DT_NS]
    # price_lo/price_hi are the grid's price extent (public scale).
    grid = app.state.manager._sessions[
        ("sim", "SIM-EXPORT", "live", None, "0")
    ]._grid
    scale = grid.scale
    for row in data:
        parts = row.split(",")
        assert float(parts[1]) == pytest.approx(row_to_price(scale, 0.0))
        assert float(parts[2]) == pytest.approx(row_to_price(scale, float(ROWS)))
    # Row values match the newest column's f32 payload (b,a interleaved).
    parts = data[-1].split(",")
    assert len(parts) == 3 + 2 * ROWS
    depth = grid.to_depth(grid.history(1 << 62, 1)[-1])
    for r_ in range(ROWS):
        assert float(parts[3 + 2 * r_]) == pytest.approx(float(depth.bid[r_]))
        assert float(parts[4 + 2 * r_]) == pytest.approx(float(depth.ask[r_]))


async def test_csv_is_wellformed_csv(app, client):
    _attach(app, "SIM-EXPORT", n_cols=4)
    r = await client.get("/api/export", params={"format": "csv", "columns": 2})
    body = "\n".join(r.text.splitlines()[1:])  # drop the comment line
    rows = list(csv.reader(io.StringIO(body)))
    assert rows[0][:3] == ["t0_ns", "price_lo", "price_hi"]
    assert all(len(row) == 3 + 2 * ROWS for row in rows[1:])
    assert len(rows[1:]) == 2


# --- JSON -------------------------------------------------------------------


async def test_json_export_shape(app, client):
    _attach(app, "SIM-EXPORT", n_cols=5)
    r = await client.get("/api/export", params={"format": "json", "columns": 2})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    body = json.loads(r.text)
    assert set(body) == {"symbol", "tick", "columns"}
    assert body["symbol"] == "SIM-EXPORT"
    assert body["tick"] == TICK
    cols = body["columns"]
    assert [c["t0"] for c in cols] == [3 * DT_NS, 4 * DT_NS]
    for c in cols:
        assert set(c) == {"t0", "bids", "asks"}
        assert len(c["bids"]) == ROWS and len(c["asks"]) == ROWS
    grid = app.state.manager._sessions[
        ("sim", "SIM-EXPORT", "live", None, "0")
    ]._grid
    depth = grid.to_depth(grid.history(1 << 62, 1)[-1])
    assert cols[-1]["bids"] == pytest.approx([float(v) for v in depth.bid])
    assert cols[-1]["asks"] == pytest.approx([float(v) for v in depth.ask])


async def test_adaptive_tick_is_reported_in_export_metadata(app, client):
    """A price-adaptive grid (DOGE-class) reports its ACTIVE tick, not the
    nominal fallback the GridCfg still carries."""
    active = 1e-6
    close = 0.0825
    p0 = close - ROWS * active / 2.0
    grid = Grid(
        GridCfg(
            tick=TICK, tick_multiple=1, dt_ns=DT_NS, p0=p0, rows=ROWS,
            ring_columns=RING, mode=events.MODE_L2, auto_tick=True,
        )
    )
    cols = []
    for i in range(3):
        bar = events.BarColumn(
            epoch=0, col_seq=i, t0_ns=i * DT_NS,
            o=close, h=close, l=close, c=close,
            vol_buy=1.0, vol_sell=1.0, cvd_cum=0.0,
            vwap_num_cum=close, vwap_den_cum=1.0,
        )
        cols.append(
            FinalizedColumn(
                epoch=0, col_seq=i, t0_ns=i * DT_NS,
                bid=np.ones(ROWS, dtype=np.float16),
                ask=np.ones(ROWS, dtype=np.float16),
                bar=bar,
            )
        )
    grid.preload(
        cols,
        [events.EpochParams(epoch=0, tick=active, tick_multiple=1,
                            dt_ns=DT_NS, p0=p0, rows=ROWS)],
    )
    session = Session(
        "doge", feed=_StubFeed("DOGEUSDT", "binance-spot"), grid=grid
    )
    app.state.manager._sessions[
        ("binance-spot", "DOGEUSDT", "live", None, "0")
    ] = session

    csv_body = await client.get("/api/export", params={"format": "csv", "columns": 3})
    assert csv_body.status_code == 200
    assert "tick=1e-06" in csv_body.text.splitlines()[0]
    json_body = json.loads(
        (
            await client.get("/api/export", params={"format": "json", "columns": 3})
        ).text
    )
    assert json_body["tick"] == pytest.approx(active)


# --- selection --------------------------------------------------------------


async def test_symbol_param_selects_that_session(app, client):
    _attach(app, "SIM-A", n_cols=2)
    _attach(app, "SIM-B", n_cols=4)
    r = await client.get(
        "/api/export", params={"format": "json", "columns": 100, "symbol": "SIM-B"}
    )
    body = json.loads(r.text)
    assert body["symbol"] == "SIM-B"
    assert [c["t0"] for c in body["columns"]][-1] == 3 * DT_NS


async def test_default_active_session_prefers_live_and_freshest(app, client):
    """No symbol given: live beats replay, then the freshest newest column."""
    _attach(app, "SIM-REPLAY", n_cols=9, mode="replay")
    _attach(app, "SIM-LIVE", n_cols=4, mode="live")
    body = json.loads(
        (
            await client.get("/api/export", params={"format": "json"})
        ).text
    )
    assert body["symbol"] == "SIM-LIVE"


async def test_columns_clamped_to_ring_size(app, client):
    """columns=N is capped by the ring — the retention bound — not an error."""
    _attach(app, "SIM-EXPORT", n_cols=32, ring=8)
    r = await client.get("/api/export", params={"format": "json", "columns": 1000})
    assert r.status_code == 200
    assert len(json.loads(r.text)["columns"]) == 8


# --- structured errors --------------------------------------------------------


async def test_export_404_no_sessions(app, client):
    r = await client.get("/api/export", params={"format": "json"})
    assert r.status_code == 404
    body = r.json()
    assert body["error"]["code"] == "no_active_session"
    assert "no active session" in body["error"]["message"]


async def test_export_404_unknown_symbol(app, client):
    _attach(app, "SIM-A")
    r = await client.get(
        "/api/export", params={"format": "json", "symbol": "NOPE"}
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "no_active_session"
    assert "NOPE" in r.json()["error"]["message"]


async def test_export_404_no_finalized_columns(app, client):
    session = Session("empty", feed=_StubFeed("SIM-EMPTY"),
                      grid=_make_grid(0))
    app.state.manager._sessions[("sim", "SIM-EMPTY", "live", None, "0")] = session
    r = await client.get(
        "/api/export", params={"format": "json", "symbol": "SIM-EMPTY"}
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "no_finalized_columns"
    assert "finalized columns" in r.json()["error"]["message"]


async def test_export_400_nonpositive_columns(app, client):
    _attach(app, "SIM-A")
    for bad in ("0", "-5"):
        r = await client.get("/api/export", params={"format": "csv", "columns": bad})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "invalid_columns"


async def test_export_422_bad_format_and_columns(app, client):
    _attach(app, "SIM-A")
    r = await client.get("/api/export", params={"format": "xml"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_params"
    r = await client.get("/api/export", params={"format": "csv", "columns": "abc"})
    assert r.status_code == 422


async def test_export_payload_cap_refuses_up_front(app, client, monkeypatch):
    _attach(app, "SIM-A", n_cols=5)
    monkeypatch.setattr(export_mod, "EXPORT_MAX_BYTES", 10)
    r = await client.get("/api/export", params={"format": "json", "columns": 5})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "export_too_large"
    assert "cap" in body["error"]["message"]


# --- key-shape + symbol-text robustness --------------------------


async def test_sessions_with_none_and_str_source_still_sort(app, client):
    """Regression: session keys carry ``source: str | None``, so a bare
    ``sorted()`` raised TypeError (None vs str) — a 500 on export — whenever
    two sessions agreed on (market, symbol, mode, band) but differed in
    source. Both orders must stay a 200 with a deterministic winner."""
    s_none = Session("a", feed=_StubFeed("SIM-DUAL"), grid=_make_grid(2))
    s_named = Session("b", feed=_StubFeed("SIM-DUAL"), grid=_make_grid(3))
    app.state.manager._sessions[("sim", "SIM-DUAL", "live", None, "0")] = s_none
    app.state.manager._sessions[("sim", "SIM-DUAL", "live", "crypcodile", "0")] = s_named
    r = await client.get("/api/export", params={"format": "json", "columns": 1})
    assert r.status_code == 200
    body = json.loads(r.text)
    # Deterministic: "" (None source) sorts before "crypcodile"; the "active"
    # rank still prefers the freshest session (s_named, 3 cols).
    assert body["symbol"] == "SIM-DUAL"
    assert [c["t0"] for c in body["columns"]] == [2 * DT_NS]
    # And the reverse insertion order picks the same session.
    app.state.manager._sessions.clear()
    app.state.manager._sessions[("sim", "SIM-DUAL", "live", "crypcodile", "0")] = s_named
    app.state.manager._sessions[("sim", "SIM-DUAL", "live", None, "0")] = s_none
    r2 = await client.get("/api/export", params={"format": "json", "columns": 1})
    assert r2.status_code == 200
    assert json.loads(r2.text)["columns"][0]["t0"] == 2 * DT_NS


async def test_hostile_symbol_cannot_break_headers_or_inject_csv_rows(app, client):
    """Regression: the session key holds the RAW Subscribe symbol (subscribe
    refuses only "."/".."), so a symbol carrying a quote, a comma or CR/LF
    used to reach ``content-disposition`` (h11 refuses CR/LF header values ->
    500) and the CSV comment line (an embedded newline would forge data
    rows). The export must stay well-formed: one comment line, then the
    header, then data rows; header values free of control characters."""
    evil = 'EV"IL,SYM\r\nB0'
    _attach(app, evil, n_cols=2)
    r = await client.get("/api/export", params={"format": "csv", "columns": 2})
    assert r.status_code == 200
    disposition = r.headers["content-disposition"]
    # The filename attribute is a single clean token: no CR/LF (h11 refuses
    # those header values outright), no stray quote breaking the attribute.
    assert re.fullmatch(
        r'attachment; filename="export-[A-Za-z0-9._-]+\.csv"', disposition
    )
    lines = r.text.splitlines()
    # Comment line, header row, then exactly `columns` data rows — nothing
    # the symbol text injected may add or split lines.
    assert lines[0].startswith("# symbol=")
    assert lines[1].startswith("t0_ns,")
    assert len(lines) == 4
    assert "EV_IL_SYM_B0" in lines[0]
    assert "\r" not in r.text.split("\n")[0]


async def test_oversized_export_is_refused_before_any_column_is_copied(app, monkeypatch):
    # The size refusal happens before any requested column is copied.
    _attach(app, "AAA", n_cols=5)
    monkeypatch.setattr(export_mod, "EXPORT_MAX_BYTES", 100)
    copies = []
    real_history = Grid.history

    def counting_history(self, *args, **kwargs):
        copies.append(args)
        return real_history(self, *args, **kwargs)

    monkeypatch.setattr(Grid, "history", counting_history)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1:8720") as client:
        response = await client.get("/api/export", params={"symbol": "AAA", "columns": 5})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "export_too_large"
    assert "export too large" in response.json()["error"]["message"]
    # _pick_session probes one newest column per session; no window copy at all.
    assert [args for args in copies if args[1] > 1] == []


async def test_export_body_is_one_consistent_snapshot(app):
    # The body is built from copies taken on the loop: its header count, its
    # row count and the grid's own column count agree.
    _attach(app, "AAA", n_cols=6)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1:8720") as client:
        response = await client.get("/api/export", params={"symbol": "AAA", "columns": 4})
    assert response.status_code == 200
    lines = response.text.strip().splitlines()
    assert "columns=4" in lines[0]
    assert len(lines) == 2 + 4  # comment, header, one row per column


async def test_synth_profile_export_keeps_the_grid_ask_instead_of_failing(app, client):
    # A SYNTH_PROFILE grid drops ask on the wire (to_depth returns ask=None).
    # The export used to call .tolist() on that None and answer 500.
    _attach(app, "SYN", n_cols=3, grid_mode=events.MODE_SYNTH_PROFILE)
    response = await client.get("/api/export", params={"symbol": "SYN", "columns": 3, "format": "json"})
    assert response.status_code == 200
    columns = response.json()["columns"]
    assert len(columns) == 3
    assert all(len(col["asks"]) == ROWS and len(col["bids"]) == ROWS for col in columns)
    csv_response = await client.get("/api/export", params={"symbol": "SYN", "columns": 3})
    assert csv_response.status_code == 200
    assert len(csv_response.text.strip().splitlines()) == 2 + 3
