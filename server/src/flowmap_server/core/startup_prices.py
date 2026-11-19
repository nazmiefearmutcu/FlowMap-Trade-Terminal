"""Restore published prices in downtime without restoring fictitious depth."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

import msgspec
import numpy as np

from flowmap_server.core.backfill import BackfillFn, Candle
from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.proto.events import Marker

logger = logging.getLogger(__name__)
MINUTE_NS = 60_000_000_000
_STARTUP_PRICE_TIMEOUT_S = 2.5
# Provider fetches can own cleanup work after cancellation. Keep them reachable
# until they stop and retrieve their exceptions, without blocking the snapshot.
_DRAINING: set[asyncio.Task[Sequence[Candle]]] = set()


def _finish(task: asyncio.Task[Sequence[Candle]]) -> None:
    _DRAINING.discard(task)
    if not task.cancelled():
        task.exception()


async def fetch_restart_prices(
    fetch: BackfillFn,
    market: str,
    symbol: str,
    *,
    after_ns: int,
    now_ns: int,
    limit: int,
) -> Sequence[Candle]:
    if limit <= 0 or ((after_ns + MINUTE_NS - 1) // MINUTE_NS + 1) * MINUTE_NS > now_ns:
        return ()
    count = min(limit, (now_ns - after_ns) // MINUTE_NS + 1)
    task = asyncio.create_task(_fetch(fetch, market, symbol, count, now_ns))
    try:
        done, _ = await asyncio.wait({task}, timeout=_STARTUP_PRICE_TIMEOUT_S)
        return task.result() if done else ()
    except Exception:
        logger.warning("restart prices unavailable for %s:%s", market, symbol, exc_info=True)
        return ()
    finally:
        if not task.done():
            task.cancel()
            _DRAINING.add(task)
            task.add_done_callback(_finish)


async def _fetch(
    fetch: BackfillFn, market: str, symbol: str, count: int, now_ns: int,
) -> Sequence[Candle]:
    return await fetch(market, symbol, max_cols=count, now_ns=now_ns)


def restart_price_columns(
    recorded: FinalizedColumn,
    candles: Sequence[Candle],
    *,
    dt_ns: int,
    now_ns: int,
    limit: int,
) -> list[FinalizedColumn]:
    """Keep only closed, non-overlapping minutes and preserve tape aggregates."""
    if limit <= 0:
        return []
    prices = {
        c.t0_ns: c for c in candles
        if c.t0_ns >= recorded.t0_ns + dt_ns
        and c.t0_ns + MINUTE_NS <= now_ns
        and c.t0_ns % dt_ns == 0
        and all(np.isfinite(x) and x > 0 for x in (c.o, c.h, c.l, c.c))
    }
    result: list[FinalizedColumn] = []
    empty = np.zeros(len(recorded.bid), dtype=np.float32)
    for t0_ns in sorted(prices)[-limit:]:
        c = prices[t0_ns]
        seq = recorded.col_seq + len(result) + 1
        bar = msgspec.structs.replace(
            recorded.bar, col_seq=seq, t0_ns=t0_ns, o=c.o, h=c.h, l=c.l, c=c.c,
            vol_buy=0.0, vol_sell=0.0,
        )
        result.append(FinalizedColumn(recorded.epoch, seq, t0_ns, empty, empty, bar))
    return result


def restart_price_marker(columns: list[FinalizedColumn]) -> Marker:
    return Marker(
        ts_ns=columns[-1].t0_ns, kind="gap",
        text="backfill: restart prices from 1m candles; no recorded order book",
    )
