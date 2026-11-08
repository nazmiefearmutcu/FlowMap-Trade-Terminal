import { describe, expect, it } from 'vitest';

import { alertPriceText } from './alertPrice';

describe('alertPriceText (shared level format)', () => {
  it('keeps two places at least and never groups digits', () => {
    expect(alertPriceText(75759.5)).toBe('75759.50');
    expect(alertPriceText(100)).toBe('100.00');
    expect(alertPriceText(0.1)).toBe('0.10');
    expect(alertPriceText(1234567.891)).toBe('1234567.891');
  });

  it('keeps sub-cent precision a fixed 8-place cap used to cut', () => {
    expect(alertPriceText(0.000000001234)).toBe('0.000000001234');
    expect(alertPriceText(0.00001234)).toBe('0.00001234');
  });

  it('caps at twelve places and rounds beyond them', () => {
    expect(alertPriceText(1 / 3)).toBe('0.333333333333');
  });

  it('prints a level below 1e-12 with its own digits, never as 0.00', () => {
    // Fixed twelve places collapsed these to "0.00" (misleading for ultra-low tokens).
    expect(alertPriceText(1e-13)).toBe('0.0000000000001');
    expect(alertPriceText(1.5e-13)).toBe('0.00000000000015');
    expect(alertPriceText(2.5e-15)).toBe('0.0000000000000025');
  });

  it('keeps an exponent only where no fixed form exists', () => {
    expect(alertPriceText(1e21)).toBe('1e+21');
  });

  it('is a dash for non-finite values', () => {
    expect(alertPriceText(Number.NaN)).toBe('—');
    expect(alertPriceText(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
