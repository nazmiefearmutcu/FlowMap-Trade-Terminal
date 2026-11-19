"""Apply a provider CVD scope without rewriting cumulative recorded bars."""

from __future__ import annotations
from typing import TYPE_CHECKING
from flowmap_server.core.session_capability import recorded_capability
from flowmap_server.feeds.base import CvdAnchor

if TYPE_CHECKING:
    from flowmap_server.core.record import SessionRecorder
    from flowmap_server.core.session_core import Session


def apply_cvd_anchor(session: Session, ev: CvdAnchor) -> None:
    # Reconnects and queue loss cannot silently extend an incomplete
    # CVD. Keep stored cumulative bars intact; the client displays
    # only this scope, subtracting its exact pre-trade baseline.
    if ev.available:
        session._feed.capability.update(
            cvd_anchor_ns=str(ev.ts_ns),
            cvd_offset=session._grid.cvd_cumulative,
        )
        session._feed.capability.pop("cvd_end_ns", None)
    else:
        session._feed.capability["cvd_end_ns"] = str(ev.ts_ns)
    capability = recorded_capability(session._feed.capability)
    if not ev.available and "cvd_anchor_ns" in capability:
        # A replay can still show the last verified scope, bounded
        # by its explicit end, even when the live source went away.
        capability.update(cvd="provider", trade_side="provider")
    epoch = session._grid.current_epoch_params()
    def update_writer(writer: SessionRecorder) -> None:
        writer.update_capability(capability, epoch)

    session._record(update_writer)
    session._next_capability_status_ns = 0
    session._publish_capability_status()
