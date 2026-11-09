import { describe, expect, it } from 'vitest';

import { clamp, priceDecimals } from './numeric';

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

describe('priceDecimals', () => {
  it('derives the decimals a price step needs', () => {
    expect(priceDecimals(1)).toBe(0);
    expect(priceDecimals(5)).toBe(0);
    expect(priceDecimals(0.5)).toBe(1);
    expect(priceDecimals(2.5)).toBe(1);
    expect(priceDecimals(0.25)).toBe(2);
    expect(priceDecimals(0.01)).toBe(2);
    expect(priceDecimals(0.0001)).toBe(4);
  });

  it('grows past the old 8-decimal cap for sub-1e-8 steps, so tiny prices stay honest', () => {
    expect(priceDecimals(1e-8)).toBe(8);
    expect(priceDecimals(1e-9)).toBe(9);
    expect(priceDecimals(1.2e-9)).toBe(10);
    expect((1.2e-9).toFixed(priceDecimals(1.2e-9))).toBe('0.0000000012');
    // A defensive ceiling so a pathological step cannot print an endless string.
    expect(priceDecimals(1e-15)).toBe(12);
  });

  it('ignores float noise in a nice step', () => {
    expect(priceDecimals(0.0300000001)).toBe(2);
  });

  it('falls back to two places for a step that is not a positive finite number', () => {
    expect(priceDecimals(0)).toBe(2);
    expect(priceDecimals(-1)).toBe(2);
    expect(priceDecimals(Number.NaN)).toBe(2);
    expect(priceDecimals(Number.POSITIVE_INFINITY)).toBe(2);
  });
});
