"""One lazy, app-owned official Eurex archive/collector shared by every graph.

Reading and collecting are separate. A quote, a status or a history request only opens the
local archive and reads it; it never contacts the source. The collector downloads from the
source only while a chart of the market is open (each ``EurexOfficialFeed.events()`` holds a
lease) and stops ``IDLE_S`` seconds after the last chart closes. ``POST /api/eurex/refresh``
runs one bounded pass on request and starts nothing.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, TypeVar

from crocodile.equity.universal.live.eurex_delayed import EurexDelayedSource
from crocodile.equity.universal.live.intraday_models import CONTRACTS, MINUTE_NS, SOURCE, BarEnvelope
from crocodile.equity.universal.live.intraday_store import IntradayStore

from flowmap_server.feeds.base import CandleSample, CandleSnapshot

MARKET = 'futures-eurex-official'
LABEL = 'Eurex (official, 15 min delayed)'
SYMBOLS = {c.display_symbol: c for c in CONTRACTS.values()}
IDLE_S = 120.0
"""How long the collector keeps running after the last open chart of the market closes."""
T = TypeVar('T')


class NativeSymbolError(ValueError):
    """The dated official catalogue explicitly does not support this symbol."""


def contract_for(symbol: str):
    try:
        return SYMBOLS[symbol]
    except KeyError:
        raise NativeSymbolError('Official Eurex supports only FDAXZ2026 and FGBLZ2026; continuous 1! aliases are unavailable') from None


def audited_json(value: Any) -> Any:
    """Exact Decimal and UTC nanosecond fields survive JavaScript JSON parsing."""
    if is_dataclass(value) and not isinstance(value, type):
        return audited_json(asdict(value))
    if isinstance(value, dict):
        return {k: str(v) if k.endswith('_ns') and v is not None else audited_json(v)
                for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [audited_json(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    return value


async def safe_worker(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Cancellation never releases a store lock while its SQLite worker still runs."""
    task = asyncio.create_task(asyncio.to_thread(fn, *args, **kwargs))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError:
            cancelled = True
            if task.done():
                result = task.result()
                break
    if cancelled:
        raise asyncio.CancelledError
    return result


