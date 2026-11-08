import { describe, expect, it } from 'vitest';

import { createRolling } from './rolling';

describe('rolling sums', () => {
  it('track a naive window over many pushes, across the periodic resync', () => {
    const period = 5;
    const r = createRolling(period);
    const xs: number[] = [];
    let st = r.add(0, false);
    for (let i = 0; i < period * 64 * 3 + 7; i += 1) {
      const x = Math.sin(i) * 1e6 + 0.1 * i;
      xs.push(x);
      st = r.add(x, true);
    }
    const win = xs.slice(-period);
    const sum = win.reduce((a, b) => a + b, 0);
    const sumsq = win.reduce((a, b) => a + b * b, 0);
    expect(Math.abs(st.sum - sum)).toBeLessThan(1e-4);
    expect(Math.abs(st.sumsq - sumsq) / sumsq).toBeLessThan(1e-9);
    expect(st.full).toBe(true);
  });
});
