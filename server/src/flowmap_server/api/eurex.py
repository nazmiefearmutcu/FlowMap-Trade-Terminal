"""Local authenticated audit history, status and explicit bounded source refresh.

History and status read the local archive only. Refresh runs one bounded pass against the
source and starts no background collection (that runs while a chart is open).
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Request

from flowmap_server.api.errors import ApiError
from flowmap_server.feeds.eurex_service import EurexService, audited_json, contract_for

router = APIRouter(prefix='/api/eurex')


def _ns(value: str | None, name: str) -> int | None:
    if value is None:
        return None
    if not value.isascii() or not value.isdecimal() or len(value) > 19 or int(value) > 2**63 - 1:
        raise ApiError(422, 'invalid_params', f'{name} must be UTC epoch nanoseconds')
    return int(value)


def _service(request: Request) -> EurexService:
    return request.app.state.eurex_service


@router.get('/history')
async def history(request: Request, symbol: str, start_ns: str | None = None,
                  end_ns: str | None = None, cursor: str | None = None,
                  limit: int = Query(500, ge=1, le=1000)) -> dict[str, object]:
    try:
        contract_for(symbol)
    except ValueError as exc:
        raise ApiError(422, 'invalid_symbol', str(exc)) from None
    start, end, after = _ns(start_ns, 'start_ns'), _ns(end_ns, 'end_ns'), _ns(cursor, 'cursor')
    if start is not None and end is not None and start >= end:
        raise ApiError(422, 'invalid_params', 'start_ns must precede end_ns')
    if after is not None:
        start = max(start or 0, after)
    service = _service(request)
    page = await service.history(symbol, start_ns=start, end_ns=end, limit=limit + 1)
    bars = page[:limit]
    next_cursor = str(bars[-1].minute_start_ns + 60_000_000_000) if len(page) > limit else None
    return {'symbol': symbol, 'bars': audited_json(bars), 'next_cursor': next_cursor,
            'state': audited_json(service.status()),
            'issues': [{'minute_start_ns': str(b.minute_start_ns), 'reasons': list(b.quality_reasons),
                        'excluded_count': b.excluded_count} for b in bars if b.quality == 'incomplete']}


@router.get('/status')
async def status(request: Request) -> dict[str, object]:
    service = _service(request)
    await service.open()
    return audited_json(service.status())


@router.post('/refresh')
async def refresh(request: Request, max_files: int = Query(4, ge=0, le=100)) -> dict[str, object]:
    return audited_json(await _service(request).refresh(max_files=max_files))
