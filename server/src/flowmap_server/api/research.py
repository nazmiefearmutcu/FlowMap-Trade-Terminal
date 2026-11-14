"""Research REST route: one drawer section for one symbol.

``GET /api/research/{market}/{section}?symbol=`` answers from
``app.state.research`` (created on the first request when nothing was wired, so
a test can seed it). A source failure is never an HTTP error: it is
``status: "unavailable"`` with a reason in the body. Only a request this route
cannot answer (unknown market or section, malformed symbol) is a 422.

The SEC sections need a contact e-mail (SEC's fair-access rule). The client sends
the one the user entered in the ``X-SEC-Contact`` header; it is used for
``sec.gov`` requests only and never logged.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, Request

from flowmap_server.api.errors import ApiError
from flowmap_server.research.base import SectionResult
from flowmap_server.research.service import ResearchService, UnknownSection, sec_contact

__all__ = ["router"]

router = APIRouter(prefix="/api")


def _service(request: Request) -> ResearchService:
    service = getattr(request.app.state, "research", None)
    if not isinstance(service, ResearchService):
        service = ResearchService(data_dir=getattr(request.app.state, "research_dir", None))
        request.app.state.research = service
    return service


def section_json(answer: SectionResult) -> dict[str, object]:
    return {
        "section": answer.section,
        "symbol": answer.symbol,
        "status": answer.status,
        "reason": answer.reason,
        "source": answer.source,
        "asOf": answer.as_of,
        "fetchedAt": answer.fetched_ns // 1_000_000,
        "stale": answer.stale,
        "data": answer.data,
    }


@router.get("/research/{market}/{section}")
async def research_section(
    request: Request,
    market: str,
    section: str,
    symbol: str = "",
    x_sec_contact: str | None = Header(default=None),
) -> dict[str, object]:
    """One Research section for one symbol (``market`` is ``us`` or ``crypto``)."""
    try:
        answer = await _service(request).get(
            market, section, symbol, contact=sec_contact(x_sec_contact)
        )
    except UnknownSection as exc:
        raise ApiError(422, "unknown_research_section", str(exc)) from None
    return section_json(answer)
