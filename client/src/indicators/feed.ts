/**
 * Feeding the streaming indicator kernels from the candle snapshot.
 *
 * Pure: no DOM, no store. The overlay canvas owns the instances and the paint;
 * this module decides which bars each kernel commits and when a kernel must be
 * replayed. Kept apart so the rules are unit-tested without a canvas.
 *
 * Rules:
 *  - Only CLOSED candles are committed. The last resident candle is the bucket
 *    still forming; it is scored with `peek` (as-if-pushed, state untouched), so
 *    VWAP, OBV and ATR cumulants never count a bucket twice.
 *  - Empty buckets are not candles, so each one between two fed bars is committed
 *    as a zero-volume carry-forward bar at the previous close. A period of N bars
 *    therefore spans N buckets of wall time, not N trades. ATR skips these bars:
 *    they have no range, so its value holds through the gap.
 *  - A replay (reset + feed from the start) happens only when the fed history is
 *    invalid: a timeframe change, a session change, or a merge into an already-fed
 *    closed bucket. Trades into the forming bucket never replay.
 */

import type { CandleSnapshot } from '../candles/store';
import type { CandleInput, IndicatorKernel } from './kernels/types';

/** Slot capacity for per-candle value rings (≥ synth ring 2000; resident span < ring, so slots are unique). */
export const SLOT_CAP = 4096;

/** The per-instance state the feed reads and writes. */
export interface FeedInstance {
  kernel: IndicatorKernel;
  /** Value per candle slot (NaN = no value), one Float64Array per output key. */
  rings: Float64Array[];
  /** Bucket id of the last CLOSED candle committed to the kernel (−1 = none). */
  lastFedBi: number;
  /** Close of the last committed bar; carries the price across empty buckets. */
  lastClose: number;
}

/**
 * Commit one bar to an instance's kernel and ring. Used for closed candles and
 * for the empty buckets between them (carry-forward, flagged so ATR skips them).
 */
export function commitBar(
  inst: FeedInstance,
  bi: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  carry = false,
): void {
  const bar: CandleInput = carry ? { o, h, l, c, v, carry: true } : { o, h, l, c, v };
  const values = inst.kernel.push(bar);
  const slot = bi % SLOT_CAP;
  for (let k = 0; k < inst.rings.length; k += 1) {
    const x = values[k];
    inst.rings[k][slot] = x === null || !Number.isFinite(x) ? Number.NaN : x;
  }
  inst.lastFedBi = bi;
  inst.lastClose = c;
}

/**
 * Feed every CLOSED candle each instance has not seen yet. The scan starts at the
 * newest end and touches only the unfed suffix, so a steady feed costs O(new).
 */
export function feedNew(instances: Iterable<FeedInstance>, snap: CandleSnapshot): void {
  const cs = snap.candles;
  const n = cs.length;
  for (const inst of instances) {
    let start = n;
    while (start > 0 && cs[start - 1].bi > inst.lastFedBi) start -= 1;
    for (let i = start; i < n; i += 1) {
      const candle = cs[i];
      if (inst.lastFedBi >= 0 && Number.isFinite(inst.lastClose)) {
        // Carry-forward across empty buckets, bounded to the ring span.
        const from = Math.max(inst.lastFedBi + 1, candle.bi - SLOT_CAP);
        for (let b = from; b < candle.bi; b += 1) {
          commitBar(inst, b, inst.lastClose, inst.lastClose, inst.lastClose, inst.lastClose, 0, true);
        }
      }
      if (i === n - 1) break; // forming: gap-filled before it, never committed
      commitBar(inst, candle.bi, candle.o, candle.h, candle.l, candle.c, candle.v);
    }
  }
}

/** Reset every kernel and replay the whole closed history (O(ring), rare). */
export function rebuildAll(instances: Iterable<FeedInstance>, snap: CandleSnapshot): void {
  const list = [...instances];
  for (const inst of list) {
    inst.kernel.reset();
    for (const r of inst.rings) r.fill(Number.NaN);
    inst.lastFedBi = -1;
    inst.lastClose = Number.NaN;
  }
  feedNew(list, snap);
}

/** Score the forming (newest) candle into the rings WITHOUT committing it. */
export function peekForming(instances: Iterable<FeedInstance>, snap: CandleSnapshot): void {
  const cs = snap.candles;
  if (cs.length === 0) return;
  const forming = cs[cs.length - 1];
  for (const inst of instances) {
    const values = inst.kernel.peek({
      o: forming.o,
      h: forming.h,
      l: forming.l,
      c: forming.c,
      v: forming.v,
    });
    const slot = forming.bi % SLOT_CAP;
    for (let k = 0; k < inst.rings.length; k += 1) {
      const v = values[k];
      inst.rings[k][slot] = v === null || !Number.isFinite(v) ? Number.NaN : v;
    }
  }
}

/**
 * True when the fed history is stale beyond appending: a timeframe or session
 * change, or a merge into an already-fed closed bucket (a late print revising it,
 * or a bucket created inside the fed span). Three counter reads, O(1).
 */
export function needsRebuild(prev: CandleSnapshot, next: CandleSnapshot): boolean {
  return (
    prev.timeframeNs !== next.timeframeNs ||
    prev.sessionEpoch !== next.sessionEpoch ||
    prev.closedRevision !== next.closedRevision
  );
}
