"""Macro REST route: SOFR, the 10y-2y Treasury spread and the high-yield spread.

The service lives on ``app.state.macro``. It is created on the first request when
nothing was wired, so a test can seed it with fake fetchers. The client never calls
the public sources itself; it reads this route.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from flowmap_server.api.errors import ApiError
from flowmap_server.data.macro_public import MacroPublicService, MacroReading, MacroUnavailable

__all__ = ["router"]

router = APIRouter(prefix="/api")


def _service(request: Request) -> MacroPublicService:
    service = getattr(request.app.state, "macro", None)
    if not isinstance(service, MacroPublicService):
        service = MacroPublicService()
        request.app.state.macro = service
    return service


def _reading_json(reading: MacroReading) -> dict[str, object]:
    return {
        "sofr": reading.sofr,
        "sofrDate": reading.sofr_date,
        "yield10y2y": reading.yield_10y2y,
        "curveDate": reading.curve_date,
        "hySpread": reading.hy_spread,
        "hyDate": reading.hy_date,
        "stressScore": reading.stress_score,
        "status": reading.status,
        "sourceStatus": dict(reading.source_status),
        "sources": dict(reading.sources),
        "asOf": reading.as_of_ns // 1_000_000,
        "stale": reading.stale,
    }


@router.get("/macro")
async def macro(request: Request) -> dict[str, object]:
    """The latest macro readings, each with its source status and observation date."""
    try:
        reading = await _service(request).get()
    except MacroUnavailable as exc:
        raise ApiError(503, "macro_unavailable", str(exc)) from None
    return _reading_json(reading)
