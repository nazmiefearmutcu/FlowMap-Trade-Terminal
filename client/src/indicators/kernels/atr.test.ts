/**
 * Streaming ATR kernel: textbook true range over real candle ranges, Wilder
 * smoothing identical to the reference implementation's close-only ATR. Verified against a
 * naive reference plus a hand-derived sequence.
 */

import { describe, expect, it } from 'vitest';

import { createAtr } from './atr';
import type { CandleInput } from './types';

/** candles: [h, l, c] triples with v=o=0 (ATR ignores volume). */
function hlc(triples: [number, number, number][]): CandleInput[] {
  return triples.map(([h, l, c]) => ({ o: 0, h, l, c, v: 0 }));
}

/** Naive Wilder ATR reference over explicit TRs. */
function naive(triples: [number, number, number][], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(triples.length).fill(null);
  if (triples.length <= period) return out;
  const trs: number[] = [];
  for (let i = 1; i < triples.length; i += 1) {
    const h = triples[i][0];
    const l = triples[i][1];
    const pc = triples[i - 1][2];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period; i < trs.length; i += 1) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

describe('atr kernel (14 default, hand cases use 2/3)', () => {
  it('hand-derived: ranges only, then gaps vs prev close', () => {
    // Triples [h,l,c]: candle 0 [12,10,11] plants prevClose (no TR);
    // candle 1 [11,10,10] TR = max(1, |11−11|, |10−11|) = 1;
    // candle 2 [14,10,12] TR = max(4, |14−10|, |10−10|) = 4.
    // Period 2: seed (1+4)/2 = 2.5 at the second TR.
    const k = createAtr(2);
    const got = hlc([
      [12, 10, 11],
      [11, 10, 10],
      [14, 10, 12],
    ]).map((c) => k.push(c)[0]);
    expect(got).toEqual([null, null, 2.5]);
  });

  it('matches the naive Wilder reference on a mixed series', () => {
    const triples: [number, number, number][] = [
      [105, 100, 104],
      [104, 99, 100],
      [103, 98, 102],
      [108, 101, 107],
      [107, 103, 104],
      [106, 100, 105],
      [110, 104, 109],
      [109, 105, 106],
    ];
    const k = createAtr(3);
    const got = hlc(triples).map((c) => k.push(c)[0]);
    const want = naive(triples, 3);
    for (let i = 0; i < want.length; i += 1) {
      if (want[i] === null) expect(got[i]).toBeNull();
      else expect(got[i]).toBeCloseTo(want[i] as number, 12);
    }
  });

  it('first candle produces no TR; short series stay null', () => {
    const k = createAtr(5);
    expect(hlc([[12, 10, 11]]).map((c) => k.push(c)[0])).toEqual([null]);
    const k2 = createAtr(3);
    expect(
      hlc([
        [12, 10, 11],
        [12, 10, 11],
        [12, 10, 11],
      ]).map((c) => k2.push(c)[0]),
    ).toEqual([null, null, null]);
  });

  it('a single NaN candle is skipped and the line recovers', () => {
    const k = createAtr(1);
    expect(k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 })[0]).toBeNull(); // no prev close yet
    expect(k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 })[0]).toBe(2);
    expect(k.push({ o: 0, h: Number.NaN, l: 10, c: 11, v: 0 })[0]).toBeNull(); // the bad bar is a gap
    // The prev close (11) and the Wilder state survived: the next valid bar is
    // TR = max(4, |14-11|, |10-11|) = 4, avg = 4, not a dead line.
    expect(k.push({ o: 0, h: 14, l: 10, c: 12, v: 0 })[0]).toBe(4);
    k.reset();
    expect(k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 })[0]).toBeNull();
    expect(k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 })[0]).toBe(2);
  });

  it('a NaN close never becomes the previous close (the next TR stays finite)', () => {
    const k = createAtr(1);
    k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 });
    expect(k.push({ o: 0, h: 12, l: 10, c: Number.NaN, v: 0 })[0]).toBe(2);
    // prev close is still 11 (not NaN): TR = max(2, |13-11|, |11-11|) = 2.
    expect(k.push({ o: 0, h: 13, l: 11, c: 12, v: 0 })[0]).toBe(2);
  });

  it('a carry-forward run holds the ATR and does not count toward the period', () => {
    const k = createAtr(2);
    k.push({ o: 0, h: 11, l: 9, c: 10, v: 0 }); // seeds the previous close
    expect(k.push({ o: 0, h: 12, l: 10, c: 12, v: 0 })[0]).toBeNull(); // TR 2, one of two
    expect(k.push({ o: 0, h: 14, l: 12, c: 13, v: 0 })[0]).toBe(2); // TR 2, seeds avg 2
    // Three empty buckets at the previous close (13): no range, the ATR holds at 2.
    for (let i = 0; i < 3; i += 1) {
      expect(k.push({ o: 13, h: 13, l: 13, c: 13, v: 0, carry: true })[0]).toBe(2);
    }
    // The next real bar still measures from the close 13: TR = max(3, 3, 0) = 3.
    expect(k.push({ o: 13, h: 16, l: 13, c: 15, v: 0 })[0]).toBeCloseTo(2.5, 12);
    // A carry-forward bar during warm-up stays a gap, never a value.
    const warm = createAtr(3);
    warm.push({ o: 0, h: 11, l: 9, c: 10, v: 0 });
    expect(warm.push({ o: 10, h: 10, l: 10, c: 10, v: 0, carry: true })[0]).toBeNull();
  });

  it('a carry-forward bar peeks as the held value and never moves the state', () => {
    const k = createAtr(1);
    k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 });
    k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 }); // avg 2
    expect(k.peek({ o: 11, h: 11, l: 11, c: 11, v: 0, carry: true })[0]).toBe(2);
    expect(k.push({ o: 0, h: 14, l: 10, c: 12, v: 0 })[0]).toBe(4); // unchanged by the peek
  });

  it('rejects invalid periods; peek does not commit', () => {
    expect(() => createAtr(0)).toThrow(RangeError);
    const k = createAtr(1);
    k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 });
    k.push({ o: 0, h: 12, l: 10, c: 11, v: 0 }); // avg seeded at 2
    expect(k.peek({ o: 0, h: 14, l: 10, c: 12, v: 0 })[0]).toBe(4); // (2·0 + 4)/1
    expect(k.peek({ o: 0, h: 14, l: 10, c: 12, v: 0 })[0]).toBe(4);
    expect(k.push({ o: 0, h: 14, l: 10, c: 12, v: 0 })[0]).toBe(4); // committed once
  });
});
