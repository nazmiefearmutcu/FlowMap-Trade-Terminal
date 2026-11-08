/**
 * Candle store tests. The store wires the raw stream → synth, tracks the
 * column⇄time affine from DEPTH_COL anchors, resets on a session switch, and
 * persists the timeframe choice. jsdom's real localStorage is used (cleared in
 * resetForTest), and stream messages are injected through the test seam — no
 * socket, no timing pins beyond the 100 ms notify throttle (forced via
 * flushForTest / fake timers, cyclic-order style).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MsgType, type DepthColumn, type Trade } from '../proto/types';
import { useFlowMapStore } from '../state/store';
import {
  CANDLE_TIMEFRAMES,
  getSnapshot,
  ingestForTest,
  resetForTest,
  setTimeframe,
  subscribe,
  TF_STORAGE_KEY,
} from './store';

const MIN = CANDLE_TIMEFRAMES[0].ns;

function trade(tsNs: bigint, price: number, size = 1): Trade {
  return { type: MsgType.TRADE, ts_ns: tsNs, price, size, side: 0, side_src: 0, venue: 'x' };
}

function depthCol(epoch: number, colSeq: number, t0Ns: bigint): DepthColumn {
  return {
    type: MsgType.DEPTH_COL,
    epoch,
    col_seq: colSeq,
    t0_ns: t0Ns,
    mode: 0,
    final: true,
    bid: new Float32Array(4),
    ask: new Float32Array(4),
  };
}

/** Put the session store into a connected state (subscription + epoch geometry). */
function connectSession(market = 'sim', symbol = 'SIM-DEMO'): void {
  useFlowMapStore.setState({
    subscription: { market, symbol, mode: 'live', band: 'native' },
    gridEpoch: 7,
    epochs: new Map([
      [7, { epoch: 7, tick: 1, tick_multiple: 1, dt_ns: 250_000_000, p0: 100, rows: 2048 }],
    ]),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useFlowMapStore.setState({
    subscription: null,
    gridEpoch: null,
    epochs: new Map(),
    sessionId: null,
    status: 'idle',
  });
});

afterEach(() => {
  resetForTest();
  vi.useRealTimers();
});

describe('candle store — stream wiring', () => {
  it('builds candles from streamed trades and notifies throttled', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const unsub = subscribe((s) => seen.push(s.candles.length));
    ingestForTest(trade(0n, 100));
    ingestForTest(trade(1_000_000_000n, 101));
    ingestForTest(trade(2_000_000_000n, 102));
    expect(seen).toEqual([]); // nothing synchronous — coalesced
    vi.advanceTimersByTime(101);
    expect(seen).toEqual([1]);
    expect(getSnapshot().candles[0]).toMatchObject({ o: 100, h: 102, l: 100, c: 102, v: 3 });
    unsub();
  });

  it('merges two distinct same-millisecond fills and drops only a repeated connection sequence', () => {
    connectSession();
    subscribe(() => {});
    ingestForTest(trade(0n, 100, 0.001));
    ingestForTest(trade(0n, 100, 0.001)); // a second fill, same ms, same value
    expect(getSnapshot().candles[0].trades).toBe(2);
    expect(getSnapshot().candles[0].v).toBeCloseTo(0.002, 12);
    expect(getSnapshot().stats.dupSkipped).toBe(0);

    const sequenced = Object.assign(trade(1_000_000_000n, 101, 1), { seq: 9 });
    ingestForTest(sequenced);
    ingestForTest(sequenced); // re-delivery of seq 9
    expect(getSnapshot().stats.dupSkipped).toBe(1);
  });

  it('tracks the column⇄time affine from DEPTH_COL anchors (epoch-major)', () => {
    connectSession(); // epoch 7 geometry (dt 250ms) must be known to anchor
    subscribe(() => {});
    ingestForTest(depthCol(7, 10, 1_000_000_000n));
    expect(getSnapshot().timeMap).toEqual({
      anchorSeq: 10,
      anchorT0Ns: 1_000_000_000n,
      dtNs: 250_000_000,
    });
    // Newer column in the same epoch re-anchors (any anchor of the affine is exact).
    ingestForTest(depthCol(7, 11, 1_250_000_000n));
    expect(getSnapshot().timeMap?.anchorSeq).toBe(11);
    // A straggler from an OLD epoch never rewinds the anchor.
    ingestForTest(depthCol(6, 999, 0n));
    expect(getSnapshot().timeMap?.anchorSeq).toBe(11);
    // An epoch with unknown geometry is ignored rather than poisoning the affine.
    ingestForTest(depthCol(8, 12, 2_000_000_000n));
    expect(getSnapshot().timeMap?.anchorSeq).toBe(11);
  });

  it('resets candles when the session key changes and again on a new Hello', () => {
    connectSession();
    subscribe(() => {});
    ingestForTest(trade(0n, 100));
    expect(getSnapshot().candles.length).toBe(1);

    // Symbol switch (ask-time reset, mirroring App.tsx's subKey effect).
    useFlowMapStore.setState({
      subscription: { market: 'sim', symbol: 'OTHER', mode: 'live', band: 'native' },
    });
    expect(getSnapshot().candles.length).toBe(0);

    // Refill, then a NEW session Hello (the stream provably swapped) resets again.
    ingestForTest(trade(0n, 200));
    expect(getSnapshot().candles.length).toBe(1);
    useFlowMapStore.setState({ sessionId: 'sess-2' });
    expect(getSnapshot().candles.length).toBe(0);
  });

  it('the first Hello of the first attach resets only an empty ring', () => {
    subscribe(() => {});
    connectSession();
    useFlowMapStore.setState({ sessionId: 'sess-1' });
    ingestForTest(trade(0n, 100));
    expect(getSnapshot().candles.length).toBe(1);
  });

  it('a reconnect into the same session re-sends the tape, and the reset counts it once', () => {
    connectSession();
    subscribe(() => {});
    useFlowMapStore.setState({ sessionId: 'sess-1', status: 'live' });
    // 100 sequenced prints over 100 buckets: more than the 64-entry sequence window,
    // so the window alone cannot stop a re-sent tail from merging again.
    const tape = Array.from({ length: 100 }, (_, i) =>
      Object.assign(trade(BigInt(i) * 60_000_000_000n, 100 + (i % 7), 1 + (i % 3)), { seq: i + 1 }),
    );
    for (const tr of tape) ingestForTest(tr);
    const first = getSnapshot();
    expect(first.candles.reduce((n, c) => n + c.trades, 0)).toBe(100);

    // The socket drops, and the same session's Hello returns with the attach snapshot.
    useFlowMapStore.setState({ status: 'reconnecting' });
    useFlowMapStore.setState({ status: 'live' });
    for (const tr of tape) ingestForTest(tr);

    const again = getSnapshot();
    expect(again.candles).toEqual(first.candles);
    expect(again.sessionEpoch).toBe(first.sessionEpoch + 1);
  });

  it('a return to live after an explicit close resets the ring too', () => {
    connectSession();
    subscribe(() => {});
    useFlowMapStore.setState({ sessionId: 'sess-1', status: 'live' });
    ingestForTest(trade(0n, 100));
    expect(getSnapshot().candles.length).toBe(1);
    // Closed, then re-opened by connect(): the same session's attach snapshot follows.
    useFlowMapStore.setState({ status: 'closed' });
    useFlowMapStore.setState({ status: 'live' });
    expect(getSnapshot().candles.length).toBe(0);
  });

  it('every Hello resets the ring, a same-session reconnect included (attachEpoch)', () => {
    connectSession();
    subscribe(() => {});
    useFlowMapStore.setState({ sessionId: 'sess-1', status: 'live' });
    ingestForTest(trade(0n, 100));
    const epoch = getSnapshot().sessionEpoch;
    // A Hello for the same session: no status edge and no session id change.
    useFlowMapStore.setState({ attachEpoch: useFlowMapStore.getState().attachEpoch + 1 });
    expect(getSnapshot().candles.length).toBe(0);
    expect(getSnapshot().sessionEpoch).toBe(epoch + 1);
  });

  it('a reconnect re-sends the 500-trade attach tail, and every trade counts once', () => {
    connectSession();
    subscribe(() => {});
    useFlowMapStore.setState({ sessionId: 'sess-1', status: 'live' });
    const tail = Array.from({ length: 500 }, (_, i) =>
      Object.assign(trade(BigInt(i) * 1_000_000_000n, 100 + (i % 5), 1), { seq: i + 1 }),
    );
    for (const tr of tail) ingestForTest(tr);
    const tradesOf = (): number => getSnapshot().candles.reduce((n, c) => n + c.trades, 0);
    const volumeOf = (): number => getSnapshot().candles.reduce((n, c) => n + c.v, 0);
    expect(tradesOf()).toBe(500);

    useFlowMapStore.setState({ status: 'reconnecting' });
    useFlowMapStore.setState({ status: 'live', attachEpoch: useFlowMapStore.getState().attachEpoch + 1 });
    for (const tr of tail) ingestForTest(tr);
    expect(tradesOf()).toBe(500);
    expect(volumeOf()).toBe(500);
  });

  it('the first live status after connecting is not a reconnect and keeps the ring', () => {
    connectSession();
    subscribe(() => {});
    useFlowMapStore.setState({ sessionId: 'sess-1', status: 'connecting' });
    ingestForTest(trade(0n, 100));
    const epoch = getSnapshot().sessionEpoch;
    useFlowMapStore.setState({ status: 'live' });
    expect(getSnapshot().candles.length).toBe(1);
    expect(getSnapshot().sessionEpoch).toBe(epoch);
  });
});

