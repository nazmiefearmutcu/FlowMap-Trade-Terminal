import { describe, expect, it } from 'vitest';

import type { CandleSnapshot } from '../candles/store';
import type { Candle } from '../candles/synth';
import {
  SLOT_CAP,
  feedNew,
  needsRebuild,
  peekForming,
  rebuildAll,
  type FeedInstance,
} from './feed';
import { createAtr } from './kernels/atr';
import type { CandleInput, IndicatorKernel } from './kernels/types';

// The overlay must commit closed buckets only, peek the forming one, carry
// the price across empty buckets, and replay only on real invalidation. The spy
// kernel is a running volume sum, so a double-counted bucket shows up directly.

interface SpyKernel extends IndicatorKernel {
  pushes: CandleInput[];
  resets: number;
}

function sumKernel(): SpyKernel {
  let committed = 0;
  const spy: SpyKernel = {
    outputKeys: ['cum'],
    pushes: [],
    resets: 0,
    push(c) {
      spy.pushes.push(c);
      committed += c.v;
      return [committed];
    },
    peek(c) {
      return [committed + c.v];
    },
    reset() {
      committed = 0;
      spy.resets += 1;
    },
  };
  return spy;
}

function instance(): FeedInstance & { kernel: SpyKernel } {
  return {
    kernel: sumKernel(),
    rings: [new Float64Array(SLOT_CAP).fill(Number.NaN)],
    lastFedBi: -1,
    lastClose: Number.NaN,
  };
}

function candle(bi: number, c: number, v: number): Candle {
  return { bi, t0Ns: BigInt(bi), o: c, h: c, l: c, c, v, trades: 1, firstTsNs: BigInt(bi), lastTsNs: BigInt(bi) };
}

function snap(candles: Candle[], over: Partial<CandleSnapshot> = {}): CandleSnapshot {
  return {
    version: 1,
    candles,
    timeframeNs: 60_000_000_000,
    timeframes: [],
    timeMap: null,
    stats: { merged: 0, dupSkipped: 0, droppedLate: 0, nonFinite: 0 },
    sessionEpoch: 0,
    closedRevision: 0,
    ...over,
  };
}

/** Run one overlay pass: feed the closed history, then score the forming bucket. */
function pass(inst: FeedInstance, s: CandleSnapshot): void {
  feedNew([inst], s);
  peekForming([inst], s);
}

const at = (inst: FeedInstance, bi: number): number => inst.rings[0][bi % SLOT_CAP];

describe('feed: the forming bucket is scored, never committed', () => {
  it('a trade into the forming bucket moves its peek but not the committed state', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 1), candle(11, 11, 2)]));
    expect(inst.kernel.pushes.length).toBe(1); // only bucket 10 is closed
    expect(at(inst, 10)).toBe(1);
    expect(at(inst, 11)).toBe(3); // 1 committed + 2 peeked, once

    pass(inst, snap([candle(10, 10, 1), candle(11, 12, 5)], { version: 2 }));
    expect(inst.kernel.pushes.length).toBe(1); // still nothing new committed
    expect(at(inst, 11)).toBe(6); // 1 + 5, not 1 + 2 + 5
  });

  it('when the forming bucket closes it is committed once, with its final volume', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 1), candle(11, 11, 5)]));
    pass(inst, snap([candle(10, 10, 1), candle(11, 11, 5), candle(12, 12, 1)], { version: 3 }));
    expect(inst.kernel.pushes.map((p) => p.v)).toEqual([1, 5]);
    expect(at(inst, 11)).toBe(6); // the committed running sum through bucket 11
    expect(at(inst, 12)).toBe(7); // forming bucket 12 scored on top
  });

  it('matches a naive recomputation over the closed buckets plus the forming one', () => {
    const inst = instance();
    const closed = [candle(20, 1, 3), candle(21, 2, 4), candle(22, 3, 5)];
    const forming = candle(23, 4, 6);
    pass(inst, snap([...closed, forming]));
    const naive = closed.reduce((a, b) => a + b.v, 0) + forming.v;
    expect(at(inst, 23)).toBe(naive);
  });
});

describe('feed: carry-forward across empty buckets (time-based periods)', () => {
  it('commits zero-volume bars at the previous close for each empty bucket', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 1), candle(13, 13, 2)]));
    const pushes = inst.kernel.pushes;
    expect(pushes.map((p) => p.c)).toEqual([10, 10, 10]); // 10, carry 11, carry 12
    expect(pushes[1]).toEqual({ o: 10, h: 10, l: 10, c: 10, v: 0, carry: true });
    expect(pushes[0].carry).toBeUndefined(); // a real closed bar is never flagged
    expect(at(inst, 11)).toBe(1); // the carry adds no volume
    expect(at(inst, 13)).toBe(3); // forming bucket 13 scored on top
  });

  it('does not invent bars before the first fed bar', () => {
    const inst = instance();
    pass(inst, snap([candle(50, 10, 1), candle(51, 11, 1)]));
    expect(inst.kernel.pushes.length).toBe(1);
  });
});

