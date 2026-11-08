import { describe, expect, it } from 'vitest';

import { MsgType, type BarColumn } from '../proto/types';
import { isRepeatBar } from './barGate';

function bar(overrides: Partial<BarColumn> = {}): BarColumn {
  return {
    type: MsgType.BAR_COL,
    epoch: 1,
    col_seq: 42,
    t0_ns: 1_000_000_000n,
    o: 100,
    h: 101,
    l: 99.5,
    c: 100.5,
    vol_buy: 3,
    vol_sell: 2,
    cvd_cum: 1,
    vwap_num_cum: 10_000,
    vwap_den_cum: 100,
    ...overrides,
  };
}

describe('isRepeatBar', () => {
  it('never treats the first bar as a repeat', () => {
    expect(isRepeatBar(null, bar())).toBe(false);
  });

  it('recognises a byte-identical re-send of the forming bar', () => {
    expect(isRepeatBar(bar(), bar())).toBe(true);
  });

  it.each([
    ['a new column', { col_seq: 43 }],
    ['a new epoch', { epoch: 2 }],
    ['a new open time', { t0_ns: 1_000_000_001n }],
    ['a higher high', { h: 101.25 }],
    ['a lower low', { l: 99.25 }],
    ['a moved close', { c: 100.75 }],
    ['a buy-volume print', { vol_buy: 3.5 }],
    ['a sell-volume print', { vol_sell: 2.5 }],
    ['a cumulative delta step', { cvd_cum: 1.5 }],
    ['a VWAP numerator step', { vwap_num_cum: 10_001 }],
    ['a VWAP denominator step', { vwap_den_cum: 101 }],
  ])('treats %s as a change', (_label, change) => {
    expect(isRepeatBar(bar(), bar(change))).toBe(false);
  });

  it('repeats a NaN field as NaN', () => {
    expect(isRepeatBar(bar({ c: Number.NaN }), bar({ c: Number.NaN }))).toBe(true);
  });
});
