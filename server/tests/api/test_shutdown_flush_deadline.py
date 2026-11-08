"""The shutdown flush is bounded, and an overrun is logged rather than silent.

The desktop shell force-kills the sidecar once its grace period ends. A flush
that runs past the server's own bound would then be cut off with no trace, so
the lifespan returns at the bound and logs the expiry.
"""

from __future__ import annotations

import asyncio
import logging

from flowmap_server.api import app as app_mod
from flowmap_server.config import Config


class _HungManager:
    """A session manager whose final flush never finishes."""

    async def flush_all(self) -> None:
        await asyncio.Event().wait()


class _QuietCache:
    """A market cache with no background work, so the lifespan starts nothing."""


async def test_hung_shutdown_flush_returns_at_its_bound_and_is_logged(monkeypatch, caplog):
    monkeypatch.setattr(app_mod, "SHUTDOWN_FLUSH_DEADLINE_S", 0.05)
    application = app_mod.create_app(Config(), manager=_HungManager(), market_cache=_QuietCache())
    caplog.set_level(logging.ERROR, logger="flowmap_server.api.app")
    async with application.router.lifespan_context(application):
        pass
    assert any("shutdown flush did not finish" in r.getMessage() for r in caplog.records)


def test_shutdown_deadline_exceeds_the_recording_drain_bound():
    from flowmap_server.core.session_common import _REC_DRAIN_TIMEOUT_S, SHUTDOWN_FLUSH_DEADLINE_S

    assert SHUTDOWN_FLUSH_DEADLINE_S > _REC_DRAIN_TIMEOUT_S

