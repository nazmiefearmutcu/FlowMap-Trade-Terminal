"""Codec and scope updates for a recording's provider capability metadata."""

from __future__ import annotations
import json
from typing import TYPE_CHECKING
from flowmap_server.proto.events import EpochParams

if TYPE_CHECKING:
    from flowmap_server.core.record import SessionRecorder


def _decode_capability(raw: str | None) -> dict[str, object] | None:
    """The capability a recording run stored on its epoch rows, if readable."""
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None  # not JSON: there is no capability to report
    return value if isinstance(value, dict) else None


def update_recorded_capability(
    writer: SessionRecorder, capability: dict[str, object], params: EpochParams
) -> None:
    """Persist a newly established live CVD scope with its exact baseline.

    The repeated geometry is identical; its latest capability supersedes
    the initial connecting/unknown descriptor when this run is replayed.
    """
    writer._check_open()
    encoded = json.dumps(capability, sort_keys=True)
    if encoded != writer._capability_json:
        writer._capability_json = encoded
        writer.record_epoch(params)
