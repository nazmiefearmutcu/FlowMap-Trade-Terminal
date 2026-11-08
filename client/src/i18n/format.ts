/**
 * Shared display formatters.
 *
 * One place decides how numbers, prices, sizes, dates and clock times look, so
 * the same value reads the same on every surface:
 *   - PRICES are never digit-grouped and always use a '.' decimal point. They
 *     are printed at the venue tick's precision (see `formatPrice`), so the top
 *     bar, DOM ladder, price axis, tape and search preview agree character for
 *     character. Grouping separators differ by locale ('75,759' vs '75.759'), so
 *     grouping a price would make the same number look different on each panel.
 *   - SIZES / COUNTS / VOLUMES follow the UI locale (`formatNumber`) or the
 *     compact SI form (`formatSizeCompact`) for resting size. Non-price decimals
 *     (percentages, rates, seconds) use `formatFixed`, so Turkish reads `4,00`.
 *   - CLOCK times follow the time-zone preference (`formatClock`): local,
 *     UTC or the instrument's exchange zone. The preference is persisted in
 *     localStorage `flowmap.timeZone` and is shared by every clock on screen.
 */

import { getLocale } from './index';
import { useSyncExternalStore } from 'react';

/** BCP-47 tag for the active UI locale (number and date conventions). */
export function intlLocale(): string {
  return getLocale() === 'tr' ? 'tr-TR' : 'en-US';
}

