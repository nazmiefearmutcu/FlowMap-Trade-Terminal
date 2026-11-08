/**
 * Shared display formatters: price precision, compact sizes, locale
 * numbers, the time-zone preference, and the document language.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from './index';
import {
  TIME_ZONE_STORAGE_KEY,
  exchangeZoneFor,
  formatClock,
  formatDateTime,
  formatFixed,
  formatNumber,
  formatPrice,
  formatSizeCompact,
  formatSizeReadout,
  getTimeZonePref,
  initTimeZonePref,
  setTimeZonePref,
  zonedWallText,
  zonedWallToNs,
  zoneLabel,
} from './format';

afterEach(() => {
  setLocale('en');
  setTimeZonePref('local');
  localStorage.clear();
});

describe('formatPrice — one price text on every surface', () => {
  it('prints at the requested decimals with no digit grouping', () => {
    expect(formatPrice(75761.99, 2)).toBe('75761.99');
    expect(formatPrice(64000, 2)).toBe('64000.00');
    expect(formatPrice(5234.25, 2)).toBe('5234.25');
  });

  it('keeps the decimal point even in Turkish, so panels match', () => {
    setLocale('tr');
    expect(formatPrice(75761.99, 2)).toBe('75761.99');
  });

  it('returns an em dash for missing or non-finite prices', () => {
    expect(formatPrice(Number.NaN, 2)).toBe('—');
    expect(formatPrice(Number.POSITIVE_INFINITY, 2)).toBe('—');
  });
});

describe('formatFixed — non-price decimals follow the UI locale', () => {
  it('uses a point in English and a comma in Turkish', () => {
    expect(formatFixed(4, 2)).toBe('4.00');
    expect(formatFixed(12.345, 1)).toBe('12.3');
    setLocale('tr');
    expect(formatFixed(4, 2)).toBe('4,00');
    expect(formatFixed(-2.5, 1)).toBe('-2,5');
  });

  it('rounds to the requested digits and never groups thousands', () => {
    expect(formatFixed(1234.5, 0)).toBe('1235');
    expect(formatFixed(0.05, 1)).toBe('0.1');
  });

  it('returns an em dash for non-finite values and clamps bad digit counts', () => {
    expect(formatFixed(Number.NaN, 2)).toBe('—');
    expect(formatFixed(3, Number.NaN)).toBe('3');
    expect(formatFixed(3.7, -4)).toBe('4');
  });

  it('carries the locale decimal into the compact size text', () => {
    setLocale('tr');
    expect(formatSizeCompact(1234)).toBe('1,2K');
    expect(formatSizeCompact(150)).toBe('150,0');
    expect(formatSizeCompact(42.5)).toBe('42,50');
    expect(formatSizeCompact(2000)).toBe('2K');
    expect(formatSizeCompact(999_960)).toBe('1M');
  });
});

describe('formatSizeCompact — rounds before choosing the unit', () => {
  it('reads 999,960 as 1M, never the boundary artefact 1000K', () => {
    expect(formatSizeCompact(999_960)).toBe('1M');
    expect(formatSizeCompact(999_940)).toBe('999.9K');
  });

  it('keeps the historical ladder everywhere else', () => {
    expect(formatSizeCompact(2000)).toBe('2K');
    expect(formatSizeCompact(1234)).toBe('1.2K');
    expect(formatSizeCompact(150)).toBe('150.0');
    expect(formatSizeCompact(42.5)).toBe('42.50');
    expect(formatSizeCompact(3_400_000_000)).toBe('3.4B');
  });

  it('rounds a value that would print as 1000 below the K tier up to 1K', () => {
    expect(formatSizeCompact(999.96)).toBe('1K');
    expect(formatSizeCompact(999.99)).toBe('1K');
    expect(formatSizeCompact(999.94)).toBe('999.9');
    setLocale('tr');
    expect(formatSizeCompact(999.96)).toBe('1K');
    expect(formatSizeCompact(999.4)).toBe('999,4');
  });

  it('shows an honest over-range glyph and nothing for empty sizes', () => {
    expect(formatSizeCompact(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatSizeCompact(0)).toBe('');
    expect(formatSizeCompact(Number.NaN)).toBe('');
  });

  it('never prints a real positive size as a bare 0.00', () => {
    expect(formatSizeCompact(0.004)).toBe('<0.01');
    expect(formatSizeCompact(0.001)).toBe('<0.01');
    expect(formatSizeCompact(0.005)).toBe('0.01');
    setLocale('tr');
    expect(formatSizeCompact(0.001)).toBe('<0,01');
  });
});

describe('formatSizeReadout — one readout for the crosshair, BBO badge and ladder', () => {
  it('shows an em dash for a missing size and a zero for an empty one', () => {
    expect(formatSizeReadout(null)).toBe('—');
    expect(formatSizeReadout(undefined)).toBe('—');
    expect(formatSizeReadout(Number.NaN)).toBe('—');
    expect(formatSizeReadout(0)).toBe('0');
  });

  it('shows the infinity sign for an over-range density', () => {
    expect(formatSizeReadout(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatSizeReadout(Number.NEGATIVE_INFINITY)).toBe('—');
  });

  it('rounds a size that would print as 1000.0 up to 1K', () => {
    expect(formatSizeReadout(999.96)).toBe('1K');
    expect(formatSizeReadout(999.96)).not.toBe('1000.0');
  });

  it('uses the locale decimal separator and the compact tiers otherwise', () => {
    expect(formatSizeReadout(42.5)).toBe('42.50');
    expect(formatSizeReadout(1234)).toBe('1.2K');
    setLocale('tr');
    expect(formatSizeReadout(42.5)).toBe('42,50');
    expect(formatSizeReadout(1234)).toBe('1,2K');
    expect(formatSizeReadout(0.001)).toBe('<0,01');
  });
});

describe('formatNumber — follows the UI locale', () => {
  it('uses en-US grouping in English and tr-TR grouping in Turkish', () => {
    expect(formatNumber(1234)).toBe('1,234');
    setLocale('tr');
    expect(formatNumber(1234)).toBe('1.234');
  });

  it('is an em dash for non-finite values', () => {
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('matches a freshly built formatter for every locale and option set', () => {
    const options: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false };
    for (const [locale, tag] of [['en', 'en-US'], ['tr', 'tr-TR']] as const) {
      setLocale(locale);
      for (let i = 0; i < 3; i++) {
        expect(formatNumber(12345.678, options)).toBe(new Intl.NumberFormat(tag, options).format(12345.678));
        expect(formatNumber(12345.678)).toBe(new Intl.NumberFormat(tag).format(12345.678));
      }
    }
  });
  it('builds one formatter for a locale and option set, not one per call', () => {
    const construct = vi.spyOn(Intl, 'NumberFormat');
    try {
      const options: Intl.NumberFormatOptions = { maximumFractionDigits: 7, useGrouping: false };
      for (let i = 0; i < 50; i++) formatNumber(i + 0.5, options);
      expect(construct).toHaveBeenCalledTimes(1);
    } finally {
      construct.mockRestore();
    }
  });
});

describe('formatDateTime', () => {
  it('returns an em dash for an invalid instant instead of throwing', () => {
    expect(formatDateTime(Number.NaN, { month: 'short' })).toBe('—');
    expect(formatDateTime(8.64e15 * 10, { month: 'short' })).toBe('—');
  });
});

describe('document language follows the UI locale', () => {
  it('sets <html lang> on every locale switch', () => {
    setLocale('tr');
    expect(document.documentElement.lang).toBe('tr');
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('time-zone preference', () => {
  const NOON_UTC = Date.UTC(2026, 0, 15, 12, 30, 5);

  it('defaults to the system zone', () => {
    expect(getTimeZonePref()).toBe('local');
  });

  it('formats the same instant in UTC and in the exchange zone', () => {
    expect(formatClock(NOON_UTC, 'utc')).toBe('12:30:05');
    // January: New York is UTC-5 (EST).
    expect(formatClock(NOON_UTC, 'exchange', exchangeZoneFor('equity'))).toBe('07:30:05');
    // Crypto's exchange clock is UTC.
    expect(formatClock(NOON_UTC, 'exchange', exchangeZoneFor('crypto'))).toBe('12:30:05');
  });

  it('adds a millisecond suffix when asked', () => {
    expect(formatClock(NOON_UTC + 234, 'utc', 'UTC', true)).toBe('12:30:05.234');
  });

  it('labels the zone it actually prints', () => {
    expect(zoneLabel('utc')).toBe('UTC');
    expect(zoneLabel('exchange', exchangeZoneFor('crypto'))).toBe('UTC');
    expect(zoneLabel('exchange', exchangeZoneFor('equity'), NOON_UTC)).not.toBe('UTC');
  });

  it('persists the choice and restores it on boot', () => {
    setTimeZonePref('utc');
    expect(localStorage.getItem(TIME_ZONE_STORAGE_KEY)).toBe('utc');
    setTimeZonePref('local');
    expect(initTimeZonePref()).toBe('local'); // nothing stored changes nothing
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'utc');
    expect(initTimeZonePref()).toBe('utc');
  });

  it('restores a stored preference when the module loads', async () => {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'exchange');
    vi.resetModules();
    const fresh = await import('./format');
    expect(fresh.getTimeZonePref()).toBe('exchange');
  });

  it('ignores a garbage stored value', () => {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'Mars/Olympus');
    expect(initTimeZonePref()).toBe('local');
  });
});

describe('zoned wall-clock text for datetime-local inputs', () => {
  const NOON_UTC = Date.UTC(2026, 0, 15, 12, 30, 5, 234);

  it('reads an instant as wall-clock text in the zone', () => {
    expect(zonedWallText(NOON_UTC, 'UTC')).toBe('2026-01-15T12:30:05.234');
    expect(zonedWallText(NOON_UTC, 'America/New_York')).toBe('2026-01-15T07:30:05.234');
    expect(zonedWallText(NOON_UTC, 'Asia/Istanbul')).toBe('2026-01-15T15:30:05.234');
    const localNoon = new Date(2026, 2, 1, 9, 15, 0, 5).getTime();
    expect(zonedWallText(localNoon, undefined)).toBe('2026-03-01T09:15:00.005');
  });

  it('parses wall text back to the exact instant in the same zone', () => {
    expect(zonedWallToNs('2026-01-15T07:30:05.234', 'America/New_York')).toBe(BigInt(NOON_UTC) * 1_000_000n);
    // July is EDT (UTC-4): 08:00 New York is 12:00 UTC.
    expect(zonedWallToNs('2026-07-15T08:00', 'America/New_York')).toBe(BigInt(Date.UTC(2026, 6, 15, 12)) * 1_000_000n);
    expect(zonedWallToNs('2026-01-15T15:30', 'Asia/Istanbul')).toBe(BigInt(Date.UTC(2026, 0, 15, 12, 30)) * 1_000_000n);
  });

  it('round-trips through the system zone', () => {
    const local = new Date(2026, 2, 1, 9, 15, 0, 5).getTime();
    expect(zonedWallToNs(zonedWallText(local, undefined), undefined)).toBe(BigInt(local) * 1_000_000n);
  });

  it('rejects text that is not a real wall time in the zone', () => {
    for (const bad of ['', 'nonsense', '2026-02-30T12:00', '2026-13-01T00:00', '2026-11-01T25:00', '2026-11-01T06:30Z']) {
      expect(zonedWallToNs(bad, 'UTC'), bad).toBeNull();
    }
    // 02:30 on 8 March 2026 does not exist in New York: the clocks jump from 02:00 to 03:00.
    expect(zonedWallToNs('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });
});
