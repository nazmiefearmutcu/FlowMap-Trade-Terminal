import { describe, expect, it } from 'vitest';

import { fmtTime } from './Crosshair';
import { formatSizeReadout } from '../i18n/format';

describe('formatSizeReadout', () => {
  it('renders "—" for null and undefined', () => {
    expect(formatSizeReadout(null)).toBe('—');
    expect(formatSizeReadout(undefined)).toBe('—');
  });

  // A non-finite (f16-overflowed / over-range) bucket must never read
  // as a fabricated number — it shows the honest glyph, not "Infinity"/"NaN".
  it('shows the ∞ glyph for +Infinity, never "Infinity"', () => {
    expect(formatSizeReadout(Infinity)).toBe('∞');
  });

  it('shows "—" for NaN, never "NaN"', () => {
    expect(formatSizeReadout(NaN)).toBe('—');
  });

  it('shows "—" for -Infinity', () => {
    expect(formatSizeReadout(-Infinity)).toBe('—');
  });

  it('keeps the small-size decimal bands', () => {
    expect(formatSizeReadout(0)).toBe('0');
    expect(formatSizeReadout(1.234)).toBe('1.23');
    expect(formatSizeReadout(12.5)).toBe('12.50');
    expect(formatSizeReadout(150.4)).toBe('150.4');
  });

  it('groups thousands in the 1e3..1e4 band', () => {
    expect(formatSizeReadout(1000)).toBe('1K');
    expect(formatSizeReadout(9999)).toBe('10K');
  });

  it('compacts to K past 10k and M past 1e6', () => {
    expect(formatSizeReadout(10_000)).toBe('10K');
    expect(formatSizeReadout(12_500)).toBe('12.5K');
    expect(formatSizeReadout(250_000)).toBe('250K');
    expect(formatSizeReadout(1_500_000)).toBe('1.5M');
    expect(formatSizeReadout(12_000_000)).toBe('12M');
  });
});

describe('fmtTime', () => {
  it('renders "—" for null', () => {
    expect(fmtTime(null)).toBe('—');
  });

  it('renders HH:MM:SS.mmm with an explicit UTC "z" suffix', () => {
    // 2021-01-01T00:00:01.500Z → 1_609_459_201_500 ms → ns
    const ns = 1_609_459_201_500n * 1_000_000n;
    expect(fmtTime(ns)).toBe('00:00:01.500 UTC');
  });

  it('reads a session-relative sim time as the T+ clock with no zone label, whatever the zone setting', () => {
    const fiveSeconds = 5_000_000_000n;
    expect(fmtTime(fiveSeconds, 'local', 'America/New_York', true)).toBe('00:00:05.000');
    expect(fmtTime(fiveSeconds, 'exchange', 'America/New_York', true)).toBe('00:00:05.000');
  });
});
