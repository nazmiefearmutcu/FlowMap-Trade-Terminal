"""Native Eurex integration: real files, no scanner, Yahoo or fabricated prints."""
from __future__ import annotations

import asyncio
import json
import threading
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from crocodile.equity.universal.live.intraday_store import IntradayStore

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.core.session import ClientTx, SessionManager
from flowmap_server.data.venues import resolve_symbol, venue_symbols
from flowmap_server.feeds.eurex_official import MARKET, EurexOfficialFeed, EurexService
from flowmap_server.feeds.router import build_feed
from flowmap_server.proto import events
from crocodile.equity.universal.live.intraday_models import parse_utc_ns

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures' / 'eurex_official'


class OfflineSource:
    def __init__(self, store):
        self.store = store
        self.calls = 0
        self.closed = False

    async def refresh(self, *, max_files=4):
        self.calls += 1
        raise RuntimeError('offline')

    async def close(self):
        self.closed = True


def seed(root):
    with IntradayStore(root / 'eurex-official') as store:
        for path in sorted(FIXTURES.glob('*.gz')):
            store.ingest_file(path.name, path.read_bytes())


async def test_catalogue_and_router_are_native(tmp_path):
    assert await venue_symbols(MARKET) == ['FDAXZ2026', 'FGBLZ2026']
    assert await resolve_symbol(MARKET, 'FDAXZ2026') == 'FDAXZ2026'
    for symbol in ('FDAX1!', 'FGBL1!', 'UNKNOWN', 'fdaxz2026'):
        with pytest.raises(ValueError, match='FDAXZ2026'):
            await resolve_symbol(MARKET, symbol)
        with pytest.raises(ValueError):
            build_feed(events.Subscribe(MARKET, symbol, 'live'), Config(data_dir=str(tmp_path)), realtime_sim=False)
    assert isinstance(build_feed(events.Subscribe(MARKET, 'FDAXZ2026', 'live'), Config(), realtime_sim=False), EurexOfficialFeed)


async def test_cached_golden_history_survives_error_restart_and_pages(tmp_path):
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    app = create_app(Config(data_dir=str(tmp_path)), eurex_service=service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://127.0.0.1:8720') as client:
        first = await client.get('/api/eurex/history', params={'symbol': 'FDAXZ2026', 'limit': 1})
        assert first.status_code == 200
        body = first.json()
        assert len(body['bars']) == 1 and isinstance(body['bars'][0]['volume'], str)
        assert isinstance(body['bars'][0]['minute_start_ns'], str)
        second = (await client.get('/api/eurex/history', params={'symbol': 'FDAXZ2026', 'limit': 1, 'cursor': body['next_cursor']})).json()
        assert second['bars'][0]['minute_start_ns'] != body['bars'][0]['minute_start_ns']
        assert second['next_cursor'] is None
        assert (await client.get('/api/eurex/history', params={'symbol': 'FDAX1!'})).status_code == 422
        assert (await client.get('/api/eurex/history', params={'symbol': 'FDAXZ2026', 'limit': 1001})).status_code == 422
        refreshed = (await client.post('/api/eurex/refresh')).json()
        assert refreshed['status'] == 'error'
        assert refreshed['market_status'] == 'unknown'
        assert refreshed['declared_delay_s'] == 900
        assert len((await client.get('/api/eurex/history', params={'symbol': 'FGBLZ2026'})).json()['bars']) == 2
        quote = (await client.get('/api/quote', params={'market': MARKET, 'symbol': 'FDAXZ2026'})).json()
        assert quote['price'] is not None and quote['stale'] is True
    await service.close()
    restarted = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    assert len((await restarted.snapshot('FDAXZ2026')).candles) == 2
    await restarted.close()


async def test_native_session_minute_snapshot_revision_removal_is_atomic(tmp_path):
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    cfg = Config(data_dir=str(tmp_path), ring_columns=8)
    manager = SessionManager(cfg, feed_factory=lambda sub: EurexOfficialFeed(sub.symbol, service))
    client = ClientTx()
    session = await manager.subscribe(events.Subscribe(MARKET, 'FDAXZ2026', 'live'), client)
    await asyncio.sleep(0)
    bars = session.grid.history(2**63-1, 8)
    assert len(bars) == 2
    assert all(c.t0_ns % 60_000_000_000 == 0 for c in bars)
    assert session.grid.cfg.dt_ns == 60_000_000_000
    assert not session._tape and session._bbo is None
    assert all(not c.bid.any() and not c.ask.any() for c in bars)
    assert session.grid.current_partial() is None
    client.drain(10**8)
    session._flush_partial()
    assert client.drain(10**8) == []
    snap = await service.snapshot('FDAXZ2026')
    from flowmap_server.core.session_candles import apply_candle_snapshot
    from flowmap_server.feeds.base import CandleSnapshot
    import msgspec
    before_volume = bars[-1].bar.vwap_den_cum
    apply_candle_snapshot(session, snap)
    assert session.grid.history(2**63-1, 8)[-1].bar.vwap_den_cum == before_volume
    revised = msgspec.structs.replace(snap.candles[0], c=snap.candles[0].c + 1, volume=7, revision=99)
    old_epoch = session.grid.current_epoch_params().epoch
    apply_candle_snapshot(session, CandleSnapshot((revised,)))
    replaced = session.grid.history(2**63-1, 8)
    assert len(replaced) == 1 and replaced[0].bar.c == revised.c
    assert replaced[0].bar.vwap_den_cum == 7
    assert replaced[0].bar.vol_buy == replaced[0].bar.vol_sell == 0
    assert session.grid.current_epoch_params().epoch > old_epoch
    frames = client.drain(10**8)
    from flowmap_server.proto import wire
    assert frames[0][0] == wire.MSG_HELLO
    apply_candle_snapshot(session, CandleSnapshot(()))
    assert session.grid.history(2**63-1, 8) == []
    assert session.grid.current_epoch_params().epoch > old_epoch
    session.detach(client)
    session.teardown_now()
    if session.run_task:
        await asyncio.gather(session.run_task, return_exceptions=True)
    await service.close()


async def test_four_real_golden_envelopes_and_bounded_viewport(tmp_path):
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, ring_columns=1, poll_s=3600)
    expected = json.loads((FIXTURES / 'expected_minutes.json').read_text())['expected_minutes']
    for symbol in ('FDAXZ2026', 'FGBLZ2026'):
        bars = await service.history(symbol)
        assert len(bars) == 2
        assert len((await service.snapshot(symbol)).candles) == 1
        for bar in bars:
            row = next(row for row in expected if row['isin'] == bar.isin
                       and parse_utc_ns(row['minute_start_utc']) == bar.minute_start_ns)
            for field in ('open', 'high', 'low', 'close'):
                assert getattr(bar, field) == Decimal(row[field])
            assert bar.volume == Decimal(row['quantity_sum_raw'])
            assert bar.vwap == Decimal(row['vwap_raw'])
            assert bar.quantity_unit == 'publisher_quantity'
    await service.close()


