import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { flushForTest, ingestForTest, resetForTest, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { setLocale, tFor } from '../i18n';
import { tr } from '../i18n/tr';
import { bookTopOfBook } from './DomLadder';
import { MarketStrip, quoteAgeText } from './MarketStrip';
import { MsgType, MODE_L2 } from '../proto/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('retains exchange decimals when depth is grouped and never derives fake quotes', () => {
  resetForTest();
  useFlowMapStore.setState({ gridEpoch: 1, epochs: new Map([[1, {
    epoch: 1, tick: .01, tick_multiple: 50, p0: 85000, rows: 4096, dt_ns: 250000000,
  }]]), subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' }, status: 'live' });
  ingestForTest({ type: 6, ts_ns: 1n, bid_px: 85636.92, bid_sz: 1.25, ask_px: 85636.93, ask_sz: 2 } as never);
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
  expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('85636.92');
  expect(el.querySelector('[data-testid="market-ask"]')?.textContent).toBe('85636.93');
  expect(el.querySelector('[data-testid="market-spread"]')?.textContent).toBe('0.01');
  act(() => root.unmount());
  resetForTest();
});
it('labels local quote age without claiming network latency', () => {
  expect(quoteAgeText(undefined, 10000)).toBe('—');
  expect(quoteAgeText(10000, 10120)).toBe('120 ms');
  expect(quoteAgeText(10000, 14500)).toBe('4.5 s');
  expect(quoteAgeText(10000, 9900)).toBe('0 ms');
});

it('uses the Turkish seconds unit and decimal comma in the quote age', () => {
  const units = { ms: tr['unit.ms'], s: tr['unit.s'] };
  expect(quoteAgeText(10000, 10120, units)).toBe('120 ms');
  setLocale('tr');
  try {
    expect(quoteAgeText(10000, 14500, units)).toBe('4,5 sn');
  } finally {
    setLocale('en');
  }
});

it('captions the full-history window in the active locale', () => {
  setLocale('tr');
  try {
    expect(tFor('tr', 'marketStrip.windowAll')).toBe('Tümü');
    expect(tFor('en', 'marketStrip.windowAll')).toBe('All');
  } finally {
    setLocale('en');
  }
});

it('clears the top price strip quote and age at crossed recorded positions, then accepts the next column quote', () => {
  // Repaints are throttled to ~10 Hz: step the clock past the window between updates.
  vi.useFakeTimers();
  const settle = (): void => { act(() => { vi.advanceTimersByTime(200); }); };
  resetForTest();
  useFlowMapStore.setState({ subscription: { market: 'binance', symbol: 'BTCUSDT', mode: 'replay', band: 'native' },
    capability: { depth: 'L2', depth_provenance: 'recorded-density' }, status: 'live' });
  const column = (t: bigint, crossed: boolean): void => {
    ingestForTest({ type: MsgType.BOOK_UPDATE, epoch: 0, col_seq: Number(t), t0_ns: t, mode: MODE_L2,
      final: false, bid: Float32Array.of(0, 0, 2, 0), ask: Float32Array.from(crossed ? [0, 3, 0, 0] : [0, 0, 0, 3]) });
  };
  column(1n, true);
  const el = document.createElement('div'), root = createRoot(el);
  try {
    act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
    const assertUnavailable = (): void => {
      for (const id of ['market-bid', 'market-ask', 'market-spread']) {
        expect(el.querySelector(`[data-testid="${id}"]`)?.textContent).toBe('—');
      }
      expect(el.querySelector('[data-testid="market-quote-age"]')?.textContent).toBe('Quote age —');
    };
    assertUnavailable();
    act(() => {
      column(2n, false);
      ingestForTest({ type: MsgType.BBO, ts_ns: 2n, bid_px: 60001, bid_sz: 2, ask_px: 60001.5, ask_sz: 3 });
      flushForTest();
    });
    settle();
    expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('60001.00');
    act(() => { column(3n, true); flushForTest(); });
    settle();
    assertUnavailable();
    act(() => {
      column(4n, false);
      ingestForTest({ type: MsgType.BBO, ts_ns: 4n, bid_px: 60002, bid_sz: 2, ask_px: 60002.5, ask_sz: 3 });
      flushForTest();
    });
    settle();
    expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('60002.00');
  } finally { act(() => root.unmount()); resetForTest(); vi.useRealTimers(); }
});

it('falls back to the depth book top when no BBO frame has arrived, and labels the source', () => {
  resetForTest();
  useFlowMapStore.setState({ gridEpoch: 1, epochs: new Map([[1, {
    epoch: 1, tick: 0.5, tick_multiple: 1, p0: 100, rows: 200, dt_ns: 250000000,
  }]]), subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' }, status: 'live' });
  const bid = new Float32Array(200);
  const ask = new Float32Array(200);
  bid[100] = 4; // best bid rung: 100 + 100 × 0.5 = 150.0
  ask[101] = 6; // best ask rung: 100 + 101 × 0.5 = 150.5
  ingestForTest({ type: MsgType.BOOK_UPDATE, epoch: 1, col_seq: 1, t0_ns: 1n, mode: MODE_L2,
    final: false, bid, ask } as never);
  flushForTest();
  const el = document.createElement('div'), root = createRoot(el);
  try {
    act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
    expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('150.0');
    expect(el.querySelector('[data-testid="market-ask"]')?.textContent).toBe('150.5');
    expect(el.querySelector('[data-testid="market-spread"]')?.textContent).toBe('0.5');
    expect(el.querySelector('[data-testid="market-book-src"]')?.textContent).toBe('from book');
    expect(el.querySelector('[data-testid="market-quote-age"]')?.textContent).toBe('Quote age —');
  } finally { act(() => root.unmount()); resetForTest(); }
});

describe('bookTopOfBook', () => {
  const PARAMS = { epoch: 1, tick: 0.5, tick_multiple: 1, p0: 100, rows: 200, dt_ns: 250000000 };
  const snapOf = (bid: Float32Array, ask: Float32Array | null, recordedDensity = false): BookSnapshot => ({
    version: 1,
    bbo: null,
    trades: [],
    book: { epoch: 1, mode: MODE_L2, colSeq: 1, t0Ns: 1n, bid, ask, recordedDensity },
  });
  const rows = (...entries: [number, number][]): Float32Array => {
    const a = new Float32Array(200);
    for (const [r, v] of entries) a[r] = v;
    return a;
  };

  it('reads the highest bid and lowest ask rungs without synthesising a side', () => {
    const top = bookTopOfBook(snapOf(rows([90, 1], [100, 4]), rows([101, 6], [120, 2])), PARAMS);
    expect(top).toEqual({ bidPx: 150, bidSz: 4, askPx: 150.5, askSz: 6 });
    expect(bookTopOfBook(snapOf(rows([100, 4]), rows()), PARAMS)).toBeNull();
    expect(bookTopOfBook(snapOf(rows(), rows([101, 6])), PARAMS)).toBeNull();
  });

  it('returns null for a crossed book, recorded density, or a profile without asks', () => {
    expect(bookTopOfBook(snapOf(rows([105, 4]), rows([101, 6])), PARAMS)).toBeNull();
    expect(bookTopOfBook(snapOf(rows([100, 4]), rows([101, 6]), true), PARAMS)).toBeNull();
    expect(bookTopOfBook(snapOf(rows([100, 4]), null), PARAMS)).toBeNull();
    expect(bookTopOfBook(snapOf(rows([100, 4]), rows([101, 6])), undefined)).toBeNull();
  });
});

it('holds a book repaint inside the 100 ms window and shows the newest quote when it closes', () => {
  vi.useFakeTimers();
  let clock = 1000;
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  resetForTest();
  useFlowMapStore.setState({ subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' }, status: 'live' });
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
  const bid = (): string | null | undefined => el.querySelector('[data-testid="market-bid"]')?.textContent;
  const quote = (px: number): void => {
    ingestForTest({ type: MsgType.BBO, ts_ns: 1n, bid_px: px, bid_sz: 1, ask_px: px + 0.5, ask_sz: 1 });
    act(() => flushForTest());
  };
  quote(85000.5);
  expect(bid()).toBe('85000.5');
  // A second book notification 10 ms later lands inside the window: it must wait.
  clock += 10;
  quote(85010.5);
  expect(bid()).toBe('85000.5');
  clock += 90;
  act(() => { vi.advanceTimersByTime(90); });
  expect(bid()).toBe('85010.5');
  act(() => root.unmount());
  resetForTest();
  nowSpy.mockRestore();
  vi.useRealTimers();
});