/**
 * One NumberFormat per locale and option set. The tape and the DOM ladder format
 * on every book flush, and building a formatter costs far more than using one.
 * The option sets come from a small fixed set of call sites; the cap only stops
 * an unexpected caller from growing the map without bound.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const NUMBER_FORMAT_CACHE_LIMIT = 64;

/** Locale-aware number (grouping and decimal separators follow the UI locale). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '—';
  try {
    const locale = intlLocale();
    const key = `${locale}|${options === undefined ? '' : JSON.stringify(options)}`;
    let format = numberFormats.get(key);
    if (format === undefined) {
      if (numberFormats.size >= NUMBER_FORMAT_CACHE_LIMIT) numberFormats.clear();
      format = new Intl.NumberFormat(locale, options);
      numberFormats.set(key, format);
    }
    return format.format(value);
  } catch {
    return String(value);
  }
}

/** Locale-aware date/time for an epoch-millisecond instant. */
export function formatDateTime(ms: number, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(ms);
  if (!Number.isFinite(ms) || !Number.isFinite(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(intlLocale(), options).format(date);
  } catch {
    return '—';
  }
}

/**
 * Price text at a fixed number of decimals. Deliberately NOT locale-grouped and
 * always '.'-decimal: see the module comment. `decimals` comes from the venue
 * tick (`priceDecimals` in ui/DomLadder, `quoteDecimals` in gl/overlays/axisTicks).
 */
export function formatPrice(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const d = Number.isFinite(decimals) ? Math.min(20, Math.max(0, Math.trunc(decimals))) : 2;
  return value.toFixed(d);
}

/**
 * Fixed-decimal text for a NON-price quantity: a percentage, a rate per second,
 * a duration in seconds. Uses the UI locale's decimal separator (`4,00` in
 * Turkish, `4.00` in English) and never groups digits, so a panel's decimals
 * read the same way as its words. Prices keep {@link formatPrice}.
 */
export function formatFixed(value: number, digits: number): string {
  const d = Number.isFinite(digits) ? Math.min(20, Math.max(0, Math.trunc(digits))) : 0;
  return formatNumber(value, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
}

/**
 * Compact resting-size text, rounding FIRST and then choosing the suffix, so a
 * value that rounds up to 1000 moves to the next unit: 999,960 reads `1M`, not
 * `1000K`. Matches the DOM ladder's historical output everywhere else
 * (2000 → `2K`, 1234 → `1.2K`, 42.5 → `42.50`, 150 → `150.0`).
 */
export function formatSizeCompact(v: number): string {
  // Never render raw "Infinity"/"NaN": a non-finite density is over-range.
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '';
  if (v <= 0) return '';
  if (v < 1e3) {
    // Rounding first, as below: 999.96 at one decimal is 1000.0, which reads as 1K.
    const digits = v >= 100 ? 1 : 2;
    const rounded = Number(v.toFixed(digits));
    // A real but tiny size would print as 0.00, which reads as no size at all.
    if (rounded === 0) return `<${formatFixed(0.01, 2)}`;
    return rounded < 1e3 ? formatFixed(v, digits) : formatSizeCompact(rounded);
  }
  const tiers: readonly (readonly [number, string])[] = [[1e3, 'K'], [1e6, 'M'], [1e9, 'B']];
  let idx = 0;
  for (let i = 1; i < tiers.length; i++) if (v >= tiers[i][0]) idx = i;
  // Rounding-first: this tier's one-decimal value would print as 1000 → step up.
  if (idx < tiers.length - 1 && Number((v / tiers[idx][0]).toFixed(1)) >= 1000) idx++;
  const [div, suffix] = tiers[idx];
  // The UI's decimal separator (`1,2K` in Turkish); a whole value drops its `.0`/`,0`.
  const s = formatFixed(v / div, 1);
  return s.replace(/[.,]0$/, '') + suffix;
}

/**
 * The resting-size readout shared by the crosshair, the measure tool and the BBO
 * badge: a missing value (null, undefined, NaN, -Infinity) is an em dash, an
 * over-range density is the infinity sign, zero is `0`, and anything else goes
 * through {@link formatSizeCompact} (a tiny positive size reads `<0.01`).
 */
export function formatSizeReadout(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '—';
  if (value === 0) return '0';
  return formatSizeCompact(value);
}

// ---------------------------------------------------------------------------
// Time-zone preference
// ---------------------------------------------------------------------------

/**
 * `local`    — the viewer's system zone (default).
 * `utc`      — Coordinated Universal Time.
 * `exchange` — the instrument's own reference zone: US Eastern for equities,
 *              UTC for 24/7 crypto (see {@link exchangeZoneFor}).
 */
export type TimeZonePref = 'local' | 'utc' | 'exchange';

export const TIME_ZONE_PREFS: readonly TimeZonePref[] = ['local', 'utc', 'exchange'];
export const TIME_ZONE_STORAGE_KEY = 'flowmap.timeZone';

export function isTimeZonePref(value: string | null | undefined): value is TimeZonePref {
  return value === 'local' || value === 'utc' || value === 'exchange';
}

/** The stored preference, or `local` when nothing valid is stored or storage is unavailable. */
function readStoredZonePref(): TimeZonePref {
  try {
    const stored = localStorage.getItem(TIME_ZONE_STORAGE_KEY);
    return isTimeZonePref(stored) ? stored : 'local';
  } catch {
    return 'local';
  }
}

// Restored at module load so every clock is right on the first paint, without
// relying on a boot call that the app shell has to remember to make.
let zonePref: TimeZonePref = readStoredZonePref();
const zoneListeners = new Set<() => void>();

/** The IANA zone an instrument's "exchange" clock reads in. */
export function exchangeZoneFor(group: string): string {
  return group === 'equity' ? 'America/New_York' : 'UTC';
}

export function getTimeZonePref(): TimeZonePref {
  return zonePref;
}

/** Switch the zone preference, persist it, and notify every clock. */
export function setTimeZonePref(pref: TimeZonePref): void {
  const next = isTimeZonePref(pref) ? pref : 'local';
  if (next === zonePref) return;
  zonePref = next;
  try {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, next);
  } catch {
    /* quota / private mode — the choice stays session-local */
  }
  zoneListeners.forEach((l) => l());
}

/** Boot call: restore the persisted zone preference. Safe to call repeatedly. */
export function initTimeZonePref(): TimeZonePref {
  try {
    const stored = localStorage.getItem(TIME_ZONE_STORAGE_KEY);
    if (isTimeZonePref(stored) && stored !== zonePref) {
      zonePref = stored;
      zoneListeners.forEach((l) => l());
    }
  } catch {
    /* storage unavailable — keep default */
  }
  return zonePref;
}

export function subscribeTimeZone(fn: () => void): () => void {
  zoneListeners.add(fn);
  return () => {
    zoneListeners.delete(fn);
  };
}

/** React binding: re-renders the caller whenever the zone preference changes. */
export function useTimeZone(): TimeZonePref {
  return useSyncExternalStore(subscribeTimeZone, getTimeZonePref);
}

/** IANA zone for a preference, or `undefined` for the system zone. */
export function resolveTimeZone(pref: TimeZonePref, exchangeZone: string): string | undefined {
  if (pref === 'local') return undefined;
  if (pref === 'utc') return 'UTC';
  return exchangeZone;
}

/** One formatter per zone (`''` is the system zone): every clock on screen formats on each tick. */
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `HH:MM:SS` (24-hour, optionally `.mmm`) for an epoch-millisecond instant in
 * the zone the preference resolves to. Falls back to UTC if the platform cannot
 * format the requested zone.
 */
export function formatClock(ms: number, pref: TimeZonePref, exchangeZone = 'UTC', withMs = false): string {
  if (!Number.isFinite(ms)) return '—';
  const zone = resolveTimeZone(pref, exchangeZone);
  let clock: string;
  try {
    const key = zone ?? '';
    let format = clockFormatters.get(key);
    if (format === undefined) {
      format = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      clockFormatters.set(key, format);
    }
    const parts = format.formatToParts(new Date(ms));
    clock = ['hour', 'minute', 'second']
      .map((type) => parts.find((p) => p.type === type)?.value ?? '00')
      .join(':');
  } catch {
    clock = new Date(ms).toISOString().substring(11, 19);
  }
  if (!withMs) return clock;
  const frac = ((Math.trunc(ms) % 1000) + 1000) % 1000;
  return `${clock}.${String(frac).padStart(3, '0')}`;
}

/** Two-digit or fixed-width zero padding for wall-clock fields. */
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

const WALL_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
};
/** One formatter per zone (`''` is the system zone): the pickers read many instants at once. */
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar and clock fields of an instant as read in a zone (`undefined` = the system zone). */
function wallFields(ms: number, zone: string | undefined): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const key = zone ?? '';
  let format = wallFormatters.get(key);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { ...WALL_OPTIONS, timeZone: zone });
    } catch {
      // The platform cannot format this zone: read UTC, as formatClock does.
      format = new Intl.DateTimeFormat('en-US', { ...WALL_OPTIONS, timeZone: 'UTC' });
    }
    wallFormatters.set(key, format);
  }
  const parts = format.formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: field('year'), month: field('month'), day: field('day'),
    hour: field('hour') % 24, minute: field('minute'), second: field('second'),
  };
}