async def test_shared_collector_does_not_hold_cached_history_during_network(tmp_path):
    seed(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    sources = []

    class WaitingSource(OfflineSource):
        async def refresh(self, *, max_files=4):
            self.calls += 1
            entered.set()
            await release.wait()
            raise RuntimeError('offline')

    def factory(store):
        source = WaitingSource(store)
        sources.append(source)
        return source

    service = EurexService(tmp_path, source_factory=factory, poll_s=3600)
    # Two open charts share one collector.
    await asyncio.gather(service.acquire(), service.acquire())
    await entered.wait()
    bars = await asyncio.wait_for(service.history('FDAXZ2026'), .5)
    assert len(bars) == 2 and len(sources) == 1 and sources[0].calls == 1
    await service.close()
    assert sources[0].closed


async def test_read_cancellation_waits_for_worker_before_store_close(tmp_path, monkeypatch):
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    await service.start()
    assert service._store is not None
    entered, release = threading.Event(), threading.Event()
    original = service._store.query_bars

    def paused(*args, **kwargs):
        entered.set()
        release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(service._store, 'query_bars', paused)
    reading = asyncio.create_task(service.history('FDAXZ2026'))
    assert await asyncio.to_thread(entered.wait, 2)
    reading.cancel()
    closing = asyncio.create_task(service.close())
    await asyncio.sleep(.03)
    assert not reading.done() and not closing.done()
    reading.cancel()  # repeated cancellation cannot escape the worker barrier
    release.set()
    await asyncio.gather(reading, return_exceptions=True)
    await closing


async def test_native_discovery_quote_backfill_options_never_call_generic_sources(tmp_path, monkeypatch):
    seed(tmp_path)
    from flowmap_server.feeds import asset_markets
    from flowmap_server.api import market_cache
    from flowmap_server.data import venues

    def forbidden(*args, **kwargs):
        raise AssertionError('generic provider reached')

    monkeypatch.setattr(asset_markets, 'asset_feed', forbidden)
    monkeypatch.setattr(market_cache, '_equity_quote', forbidden)
    monkeypatch.setattr(market_cache, '_crypto_quote', forbidden)
    monkeypatch.setattr(venues, '_load_tables', forbidden)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    app = create_app(Config(data_dir=str(tmp_path)), eurex_service=service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://127.0.0.1:8720') as client:
        rows = (await client.get('/api/universe', params={'market': MARKET})).json()['symbols']
        assert [row['symbol'] for row in rows] == ['FDAXZ2026', 'FGBLZ2026']
        assert all(row['capability']['depth'] == 'N/A' for row in rows)
        assert (await client.get('/api/movers', params={'market': MARKET})).json() == {'movers': []}
        assert (await client.get('/api/options', params={'market': MARKET, 'symbol': 'FDAXZ2026'})).json()['status'] == 'unsupported'
        assert (await client.get('/api/quote', params={'market': MARKET, 'symbol': 'FDAX1!'})).status_code == 422
    assert await asset_markets.asset_backfill_fn(MARKET, 'FDAXZ2026', max_cols=100, now_ns=0) == []
    await service.close()


@pytest.mark.parametrize('params', [
    {'cursor': '-1'}, {'cursor': '9999999999999999999999'}, {'start_ns': '1.2'},
    {'start_ns': '20', 'end_ns': '10'}, {'limit': '0'},
])
async def test_history_query_validation(tmp_path, params):
    service = EurexService(tmp_path, source_factory=OfflineSource)
    app = create_app(Config(data_dir=str(tmp_path)), eurex_service=service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://127.0.0.1:8720') as client:
        response = await client.get('/api/eurex/history', params={'symbol': 'FDAXZ2026', **params})
        assert response.status_code == 422
    assert not service._opened


def test_websocket_native_subscribe_sends_candles_and_delay_state(tmp_path):
    from fastapi.testclient import TestClient
    from flowmap_server.api.market_cache import MarketDataCache, QuoteData
    from flowmap_server.proto import wire
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)

    async def quote(market, symbol):
        return QuoteData(market, symbol, reachable=False)

    async def movers(market, limit):
        return []

    app = create_app(Config(data_dir=str(tmp_path)), eurex_service=service,
                     market_cache=MarketDataCache(quote_fn=quote, movers_fn=movers))
    with TestClient(app, base_url='http://127.0.0.1:8720') as client:
        with client.websocket_connect('/ws') as ws:
            ws.send_bytes(wire.encode(events.Subscribe(MARKET, 'FDAXZ2026', 'live')))
            found = []
            while len([e for e in found if isinstance(e, events.BarColumn)]) < 2:
                frame = ws.receive_bytes()
                offset = 0
                while offset < len(frame):
                    event, offset = wire.decode(frame, offset)
                    found.append(event)
            hello = next(e for e in found if isinstance(e, events.Hello))
            assert hello.capability['source'] == 'eurex_delayed_posttrade'
            assert hello.capability['declared_delay_s'] == 900
            assert hello.capability['market_status'] == 'unknown'
            assert hello.capability['replay'] is False
            bars = [e for e in found if isinstance(e, events.BarColumn)]
            assert [b.c for b in bars] == [26877, 26880]
            assert bars[-1].vwap_den_cum == 70
            assert not any(isinstance(e, (events.Trade, events.BBO, events.BookUpdate)) for e in found)
    assert service._store is None


async def test_actual_file_revisions_removals_and_missing_prices_refresh_cached_snapshot(tmp_path):
    import gzip
    import math
    import time
    from collections import deque
    from crocodile.equity.universal.live.intraday_models import RefreshStatus

    seed(tmp_path)
    pending = deque()

    class RevisingSource(OfflineSource):
        async def refresh(self, *, max_files=4):
            if not pending:
                raise RuntimeError('offline')
            name, body = pending.popleft()
            result = self.store.ingest_file(name, body)
            now = time.time_ns()
            return RefreshStatus('ready', int(result.changed), 0,
                                 len(self.store.completed_files()), now, now,
                                 self.store.latest_event_ns(), (),
                                 result.changed_bars, result.removed_minutes, None, None)

    service = EurexService(tmp_path, source_factory=RevisingSource, poll_s=3600)
    try:
        original = await service.snapshot('FDAXZ2026')
        assert len(original.candles) == 2
        await asyncio.sleep(0)
        first_name = 'DEUR-posttrade-2026-11-13T10_00.json.gz'
        second_name = 'DEUR-posttrade-2026-11-13T10_01.json.gz'
        rows = [json.loads(line) for line in gzip.decompress((FIXTURES / first_name).read_bytes()).splitlines()]
        changed = next(row for row in rows if row['instrumentIdentificationCode'] == 'DE000F0GDWD2')
        changed = {**changed, 'price': 103, 'quantity': 7}
        pending.append((first_name, gzip.compress((json.dumps(changed) + '\n').encode())))
        await service.refresh(max_files=1)
        revised = await service.snapshot('FDAXZ2026')
        assert [c.volume for c in revised.candles] == [7, 37]
        assert revised.candles[0].c == 103
        assert revised.candles[0].revision > original.candles[0].revision

        pending.append((first_name, gzip.compress(b'')))
        await service.refresh(max_files=1)
        removed = await service.snapshot('FDAXZ2026')
        assert len(removed.candles) == 1
        assert removed.candles[0].ts_ns == original.candles[1].ts_ns

        rows = [json.loads(line) for line in gzip.decompress((FIXTURES / second_name).read_bytes()).splitlines()]
        missing = next(row for row in rows if row['instrumentIdentificationCode'] == 'DE000F0GDWD2')
        missing.pop('price')
        pending.append((second_name, gzip.compress((json.dumps(missing) + '\n').encode())))
        await service.refresh(max_files=1)
        empty_price = await service.snapshot('FDAXZ2026')
        assert len(empty_price.candles) == 1
        assert math.isnan(empty_price.candles[0].c)
        assert empty_price.candles[0].volume == 0
        audited = await service.history('FDAXZ2026')
        assert audited[0].quality == 'incomplete'
        assert 'missing_price' in audited[0].quality_reasons
    finally:
        await service.close()


class CountingSource(OfflineSource):
    """Answers every refresh at once, so a test can count how often the source was asked."""

    async def refresh(self, *, max_files=4):
        from crocodile.equity.universal.live.intraday_models import RefreshStatus

        self.calls += 1
        return RefreshStatus('ready', 0, 0, 0, 1, 1, None, (), (), (), None, None)


def counting(sources):
    def factory(store):
        source = CountingSource(store)
        sources.append(source)
        return source
    return factory


async def test_reading_never_starts_the_collector(tmp_path):
    # A quote (the palette, an armed alert), the status and the history read the archive only.
    seed(tmp_path)
    sources = []
    service = EurexService(tmp_path, source_factory=counting(sources), poll_s=0.01)
    app = create_app(Config(data_dir=str(tmp_path)), eurex_service=service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://127.0.0.1:8720') as client:
        assert (await client.get('/api/quote', params={'market': MARKET, 'symbol': 'FDAXZ2026'})).status_code == 200
        status = (await client.get('/api/eurex/status')).json()
        assert status['collecting'] is False
        # Opened to be read, not collecting: the status does not claim a sync.
        assert status['status'] == 'idle'
        page = (await client.get('/api/eurex/history', params={'symbol': 'FDAXZ2026'})).json()
        assert len(page['bars']) == 2
    assert len((await service.snapshot('FGBLZ2026')).candles) == 2
    await asyncio.sleep(0.05)
    assert not service.collecting
    assert sources and sources[0].calls == 0
    await service.close()


async def test_an_explicit_refresh_is_one_pass_and_starts_nothing(tmp_path):
    seed(tmp_path)
    sources = []
    service = EurexService(tmp_path, source_factory=counting(sources), poll_s=0.01)
    await service.refresh(max_files=1)
    await asyncio.sleep(0.05)
    assert sources[0].calls == 1 and not service.collecting
    await service.close()


async def test_the_collector_runs_while_a_chart_is_open_and_stops_after_the_last_closes(tmp_path):
    seed(tmp_path)
    sources = []
    service = EurexService(tmp_path, source_factory=counting(sources), poll_s=0.01, idle_s=0.05)
    feed = EurexOfficialFeed('FDAXZ2026', service)
    stream = feed.events()
    first = await stream.__anext__()
    assert len(first.candles) == 2
    assert service.collecting
    await asyncio.sleep(0.05)
    asked = sources[0].calls
    assert asked >= 2, 'an open chart keeps the collector polling'
    # The chart closes: the lease is returned, and the collector stops once idle.
    await stream.aclose()
    assert service._leases == 0
    for _ in range(100):
        if not service.collecting:
            break
        await asyncio.sleep(0.01)
    assert not service.collecting
    stopped_at = sources[0].calls
    await asyncio.sleep(0.05)
    assert sources[0].calls == stopped_at, 'no download after the collector stopped'
    # A chart opened again starts it again.
    await service.acquire()
    assert service.collecting
    service.release()
    await service.close()


async def test_two_charts_keep_one_collector_until_both_close(tmp_path):
    seed(tmp_path)
    sources = []
    service = EurexService(tmp_path, source_factory=counting(sources), poll_s=0.01, idle_s=0.03)
    await service.acquire()
    await service.acquire()
    task = service._task
    service.release()
    await asyncio.sleep(0.08)
    assert service.collecting and service._task is task
    service.release()
    for _ in range(100):
        if not service.collecting:
            break
        await asyncio.sleep(0.01)
    assert not service.collecting
    assert len(sources) == 1
    await service.close()


async def _candle_session(tmp_path, ring_columns=512):
    seed(tmp_path)
    service = EurexService(tmp_path, source_factory=OfflineSource, poll_s=3600)
    cfg = Config(data_dir=str(tmp_path), ring_columns=ring_columns)
    manager = SessionManager(cfg, feed_factory=lambda sub: EurexOfficialFeed(sub.symbol, service))
    client = ClientTx()
    session = await manager.subscribe(events.Subscribe(MARKET, 'FDAXZ2026', 'live'), client)
    await asyncio.sleep(0)
    return service, session, client


async def _close(service, session, client):
    session.detach(client)
    session.teardown_now()
    if session.run_task:
        await asyncio.gather(session.run_task, return_exceptions=True)
    await service.close()


def _candle(minute, price=100.0, volume=1.0):
    from flowmap_server.feeds.base import CandleSample

    base = parse_utc_ns('2026-11-13T10:00:00Z')
    ts = base + minute * 60_000_000_000
    return CandleSample(ts, price, price + 1, price - 1, price, volume, price, 1)


async def test_a_short_gap_is_drawn_as_empty_minutes_where_it_is(tmp_path):
    import math

    from flowmap_server.core.session_candles import apply_candle_snapshot
    from flowmap_server.feeds.base import CandleSnapshot

    service, session, client = await _candle_session(tmp_path)
    try:
        apply_candle_snapshot(session, CandleSnapshot((_candle(0), _candle(4, 101, 2))))
        cols = session.grid.history(2**63 - 1, 100)
        assert [round((c.t0_ns - cols[0].t0_ns) / 60e9) for c in cols] == [0, 1, 2, 3, 4]
        empty = cols[1:4]
        assert all(math.isnan(c.bar.c) and math.isnan(c.bar.o) for c in empty)
        # No quantity is invented for the missing minutes.
        assert [c.bar.vwap_den_cum for c in cols] == [1.0, 1.0, 1.0, 1.0, 3.0]
        assert not any(m.kind == 'gap' for m in session._markers)
    finally:
        await _close(service, session, client)


async def test_a_long_gap_is_marked_not_filled(tmp_path):
    from flowmap_server.core.session_candles import GAP_FILL_MINUTES, apply_candle_snapshot
    from flowmap_server.feeds.base import CandleSnapshot
    from flowmap_server.proto import wire

    service, session, client = await _candle_session(tmp_path)
    try:
        later = GAP_FILL_MINUTES + 2
        client.drain(10**8)
        apply_candle_snapshot(session, CandleSnapshot((_candle(0), _candle(later))))
        cols = session.grid.history(2**63 - 1, 1000)
        assert len(cols) == 2
        gaps = [m for m in session._markers if m.kind == 'gap']
        assert len(gaps) == 1
        assert gaps[0].ts_ns == cols[1].t0_ns
        assert f'({later - 1} min)' in gaps[0].text
        assert '2026-11-13 10:01' in gaps[0].text
        # The marker reaches the client with the snapshot.
        frames = b''.join(client.drain(10**8))
        decoded = []
        offset = 0
        while offset < len(frames):
            ev, offset = wire.decode(frames, offset)
            if ev is not None:
                decoded.append(ev)
        assert any(isinstance(ev, events.Marker) and ev.kind == 'gap' for ev in decoded)
    finally:
        await _close(service, session, client)


async def test_empty_minutes_count_against_the_bounded_ring(tmp_path):
    from flowmap_server.core.session_candles import apply_candle_snapshot
    from flowmap_server.feeds.base import CandleSnapshot

    service, session, client = await _candle_session(tmp_path, ring_columns=4)
    try:
        apply_candle_snapshot(session, CandleSnapshot((_candle(0), _candle(5), _candle(6))))
        cols = session.grid.history(2**63 - 1, 100)
        # The newest four columns: two empty minutes, then the two candles.
        assert len(cols) == 4
        assert cols[-1].bar.c == 100.0 and cols[-2].bar.c == 100.0
    finally:
        await _close(service, session, client)

