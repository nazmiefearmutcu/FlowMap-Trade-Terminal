import { describe, expect, it } from 'vitest';

import { toBigNs } from './bigNs';

describe('toBigNs', () => {
  it('passes a bigint through unchanged', () => {
    expect(toBigNs(1_700_000_000_123_456_789n)).toBe(1_700_000_000_123_456_789n);
  });

  it('rounds a small integer number to the nearest ns', () => {
    expect(toBigNs(42)).toBe(42n);
    expect(toBigNs(2.6)).toBe(3n);
  });

  it('maps a non-finite number to zero rather than throwing', () => {
    expect(toBigNs(Number.NaN)).toBe(0n);
    expect(toBigNs(Number.POSITIVE_INFINITY)).toBe(0n);
  });
});
