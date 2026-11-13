"""Market map REST route: the largest US stocks and coins, for the map screen.

The service lives on ``app.state.market_map``. It is created on the first
request when nothing was wired, so a test can seed it with fake fetchers. The
client never calls the third-party sources itself; it reads this route.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from flowmap_server.api.errors import ApiError
from flowmap_server.data.market_map import (
    MapItem,
    MarketMap,
    MarketMapService,
    MarketMapUnavailable,
)

__all__ = ["router"]

router = APIRouter(prefix="/api")

_MARKETS = frozenset({"us", "crypto"})


def _service(request: Request) -> MarketMapService:
    service = getattr(request.app.state, "market_map", None)
    if not isinstance(service, MarketMapService):
        service = MarketMapService()
        request.app.state.market_map = service
    return service


def _item_json(item: MapItem) -> dict[str, object]:
    return {
        "symbol": item.symbol,
        "name": item.name,
        "group": item.group,
        "marketCap": item.market_cap,
        "price": item.price,
        "change": dict(item.change),
        "volume": item.volume,
        "chart": dict(item.chart) if item.chart is not None else None,
    }


def _answer_json(answer: MarketMap) -> dict[str, object]:
    return {
        "market": answer.market,
        "asOf": answer.as_of_ns // 1_000_000,
        "source": answer.source,
        "stale": answer.stale,
        "items": [_item_json(item) for item in answer.items],
    }


@router.get("/market-map")
async def market_map(request: Request, market: str = "us") -> dict[str, object]:
    """Tiles for one market: ``us`` (largest stocks) or ``crypto`` (largest coins)."""
    if market not in _MARKETS:
        raise ApiError(
            422, "unknown_market",
            f"market must be one of {sorted(_MARKETS)}; got {market[:80]!r}",
        )
    try:
        answer = await _service(request).get(market)
    except MarketMapUnavailable as exc:
        raise ApiError(503, "market_map_unavailable", str(exc)) from None
    return _answer_json(answer)
