import { describe, expect, it } from 'vitest';

import { clamp } from './numeric';

describe('clamp', () => {
  it('bounds a value into the closed interval', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(4, 0, 10)).toBe(4);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('passes NaN through, as the comparisons leave it unchanged', () => {
    expect(Number.isNaN(clamp(Number.NaN, 0, 10))).toBe(true);
  });
});