class EurexService:
    def __init__(self, data_dir: Path, *, source_factory: Callable[..., Any] = EurexDelayedSource,
                 ring_columns: int = 512, poll_s: float = 60.0, idle_s: float = IDLE_S) -> None:
        self.root = Path(data_dir).expanduser() / 'eurex-official'
        self._source_factory = source_factory
        self._limit = max(1, ring_columns)
        self._poll_s = poll_s
        self._lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        self._opened = False
        self._closing = False
        self._store: IntradayStore | None = None
        self._source: Any = None
        self._task: asyncio.Task | None = None
        self._idle_s = idle_s
        self._leases = 0
        self._idle_since = time.monotonic()
        self._tails: dict[str, tuple[BarEnvelope, ...]] = {}
        self.changed = asyncio.Event()
        self._state: dict[str, Any] = {'status': 'idle', 'pending_files': None,
                                     'last_success_ns': None, 'latest_event_ns': None,
                                     'manifest_gaps': [], 'error_code': None}

    def _notify(self) -> None:
        previous = self.changed
        self.changed = asyncio.Event()
        previous.set()

    def _read_tails(self) -> dict[str, tuple[BarEnvelope, ...]]:
        assert self._store is not None
        tails = {}
        for symbol, contract in SYMBOLS.items():
            tail: deque[BarEnvelope] = deque(maxlen=self._limit)
            cursor = None
            while True:
                page = self._store.query_bars(contract.isin, start_ns=cursor, limit=10_000)
                tail.extend(page)
                if len(page) < 10_000:
                    break
                cursor = page[-1].minute_start_ns + MINUTE_NS
            tails[symbol] = tuple(tail)
        return tails

    async def open(self) -> None:
        """Open the local archive and read the chart tails. Contacts no source."""
        async with self._lock:
            if self._opened or self._closing:
                return
            try:
                # Initialization, migration and every SQLite read are off-loop.
                # Assign ownership inside worker so cancellation cannot lose the connection.
                def open_store() -> None:
                    self._store = IntradayStore(self.root)
                await safe_worker(open_store)
                self._tails = await safe_worker(self._read_tails)
                assert self._store is not None
                self._state['latest_event_ns'] = await safe_worker(self._store.latest_event_ns)
                self._source = self._source_factory(self._store)
                # Opened, not collecting: nothing is being fetched until a chart opens.
                self._state['status'] = 'idle'
                self._opened = True
            except Exception:
                if self._store is not None:
                    try:
                        await safe_worker(self._store.close)
                    except Exception:
                        pass
                    self._store = None
                self._state.update(status='error', error_code='store_unavailable')
            except asyncio.CancelledError:
                if self._store is not None:
                    await safe_worker(self._store.close)
                    self._store = None
                raise

    # Kept for callers of the earlier name: opening is all it ever needed to do for a reader.
    start = open

    async def acquire(self) -> None:
        """A chart of the market is open: collect from the source until it is released."""
        await self.open()
        if self._closing:
            return
        self._leases += 1
        if self._task is None or self._task.done():
            if self._state.get('status') == 'idle':
                self._state['status'] = 'syncing'
            self._task = asyncio.create_task(self._run(), name='eurex-official-collector')

    def release(self) -> None:
        """A chart closed. The collector stops ``idle_s`` after the last one."""
        self._leases = max(0, self._leases - 1)
        if self._leases == 0:
            self._idle_since = time.monotonic()

    @property
    def collecting(self) -> bool:
        return self._task is not None and not self._task.done()

    async def refresh(self, *, max_files: int = 4) -> dict[str, Any]:
        await self.open()
        async with self._refresh_lock:
            if self._closing or self._source is None:
                return self.status()
            try:
                progress = await self._source.refresh(max_files=max_files)
                if self._closing:
                    return self.status()
                self._state = audited_json(progress)
                # Internal timestamps remain integers; JSON conversion occurs at the API boundary.
                for key in ('latest_event_ns', 'last_success_ns', 'checked_ns'):
                    self._state[key] = getattr(progress, key)
                if progress.changed_bars or progress.removed_minutes:
                    async with self._lock:
                        self._tails = await safe_worker(self._read_tails)
                self._state.pop('changed_bars', None)
                self._state.pop('removed_minutes', None)
            except Exception:
                self._state.update(status='error', error_code='collector_error', checked_ns=time.time_ns())
            self._notify()
            return self.status()

    def _idle(self) -> bool:
        return self._leases == 0 and time.monotonic() - self._idle_since >= self._idle_s

    async def _run(self) -> None:
        while not self._closing and not self._idle():
            await self.refresh()
            # Empty recent partitions must not stop bounded newest-first catch-up.
            pending = self._state.get('pending_files') or 0
            delay = min(self._poll_s, 1.0) if pending and self._state['status'] == 'partial' else self._poll_s
            # Wake early when the last chart has been closed for long enough.
            remaining = self._idle_s - (time.monotonic() - self._idle_since)
            if self._leases == 0:
                delay = max(0.0, min(delay, remaining))
            await asyncio.sleep(delay)
        self._notify()

    def status(self) -> dict[str, Any]:
        state = dict(self._state)
        latest = state.get('latest_event_ns')
        state.update(collecting=self.collecting,
                     source=SOURCE, input_origin='native', origin='derived', declared_delay_s=900,
                     market_status='unknown', session_status='unknown', data_quality='incomplete',
                     event_age_s=max(0, (time.time_ns() - latest) / 1e9) if latest is not None else None,
                     coverage_scope='observed_only',
                     coverage_note=('Publication gaps do not establish event-time no-trade intervals; '
                                    'instrument-less publisher pretrade records are excluded'))
        return state

    async def history(self, symbol: str, *, start_ns: int | None = None,
                      end_ns: int | None = None, limit: int = 500) -> tuple[BarEnvelope, ...]:
        contract = contract_for(symbol)
        await self.open()
        async with self._lock:
            if self._store is None or self._closing:
                return ()
            try:
                return await safe_worker(self._store.query_bars, contract.isin, start_ns=start_ns,
                                         end_ns=end_ns, limit=limit)
            except Exception:
                self._state.update(status='error', error_code='store_read_error')
                self._notify()
                return ()

    async def snapshot(self, symbol: str) -> CandleSnapshot:
        contract_for(symbol)
        await self.open()
        def price(value: Decimal | None) -> float:
            return float(value) if value is not None else float('nan')
        return CandleSnapshot(tuple(CandleSample(
            b.minute_start_ns, price(b.open), price(b.high), price(b.low), price(b.close),
            float(b.volume), price(b.vwap), b.revision,
        ) for b in self._tails.get(symbol, ())))

    async def close(self) -> None:
        self._closing = True
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        async with self._refresh_lock:
            async with self._lock:
                if self._source is not None:
                    await self._source.close()
                    self._source = None
                if self._store is not None:
                    await safe_worker(self._store.close)
                    self._store = None
        self._notify()
