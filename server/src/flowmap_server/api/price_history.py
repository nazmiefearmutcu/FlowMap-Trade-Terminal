"""Exchange closes for gaps in the live Binance Spot chart."""

from __future__ import annotations

import logging
import math
import re
import ssl
import time
from functools import lru_cache
from typing import Annotated

import aiohttp
import certifi
from fastapi import APIRouter, Query

from flowmap_server.api.errors import ApiError

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)
_INTERVALS = (
    ("1s", 1_000), ("1m", 60_000), ("3m", 180_000), ("5m", 300_000),
    ("15m", 900_000), ("1h", 3_600_000), ("4h", 14_400_000), ("1d", 86_400_000),
)
_LIMIT = 1_000
_KLINES_URL = "https://api.binance.com/api/v3/klines"


@lru_cache(maxsize=1)
def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _closes(rows: list, step: int, start: int, end: int) -> list[tuple[int, float]]:
    points = {}
    for row in rows:
        try:
            close_ms, price = int(row[6]), float(row[4])
        except (IndexError, TypeError, ValueError):
            continue
        if start < close_ms < end and (close_ms + 1) % step == 0 and math.isfinite(price) and price > 0:
            points[close_ms] = price
    return sorted(points.items())


@router.get("/price-history/{symbol}")
async def price_history(
    symbol: str,
    start_ms: Annotated[int, Query(ge=0)],
    end_ms: Annotated[int, Query(ge=0)],
) -> dict[str, object]:
    if re.fullmatch(r"[A-Z0-9]{4,24}", symbol) is None:
        raise ApiError(400, "bad_symbol", "Expected a Binance Spot symbol.")
    end = min(end_ms, time.time_ns() // 1_000_000)
    if end <= start_ms:
        return {"step_ms": 0, "points": []}
    params: dict[str, str | int] | None = None
    for interval, step in _INTERVALS:
        first_open = start_ms // step * step
        count = (end - first_open + step - 1) // step
        if count <= _LIMIT:
            params = {
                "symbol": symbol,
                "interval": interval,
                "startTime": first_open,
                "endTime": end - 1,
                "limit": count,
            }
            break
    if params is None:
        raise ApiError(400, "range_too_wide", "Price history range exceeds the supported window.")

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as client:
            async with client.get(_KLINES_URL, params=params, ssl=_ssl_context()) as response:
                response.raise_for_status()
                rows = await response.json()
        if not isinstance(rows, list):
            raise ValueError("Unexpected kline response")
    except (aiohttp.ClientError, TimeoutError, ValueError):
        raise ApiError(502, "price_history_unavailable", "Binance price history is unavailable.") from None
    points = _closes(rows, step, start_ms, end)
    logger.debug("Binance Spot price history: %s %d..%d returned %d closes", symbol, start_ms, end, len(points))
    return {"step_ms": step, "points": points}
