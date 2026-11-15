/**
 * Text helpers for the Research drawer's sections: a dash for every missing
 * value, percentages and compact dollars in the user's language, prices and
 * quantities with one format each, and instants in the time-zone preference.
 * Digits go through the shared formatters in i18n/format, so the locale's
 * separators apply everywhere.
 */

import type { TFn } from '../i18n/useT';
import { formatFixed, formatNumber, formatZonedDayTime, getTimeZonePref } from '../i18n/format';

/** The text for a value that is not there. */
export const DASH = '—';

type Maybe = number | null | undefined;

function present(value: Maybe): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A plain number with fixed decimals, or the dash. */
export function fixedOrDash(value: Maybe, digits: number): string {
  return present(value) ? formatFixed(value, digits) : DASH;
}

/** A count with locale grouping, or the dash. */
export function countOrDash(value: Maybe): string {
  return present(value) ? formatNumber(value) : DASH;
}

/**
 * A share volume or a coin quantity: no decimals from 1,000 up, otherwise up to
 * three significant digits. Grouped by the locale.
 */
export function quantityOrDash(value: Maybe): string {
  if (!present(value)) return DASH;
  if (Math.abs(value) >= 1000) return formatNumber(value, { maximumFractionDigits: 0 });
  return formatNumber(value, { maximumSignificantDigits: 3 });
}

const PERCENT = (digits: number, signed: boolean): Intl.NumberFormatOptions => ({
  style: 'percent',
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
  signDisplay: signed ? 'exceptZero' : 'auto',
});

/**
 * A percentage from a fraction (0.0123 reads as 1.23%), in the locale's own
 * placement: `1.23%` in English, `%1,23` in Turkish. Or the dash.
 */
export function percentOfFraction(fraction: Maybe, digits: number): string {
  return present(fraction) ? formatNumber(fraction, PERCENT(digits, false)) : DASH;
}

/** A percentage given in percent (8.3 reads as 8.3%), or the dash. */
export function pctOrDash(value: Maybe, digits: number): string {
  return present(value) ? formatNumber(value / 100, PERCENT(digits, false)) : DASH;
}

/** A percentage with its sign: `+1.50%` in English, `%+1,50` in Turkish. Or the dash. */
export function signedPctOrDash(value: Maybe, digits: number): string {
  return present(value) ? formatNumber(value / 100, PERCENT(digits, true)) : DASH;
}

/** A signed plain number: `+0.26`, `-0.26`. */
export function signedOrDash(value: Maybe, digits: number): string {
  if (!present(value)) return DASH;
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  return `${sign}${formatFixed(Math.abs(value), digits)}`;
}

/**
 * A dollar amount in compact notation, in the user's language: `$1.2B` in
 * English, `$1,2 Mr` in Turkish (the locale's own units and currency placement).
 */
export function usdCompact(value: Maybe): string {
  if (!present(value)) return DASH;
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1, style: 'currency', currency: 'USD' });
}

/**
 * The one price format of the drawer: decimals that suit the size (a coin at
 * $0.0123 keeps its digits), a decimal separator and no grouping, as the
 * locale's formatter gives them.
 */
export function priceText(value: Maybe): string {
  if (!present(value)) return DASH;
  const digits = Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : 6;
  return formatFixed(value, digits);
}

/** A calendar date as the server sent it (`2026-11-03`), or the dash. */
export function dayOrDash(iso: string | null | undefined): string {
  return iso ? iso : DASH;
}

/** An instant (epoch milliseconds) in the user's time-zone preference, or the dash. */
export function instantText(ms: Maybe): string {
  return present(ms) ? formatZonedDayTime(ms, getTimeZonePref()) : DASH;
}

const SENTIMENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  'Extreme Fear': 'research.sent.label.extremeFear',
  Fear: 'research.sent.label.fear',
  Neutral: 'research.sent.label.neutral',
  Greed: 'research.sent.label.greed',
  'Extreme Greed': 'research.sent.label.extremeGreed',
};

/** The Fear & Greed label in the user's language; any other label is shown as the source gave it. */
export function sentimentLabelText(t: TFn, label: string | null): string {
  if (label === null) return DASH;
  const key = SENTIMENT_LABEL_KEYS[label];
  return key ? t(key) : label;
}

const TVL_SOURCE_KEYS: Readonly<Record<string, string>> = {
  chain: 'research.market.source.chain',
  protocol: 'research.market.source.protocol',
};

/** The TVL kind (`chain` or `protocol`) in the user's language; any other token is shown as given. */
export function tvlSourceText(t: TFn, source: string | null): string {
  if (source === null) return DASH;
  const key = TVL_SOURCE_KEYS[source];
  return key ? t(key) : source;
}
