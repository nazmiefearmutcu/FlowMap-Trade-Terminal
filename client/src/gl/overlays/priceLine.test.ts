import { describe, expect, it } from 'vitest';

import type { BarColumn } from '../../proto/types';
import { PriceLine } from './priceLine';

/** A BarColumn carrying only the fields the price line reads. */
function bar(colSeq: number, o: number, h: number, l: number, c: number): BarColumn {
  return { epoch: 0, col_seq: colSeq, t0_ns: BigInt(colSeq), o, h, l, c } as unknown as BarColumn;
}

describe('PriceLine.priceRange', () => {
  it('spans the wicks of the columns inside the window', () => {
    const line = new PriceLine();
    line.add(bar(1, 100, 101, 99, 100.5));
    line.add(bar(2, 100.5, 104, 100, 103));
    line.add(bar(3, 103, 110, 102, 105));
    expect(line.priceRange(1, 2)).toEqual({ low: 99, high: 104 });
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 110 });
  });

  it('returns null for a window with no closes', () => {
    const line = new PriceLine();
    expect(line.priceRange(0, 10)).toBeNull();
    line.add(bar(5, 100, 101, 99, 100));
    expect(line.priceRange(0, 4)).toBeNull();
  });

  it('answers the same window from its memo until the stored closes change', () => {
    const line = new PriceLine();
    line.add(bar(1, 100, 101, 99, 100));
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 101 });
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 101 });

    line.add(bar(2, 100, 120, 100, 118));
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 120 });
  });

  it('forgets pruned columns and everything after reset', () => {
    const line = new PriceLine();
    line.add(bar(1, 100, 150, 90, 100));
    line.add(bar(2, 100, 101, 99, 100));
    expect(line.priceRange(0, 10)).toEqual({ low: 90, high: 150 });

    line.prune(2, 2);
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 101 });

    line.reset();
    expect(line.priceRange(0, 10)).toBeNull();
  });

  it('hands out a copy, so a caller cannot corrupt the memo', () => {
    const line = new PriceLine();
    line.add(bar(1, 100, 101, 99, 100));
    const first = line.priceRange(0, 10);
    if (first === null) throw new Error('expected a range');
    first.high = 1;
    expect(line.priceRange(0, 10)).toEqual({ low: 99, high: 101 });
  });
});
