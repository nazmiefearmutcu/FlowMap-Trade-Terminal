"""Recording fixes: newest-N tail read, orphan claims, temp bytes."""

import os
import time
from pathlib import Path

import polars as pl

from flowmap_server.core import record
from flowmap_server.core.record import Recorder, _bounded_rows

HOUR = "20240101-00"


def _write_trades(d: Path, part: int, stamps: list[int]) -> None:
    d.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({"ts_ns": stamps, "price": [float(s) for s in stamps]}).write_parquet(
        d / f"{HOUR}-trades-{part:06d}.parquet"
    )


def _rows(gen) -> list[int]:
    return [int(row["ts_ns"]) for row in gen]


def test_tail_read_returns_newest_rows_across_parts_and_flags_truncation(tmp_path):
    d = tmp_path / "sim" / "SIM"
    # Five parts, time-ordered by part number; four rows each.
    for part in range(5):
        _write_trades(d, part, [part * 10 + k for k in range(4)])
    rows, truncated = _bounded_rows(d, "*-trades-*.parquet", "00000000-00", "99999999-99",
                                    pl.col("ts_ns") >= 0, limit=6)
    # The newest six overall, across part boundaries, oldest first.
    expected = sorted(p * 10 + k for p in range(5) for k in range(4))[-6:]
    assert truncated is True
    assert _rows(rows) == expected


def test_tail_read_below_the_cap_returns_everything_untruncated(tmp_path):
    d = tmp_path / "sim" / "SIM"
    _write_trades(d, 0, [1, 2])
    _write_trades(d, 1, [3])
    rows, truncated = _bounded_rows(d, "*-trades-*.parquet", "00000000-00", "99999999-99",
                                    pl.col("ts_ns") >= 0, limit=10)
    assert truncated is False
    assert sorted(_rows(rows)) == [1, 2, 3]


def test_tail_read_applies_the_range_filter_before_capping(tmp_path):
    d = tmp_path / "sim" / "SIM"
    for part in range(3):
        _write_trades(d, part, [part * 10 + k for k in range(4)])
    rows, truncated = _bounded_rows(d, "*-trades-*.parquet", "00000000-00", "99999999-99",
                                    pl.col("ts_ns") < 15, limit=3)
    assert truncated is True
    assert sorted(_rows(rows)) == [11, 12, 13]


def test_boot_sweep_reclaims_only_old_orphaned_claims(tmp_path):
    sym = tmp_path / "sim" / "SIM"
    sym.mkdir(parents=True)
    old = sym / ".claim-000001"
    fresh = sym / ".claim-000002"
    old.write_bytes(b"")
    fresh.write_bytes(b"")
    two_days_ago = time.time() - 2 * 24 * 3600
    os.utime(old, (two_days_ago, two_days_ago))
    Recorder(tmp_path, 1.0)
    assert not old.exists()
    assert fresh.exists(), "a claim of a live writer must survive the sweep"


def test_in_flight_temp_parts_count_toward_the_retention_budget(tmp_path):
    root = Recorder(tmp_path, 1.0)
    d = tmp_path / "sim" / "SIM"
    d.mkdir(parents=True)
    part = d / f"{HOUR}-trades-000001.parquet"
    part.write_bytes(b"x" * 100)
    # Written after boot: the boot sweep would otherwise remove it.
    (d / f"{HOUR}-trades-000002.parquet.tmp").write_bytes(b"y" * 5000)
    assert root._temp_part_bytes() == 5000
    root._cap_bytes = 1000  # 100 retained bytes alone fit; 5100 with the temp part does not
    pruned = root.enforce_retention()
    assert part in pruned
    assert (d / f"{HOUR}-trades-000002.parquet.tmp").exists(), "temp parts are counted, not deleted"


def test_temp_parts_alone_under_the_cap_delete_nothing(tmp_path):
    root = Recorder(tmp_path, 1.0)
    d = tmp_path / "sim" / "SIM"
    d.mkdir(parents=True)
    part = d / f"{HOUR}-trades-000001.parquet"
    part.write_bytes(b"x" * 100)
    (d / f"{HOUR}-trades-000002.parquet.tmp").write_bytes(b"y" * 50)
    root._cap_bytes = 1000
    assert root.enforce_retention() == []
    assert part.exists()


def test_record_module_exposes_the_orphan_age_constant():
    assert record._ORPHAN_CLAIM_AGE_S >= 3600


def test_epoch_parts_are_parsed_once_until_the_file_changes(tmp_path):
    part = tmp_path / f"{HOUR}-epochs-000001.parquet"
    pl.DataFrame({"epoch": [1]}).write_parquet(part)
    first = record._read_epoch_part(part)
    assert first is not None and first["epoch"].to_list() == [1]
    assert record._read_epoch_part(part) is first  # re-read on every request was the cost
    # Replaced content (new size/mtime) is never served from the stale parse.
    pl.DataFrame({"epoch": [1, 2, 3]}).write_parquet(part)
    os.utime(part, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
    assert record._read_epoch_part(part)["epoch"].to_list() == [1, 2, 3]
    part.unlink()
    assert record._read_epoch_part(part) is None
