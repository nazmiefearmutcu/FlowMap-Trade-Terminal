/**
 * ATR kernel — Wilder's Average True Range over real candle ranges.
 *
 * Unlike the reference implementation (a close-only fallback, its feed carrying no h/l), the
 * candle stream has a real range, so this is the TEXTBOOK true range:
 *   TR = max(h − l, |h − cPrev|, |l − cPrev|)
 * seeded with the SMA of the first `period` TRs and advanced with the Wilder
 * recurrence — the identical smoothing the old ATR applied. A bad candle (a
 * non-finite high, low or previous close makes TR NaN) is SKIPPED: its output is
 * null, the Wilder state is kept, and the previous close only advances on a
 * finite close. One bad print therefore leaves a gap, not a dead line.
 * ±Inf propagates as Infinity. O(1) per push.
 *
 * A carry-forward bar (`carry`, an empty bucket) has no range and does not move the
 * close, so it is not a true-range bar: the ATR holds its value through it.
 */

import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

export function createAtr(period: number): IndicatorKernel {
  intParam('period', period, 1);
  let prevClose: number | null = null;
  let trs = 0;
  let sumTR = 0;
  let avg = 0;
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    if (c.carry === true) {
      // An empty bucket is not a bar: it has no true range and does not move the
      // close. The ATR holds its last value through it (null while still warming up).
      out[0] = trs >= period ? avg : null;
      return out;
    }
    const pc = prevClose;
    const closeOk = Number.isFinite(c.c);
    if (pc === null) {
      // The first candle has no previous close → no TR.
      if (commit && closeOk) prevClose = c.c;
      out[0] = null;
      return out;
    }
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    if (Number.isNaN(tr)) {
      // Skipped bar: no TR, no state change, and a NaN close never becomes the prev close.
      out[0] = null;
      return out;
    }
    if (commit && closeOk) prevClose = c.c;
    if (trs < period) {
      const n = trs + 1;
      const s = sumTR + tr;
      if (commit) {
        trs = n;
        sumTR = s;
        if (n === period) avg = s / period;
      }
      out[0] = n === period ? s / period : null;
      return out;
    }
    const a = (avg * (period - 1) + tr) / period;
    if (commit) avg = a;
    out[0] = a;
    return out;
  }

  return {
    outputKeys: ['atr'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      prevClose = null;
      trs = 0;
      sumTR = 0;
      avg = 0;
    },
  };
}