describe('candle store — timeframe select + persistence', () => {
  it('defaults to 1m, applies a known timeframe, ignores junk', () => {
    expect(getSnapshot().timeframeNs).toBe(MIN);
    setTimeframe(CANDLE_TIMEFRAMES[1].ns);
    expect(getSnapshot().timeframeNs).toBe(CANDLE_TIMEFRAMES[1].ns);
    expect(window.localStorage.getItem(TF_STORAGE_KEY)).toBe(String(CANDLE_TIMEFRAMES[1].ns));
    setTimeframe(42_000_000_000); // unknown — refused, never persisted
    expect(getSnapshot().timeframeNs).toBe(CANDLE_TIMEFRAMES[1].ns);
    expect(window.localStorage.getItem(TF_STORAGE_KEY)).toBe(String(CANDLE_TIMEFRAMES[1].ns));
  });

  it('restores the persisted timeframe and falls back on corrupt values', () => {
    window.localStorage.setItem(TF_STORAGE_KEY, String(CANDLE_TIMEFRAMES[2].ns));
    resetForTest();
    expect(getSnapshot().timeframeNs).toBe(CANDLE_TIMEFRAMES[2].ns);
    window.localStorage.setItem(TF_STORAGE_KEY, 'not-a-number');
    resetForTest();
    expect(getSnapshot().timeframeNs).toBe(MIN);
  });

  it('changing the timeframe clears incompatible buckets', () => {
    subscribe(() => {});
    ingestForTest(trade(0n, 100));
    setTimeframe(CANDLE_TIMEFRAMES[1].ns);
    expect(getSnapshot().candles.length).toBe(0);
    ingestForTest(trade(0n, 100));
    ingestForTest(trade(299_000_000_000n, 101)); // still inside the FIRST 5m bucket
    expect(getSnapshot().candles.length).toBe(1);
    expect(getSnapshot().candles[0].c).toBe(101);
  });
});