/**
 * Wall-clock text of an epoch-millisecond instant in a zone, as the
 * `YYYY-MM-DDTHH:mm:ss.sss` form a `datetime-local` input uses. `zone` is an IANA
 * name, or `undefined` for the system zone (the `resolveTimeZone` result).
 */
export function zonedWallText(ms: number, zone: string | undefined): string {
  if (!Number.isFinite(ms)) return '';
  const f = wallFields(ms, zone);
  const frac = ((Math.trunc(ms) % 1000) + 1000) % 1000;
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}.${pad(frac, 3)}`;
}

const WALL_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Exact nanoseconds of a `datetime-local` wall-clock text read in a zone, the
 * inverse of {@link zonedWallText}. Returns null for anything that is not a real
 * wall time in that zone: a malformed or impossible date (2026-02-30), or a local
 * time skipped by a daylight-saving change. The round trip is the check, so a
 * result always reads back as exactly the text that was typed.
 */
export function zonedWallToNs(text: string, zone: string | undefined): bigint | null {
  const m = WALL_TEXT.exec(text);
  if (!m || Number(m[1]) < 1) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = Number(m[6] ?? 0);
  const millis = Number((m[7] ?? '0').padEnd(3, '0'));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const normalized = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millis, 3)}`;
  let instant: number;
  if (zone === undefined) {
    instant = new Date(year, month - 1, day, hour, minute, second, millis).getTime();
  } else {
    // The zone's offset at the candidate instant; two passes settle a DST boundary.
    const offset = (at: number): number => {
      const f = wallFields(at, zone);
      return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - (at - (((at % 1000) + 1000) % 1000));
    };
    instant = wall - offset(wall);
    instant = wall - offset(instant);
  }
  if (!Number.isFinite(instant) || zonedWallText(instant, zone) !== normalized) return null;
  return BigInt(instant) * 1_000_000n;
}

/**
 * Short zone label for a preference: the system's abbreviation (`GMT+3`, `EST`)
 * for local, `UTC` for utc, and `UTC` or the exchange abbreviation for exchange.
 */
export function zoneLabel(pref: TimeZonePref, exchangeZone = 'UTC', ms = Date.now()): string {
  const zone = resolveTimeZone(pref, exchangeZone);
  if (zone === 'UTC') return 'UTC';
  try {
    const part = new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? 'local';
  } catch {
    return 'local';
  }
}
