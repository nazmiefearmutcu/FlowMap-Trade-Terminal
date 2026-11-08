"""Unit tests for the phase helpers that Recorder.load_tail is built from."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import polars as pl

from flowmap_server.core.record import _latest_run, _load_events, _verified_chain_epoch
from flowmap_server.proto.events import EpochParams

DT_NS = 250_000_000


def _part(rows: list[tuple[int, str, int]], part: int = 1) -> pl.DataFrame:
    """Rows of (t0_ns, recording_id, col_seq) tagged with one part number."""
    return pl.DataFrame(
        {
            "t0_ns": [t0 for t0, _, _ in rows],
            "_part": [part] * len(rows),
            "recording_id": [rid for _, rid, _ in rows],
            "col_seq": [seq for _, _, seq in rows],
            "epoch": [0] * len(rows),
        }
    )


def test_latest_run_keeps_only_the_newest_recording_run() -> None:
    old = _part([(0, "old", 1), (DT_NS, "old", 2), (2 * DT_NS, "old", 3)], part=1)
    new = _part([(3 * DT_NS, "new", 1), (4 * DT_NS, "new", 2)], part=2)

    table, recording_id, truncated = _latest_run([old, new], scan_capped=False, limit_cols=10)

    assert recording_id == "new"
    assert table["col_seq"].to_list() == [1, 2]
    assert truncated is True  # older rows exist that this run does not serve


def test_latest_run_starts_after_a_sequence_reset() -> None:
    frames = [_part([(i * DT_NS, "r", seq) for i, seq in enumerate([1, 2, 3, 1, 2])])]

    table, recording_id, truncated = _latest_run(frames, scan_capped=False, limit_cols=10)

    assert recording_id == "r"
    assert table["col_seq"].to_list() == [1, 2]
    assert table["t0_ns"].to_list() == [3 * DT_NS, 4 * DT_NS]
    assert truncated is True


def test_latest_run_caps_to_the_newest_columns_and_flags_truncation() -> None:
    frames = [_part([(i * DT_NS, "r", i + 1) for i in range(5)])]

    table, _, truncated = _latest_run(frames, scan_capped=False, limit_cols=3)

    assert table["col_seq"].to_list() == [3, 4, 5]
    assert truncated is True


def test_load_events_without_events_reads_nothing(tmp_path: Path) -> None:
    epoch = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=100.0, rows=8)
    columns = [SimpleNamespace(t0_ns=0, epoch=0), SimpleNamespace(t0_ns=DT_NS, epoch=0)]

    got = _load_events(
        tmp_path,
        columns=columns,  # type: ignore[arg-type]
        epoch_map={0: epoch},
        upper=None,
        recording_id="r",
        include_events=False,
    )

    assert got == ([], False, [], False)


def test_verified_chain_epoch_needs_a_later_epoch_entry() -> None:
    assert _verified_chain_epoch({}, [], 1, 0, []) is None
