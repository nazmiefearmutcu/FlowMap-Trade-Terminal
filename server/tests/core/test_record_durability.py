"""Recording durability and path safety.

Covers the NTFS-safe symbol directory names, malformed hour buckets that used
to crash the inventory, the bounded per-session buffers, the fsync-before-rename
write, mixed-schema tail reads, derived-cache accounting and stale temp files.
"""

from __future__ import annotations

import os

import polars as pl
import pytest

from flowmap_server.core import record
from flowmap_server.core.record import Recorder, _bounded_rows, _is_hour_key, _safe_component
from flowmap_server.proto.events import Marker, Trade


def _trade(ts_ns: int) -> Trade:
    return Trade(ts_ns=ts_ns, price=100.0, size=1.0, side=1, side_src=1, venue="x")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("BTC/USDC:USDC", "BTC_USDC_USDC"),  # documented ccxt spellings keep recording
        ("ETH/BTC", "ETH_BTC"),
        ("BTC*/USD?", "BTC__USD_"),
        ('a"b<c>d|e', "a_b_c_d_e"),
        ("CON", "_CON"),
        ("nul.txt", "_nul.txt"),
        ("COM1", "_COM1"),
        ("A. ", "A"),
        ("...", "_"),
        ("tab\tnew", "tab_new"),
    ],
)
def test_symbol_directory_names_are_ntfs_safe(raw, expected):
    assert _safe_component(raw) == expected


def test_dot_and_dotdot_are_still_refused():
    for name in (".", ".."):
        with pytest.raises(ValueError):
            _safe_component(name)


def test_hour_buckets_must_be_real_calendar_hours():
    assert _is_hour_key("20240101-05")
    assert not _is_hour_key("20269999-99")  # right shape, not a time
    assert not _is_hour_key("2024010-105")


def test_inventory_skips_stray_hour_like_names_instead_of_crashing(tmp_path):
    root = Recorder(tmp_path, 1.0)
    symbol_dir = tmp_path / "sim" / "SIM"
    symbol_dir.mkdir(parents=True)
    (symbol_dir / "20240101-05-columns-000001.parquet").write_bytes(b"x" * 10)
    (symbol_dir / "20269999-99-columns-000002.parquet").write_bytes(b"x" * 10)
    rows = root.inventory()  # used to raise ValueError from strptime
    assert rows and rows[0]["parts"] == 2
    assert rows[0]["first_ts_ns"] is not None
    availability = root.availability("sim", "SIM")
    assert len(availability["hours"]) == 1  # only the real hour bucket


def test_buffer_overflow_drops_oldest_rows_and_leaves_a_gap_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(record, "_BUFFER_MAX_TRADES", 16)
    root = Recorder(tmp_path, 1.0)
    writer = root.open_session("sim", "SIM")
    for ts in range(1, 41):
        writer.record_trade(_trade(ts))
    assert len(writer._trades) <= 16
    assert writer.dropped_rows["trades"] >= 8
    gaps = [m for m in writer._markers if isinstance(m, Marker) and m.kind == "gap"]
    assert gaps and "trades rows dropped" in gaps[0].text
    # The newest rows are the ones kept.
    assert writer._trades[-1].ts_ns == 40


def test_part_rename_is_fsynced_before_and_after(tmp_path, monkeypatch):
    tmp = tmp_path / "part.parquet.tmp"
    final = tmp_path / "part.parquet"
    tmp.write_bytes(b"payload")
    synced = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real_fsync(fd)))
    record._durable_replace(tmp, final)
    assert final.read_bytes() == b"payload" and not tmp.exists()
    if os.name != "nt":  # NTFS journals renames: only the file itself is synced
        assert len(synced) == 2  # the temp file, then the directory


def test_mixed_legacy_and_new_schema_parts_read_at_the_cap(tmp_path):
    legacy = tmp_path / "20240101-00-trades-000001.parquet"
    current = tmp_path / "20240101-00-trades-000002.parquet"
    pl.DataFrame({"ts_ns": [1, 2], "price": [1.0, 2.0]}).write_parquet(legacy)
    pl.DataFrame({"ts_ns": [3, 4], "price": [3.0, 4.0], "recording_id": ["r", "r"]}).write_parquet(current)
    rows, truncated = _bounded_rows(
        tmp_path, "*-trades-*.parquet", "00000000-00", "99999999-99",
        pl.col("ts_ns") >= 0, limit=2,
    )
    assert truncated is True
    assert [row["ts_ns"] for row in rows] == [3, 4]  # the newest two, no schema error


def test_derived_pyramid_bytes_are_counted_against_the_budget(tmp_path):
    root = Recorder(tmp_path, 1.0)
    namespace = tmp_path / "sim" / "SIM" / ".flowmap-pyramid" / ("ab" * 16)
    namespace.mkdir(parents=True)
    (namespace / ("cd" * 32 + ".bin")).write_bytes(b"x" * 1234)
    directories, derived_bytes = root._derived_cache_usage()
    assert derived_bytes == 1234
    assert directories == [tmp_path / "sim" / "SIM"]


def test_stale_temp_parts_from_a_crash_are_swept_at_boot(tmp_path):
    stale = tmp_path / "sim" / "SIM" / "20240101-00-columns-000001.parquet.tmp"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"torn")
    # Atomic JSON and derived-cache writers leave <name>.<hex>.tmp behind too.
    retention_tmp = tmp_path / f".flowmap-retention.json.{'ab' * 16}.tmp"
    retention_tmp.write_bytes(b"torn")
    pyramid_tmp = tmp_path / "sim" / "SIM" / ".flowmap-pyramid" / "ns" / f"manifest.json.{'cd' * 16}.tmp"
    pyramid_tmp.parent.mkdir(parents=True)
    pyramid_tmp.write_bytes(b"torn")
    # Something that is not this recorder's temp file must survive the sweep.
    foreign = tmp_path / "warehouse.duckdb.tmp" / "duckdb_temp_storage.tmp"
    foreign.parent.mkdir()
    foreign.write_bytes(b"spill")
    Recorder(tmp_path, 1.0)
    assert not stale.exists()
    assert not retention_tmp.exists()
    assert not pyramid_tmp.exists()
    assert foreign.exists()
