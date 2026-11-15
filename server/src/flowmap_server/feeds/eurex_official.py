"""Official delayed candles: no tape, BBO, inferred side, scanner or order book."""
from __future__ import annotations

from collections.abc import AsyncIterator

from flowmap_server.feeds.base import FeedEvent
from flowmap_server.feeds.eurex_service import LABEL, MARKET, SYMBOLS, EurexService, audited_json, contract_for

__all__ = ['MARKET', 'LABEL', 'SYMBOLS', 'EurexService', 'EurexOfficialFeed', 'contract_for']


def capability() -> dict[str, object]:
    return {'depth': 'N/A', 'tape': 'none', 'trade_side': 'na', 'cvd': 'na',
            'source': 'eurex_delayed_posttrade', 'source_label': 'Eurex official',
            'input_origin': 'native', 'candle_origin': 'derived', 'declared_delay_s': 900,
            'data_quality': 'incomplete', 'market_status': 'unknown', 'session_status': 'unknown',
            'candle_interval_ns': 60_000_000_000, 'replay': False, 'native_candles': True,
            'real_order_book': False, 'density': 'none', 'timezone': 'Europe/Berlin',
            'option_chains': False}


class EurexOfficialFeed:
    market = MARKET
    native_candles = True

    def __init__(self, symbol: str, service: EurexService) -> None:
        self.symbol = contract_for(symbol).display_symbol
        self.service = service
        self.capability: dict[str, object] = {**capability(), **audited_json(service.status())}

    @property
    def feed_state(self) -> str:
        return 'degraded' if self.service.status()['status'] in ('error', 'backoff', 'storage_full') else 'live'

    async def native_snapshot(self):
        snapshot = await self.service.snapshot(self.symbol)
        self.capability = {**capability(), **audited_json(self.service.status())}
        return snapshot

    async def events(self) -> AsyncIterator[FeedEvent]:
        # The open chart is what keeps the collector downloading; closing it lets it stop.
        await self.service.acquire()
        try:
            while not self.service._closing:
                changed = self.service.changed
                yield await self.native_snapshot()
                await changed.wait()
        finally:
            self.service.release()
