"""Recording stalled flag and staleness cleanup in SessionStats.

- an open recorder on a quiet symbol is healthy while its cadence
  reports an idle writer; only a silent writer reads as stalled.
- leaving the table drops the session's recording entry.
"""

from __future__ import annotations

from flowmap_server.core.stats import SessionStats

SEC = 10**9


def _stats(clock: list[int]) -> SessionStats:
    return SessionStats(wall_clock=lambda: clock[0])


def test_idle_writer_with_heartbeats_is_not_reported_stalled():
    clock = [0]
    stats = _stats(clock)
    stats.note_recording("quiet", True)
    for t in range(0, 200, 10):  # a quiet symbol: cadence sees nothing to write
        clock[0] = t * SEC
        stats.note_recording_idle("quiet")
        assert stats.snapshot()["recording"]["stalled"] is False
    # Heartbeats stop: only now has the writer been silent for over a minute.
    clock[0] = 200 * SEC + 61 * SEC
    assert stats.snapshot()["recording"]["stalled"] is True


def test_silent_writer_without_heartbeat_is_reported_stalled():
    clock = [0]
    stats = _stats(clock)
    stats.note_recording("wedged", True)
    stats.note_flush("wedged")
    clock[0] = 59 * SEC
    assert stats.snapshot()["recording"]["stalled"] is False
    clock[0] = 61 * SEC
    assert stats.snapshot()["recording"]["stalled"] is True


def test_idle_neighbour_does_not_mask_a_wedged_writer():
    # Heartbeats are per session: a healthy quiet symbol must not hide a
    # writer that stopped making progress on another symbol.
    clock = [0]
    stats = _stats(clock)
    stats.note_recording("wedged", True)
    stats.note_recording("quiet", True)
    stats.note_flush("wedged")
    for t in range(0, 120, 10):
        clock[0] = t * SEC
        stats.note_recording_idle("quiet")
    clock[0] = 61 * SEC
    assert stats.snapshot()["recording"]["stalled"] is True


def test_writer_that_never_flushes_or_heartbeats_is_reported_stalled():
    clock = [0]
    stats = _stats(clock)
    stats.note_recording("never", True)
    clock[0] = 59 * SEC
    assert stats.snapshot()["recording"]["stalled"] is False
    clock[0] = 61 * SEC
    assert stats.snapshot()["recording"]["stalled"] is True


def test_forgetting_a_session_clears_its_recording_entry():
    clock = [0]
    stats = _stats(clock)
    stats.note_session("gone")
    stats.note_recording("gone", True)
    assert stats.snapshot()["recording"]["enabled"] is True
    stats.forget_session("gone")
    assert stats.snapshot()["recording"]["enabled"] is False
    assert "gone" not in stats.snapshot()["staleness_ms"]