describe('feed: ATR skips carry-forward bars (no range, the value holds)', () => {
  function atrInstance(period: number): FeedInstance {
    return {
      kernel: createAtr(period),
      rings: [new Float64Array(SLOT_CAP).fill(Number.NaN)],
      lastFedBi: -1,
      lastClose: Number.NaN,
    };
  }

  it('a run of empty buckets leaves ATR as if the gap were not there', () => {
    // Real bars at 10, 11, 12, then 16 after a gap of 13..15; the forming bucket is 17.
    const gapped = atrInstance(2);
    pass(gapped, snap([candle(10, 10, 1), candle(11, 12, 1), candle(12, 13, 1), candle(16, 15, 1), candle(17, 16, 1)]));
    // The same real bars with no gap: their buckets are 10..14 instead.
    const solid = atrInstance(2);
    pass(solid, snap([candle(10, 10, 1), candle(11, 12, 1), candle(12, 13, 1), candle(13, 15, 1), candle(14, 16, 1)]));

    expect(at(gapped, 12)).toBeCloseTo(1.5, 12);
    expect(at(gapped, 13)).toBeCloseTo(1.5, 12); // held through the gap
    expect(at(gapped, 14)).toBeCloseTo(1.5, 12);
    expect(at(gapped, 15)).toBeCloseTo(1.5, 12);
    expect(at(gapped, 16)).toBeCloseTo(at(solid, 13), 12); // the first real bar after the gap
    expect(at(gapped, 17)).toBeCloseTo(at(solid, 14), 12); // the forming bar scores the same
    expect(at(gapped, 16)).toBeCloseTo(1.75, 12);
  });

  it('the carry bars still feed the other kernels as zero-volume bars', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 1), candle(13, 13, 2)]));
    expect(inst.kernel.pushes.filter((p) => p.carry === true).map((p) => p.v)).toEqual([0, 0]);
  });
});

describe('feed: replay only on real invalidation', () => {
  it('a forming-bucket trade does not invalidate the fed history', () => {
    const prev = snap([candle(10, 10, 1), candle(11, 11, 2)]);
    const next = snap([candle(10, 10, 1), candle(11, 11, 9)], { version: 2 });
    expect(needsRebuild(prev, next)).toBe(false);
  });

  it('a merge into an already-fed closed bucket invalidates the history', () => {
    const prev = snap([candle(10, 10, 1), candle(11, 11, 2)]);
    const next = snap([candle(10, 10, 4), candle(11, 11, 2)], { version: 2, closedRevision: 1 });
    expect(needsRebuild(prev, next)).toBe(true);
  });

  it('a timeframe or session change invalidates the history, even to an empty list', () => {
    const prev = snap([candle(10, 10, 1)]);
    expect(needsRebuild(prev, snap([candle(10, 10, 1)], { timeframeNs: 300_000_000_000 }))).toBe(true);
    expect(needsRebuild(prev, snap([], { sessionEpoch: 1 }))).toBe(true);
  });

  it('a rebuild replays the closed history from the start (the reset is counted)', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 1), candle(11, 11, 2), candle(12, 12, 3)]));
    expect(inst.kernel.resets).toBe(0);
    rebuildAll([inst], snap([candle(10, 10, 1), candle(11, 11, 2), candle(12, 12, 3)]));
    expect(inst.kernel.resets).toBe(1);
    expect(inst.kernel.pushes.length).toBe(2 + 2); // 10, 11 then 10, 11 again
    expect(at(inst, 11)).toBe(3); // a replay does not double-count either
  });

  it('a session switch clears the kernel state when the new snapshot is empty', () => {
    const inst = instance();
    pass(inst, snap([candle(10, 10, 9), candle(11, 11, 9)]));
    rebuildAll([inst], snap([], { sessionEpoch: 1 }));
    expect(inst.kernel.resets).toBe(1);
    expect(inst.lastFedBi).toBe(-1);
    pass(inst, snap([candle(90, 5, 1), candle(91, 6, 1)], { sessionEpoch: 1 }));
    expect(at(inst, 91)).toBe(1 + 1); // the new session starts from zero, not 9 + 9
  });
});
