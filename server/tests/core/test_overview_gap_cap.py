"""Gap seams are never dropped; MAX_GAP_MARKERS is an alarm threshold.

A cap on emitted seams would present a real discontinuity as continuous history,
which the client labels from these markers. So every seam is emitted, and only
the count above the documented bound is logged, once per builder.
"""

import json
import logging

from flowmap_server.core import overview
from flowmap_server.core.overview import GAP_MARKER_PREFIX, OverviewBuilder, OverviewCache, _Gap
from flowmap_server.proto.events import EpochParams

TARGET = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=10**9, p0=90.0, rows=64)


def _builder() -> OverviewBuilder:
    return OverviewBuilder(TARGET, 0, 10**6, 1, 10**6, 10**6, OverviewCache())


def _seams(builder: OverviewBuilder, count: int) -> None:
    for index in range(count):
        builder._gaps[(index, index + 1)] = _Gap(
            index, index + 1, index * 100, index * 100 + 10, index * 100 + 50
        )


def test_every_seam_is_emitted_above_the_alarm_threshold(monkeypatch, caplog):
    monkeypatch.setattr(overview, "MAX_GAP_MARKERS", 4)
    builder = _builder()
    _seams(builder, 10)
    with caplog.at_level(logging.WARNING, logger=overview.logger.name):
        markers = builder.gap_markers()
        builder.gap_markers()  # a second read must not repeat the alarm
    assert len(markers) == 10
    right_times = [m.ts_ns for m in markers]
    assert right_times == sorted(right_times)
    payload = json.loads(markers[0].text[len(GAP_MARKER_PREFIX):])
    assert payload["left_col"] == 0 and payload["right_col"] == 1
    alarms = [r for r in caplog.records if "gap seams" in r.getMessage()]
    assert len(alarms) == 1


def test_no_alarm_below_the_threshold(monkeypatch, caplog):
    monkeypatch.setattr(overview, "MAX_GAP_MARKERS", 4)
    builder = _builder()
    _seams(builder, 3)
    with caplog.at_level(logging.WARNING, logger=overview.logger.name):
        assert len(builder.gap_markers()) == 3
    assert not [r for r in caplog.records if "gap seams" in r.getMessage()]


def test_documented_threshold_value():
    assert overview.MAX_GAP_MARKERS == 1024
    assert not hasattr(overview, "MAX_COARSE_RANGES")
