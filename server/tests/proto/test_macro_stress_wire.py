"""MacroStressUpdate carries its observation dates and per-source status.

The macro panel must show when each reading was observed, and which sources
have no reading, so the wire message has to carry both. The message is a cold
JSON frame: the two fields default to empty so an older producer still encodes.
"""

from __future__ import annotations

import msgspec

from flowmap_server.proto import events, wire


def _update(**extra) -> events.MacroStressUpdate:
    return events.MacroStressUpdate(
        ts_ns=1_700_000_000_000_000_000,
        sofr=5.3,
        hy_spread=3.1,
        yield_10y2y=0.2,
        stress_score=0.4,
        status="ok",
        **extra,
    )


def test_observation_dates_and_source_status_survive_the_wire() -> None:
    update = _update(
        as_of={"SOFR": "2026-11-05", "BAMLH0A0HYM2": "2026-11-04"},
        source_status={"SOFR": "ok", "BAMLH0A0HYM2": "ok", "T10Y2Y": "fred_no_observation"},
    )
    decoded, end = wire.decode(wire.encode(update), 0)
    assert isinstance(decoded, events.MacroStressUpdate)
    assert decoded.as_of == {"SOFR": "2026-11-05", "BAMLH0A0HYM2": "2026-11-04"}
    assert decoded.source_status["T10Y2Y"] == "fred_no_observation"
    assert end == len(wire.encode(update))


def test_fields_default_to_empty_for_an_older_producer() -> None:
    legacy = msgspec.json.encode(
        {"ts_ns": 1, "sofr": 1.0, "hy_spread": 1.0, "yield_10y2y": 1.0,
         "stress_score": 1.0, "status": "ok"}
    )
    decoded = msgspec.json.decode(legacy, type=events.MacroStressUpdate)
    assert decoded.as_of == {} and decoded.source_status == {}
