/**
 * The measure tool's pure math and formatting: the price at a grid row, the human
 * Δtime, the signed Δprice and Δ%, and the resting depth inside a row band. No DOM,
 * no React, so each rule is unit-tested on its own (MeasureTool.test.tsx).
 */

import type { EpochParams } from '../proto/types';
import { quoteDecimals } from '../gl/overlays/axisTicks';
import { scaleFromEpoch, rowToPrice as scaleRowToPrice, stepAtRow as scaleStepAtRow } from '../gl/priceScale';
import { formatFixed, formatPrice } from '../i18n/format';
import type { BookBuffer } from '../state/bookStore';

/** Price at a grid row through the epoch scale, + the decimals to print it with. */
export function priceAtRow(
  row: number,
  params: EpochParams | null,
): { price: number; decimals: number } | null {
  if (params === null || !Number.isFinite(row)) return null;
  const scale = scaleFromEpoch(params);
  const price = scaleRowToPrice(scale, row);
  if (!Number.isFinite(price)) return null;
  // The venue tick sets the precision (exact for 0.25-style ticks, up to 12
  // places); a fixed 8-place cap printed sub-tick noise on tiny-priced coins.
  const decimals = quoteDecimals(scaleStepAtRow(scale, row));
  return { price, decimals };
}

/** Unit suffixes for {@link fmtDeltaTime}: English by default, the UI passes its own table. */
export interface DeltaTimeUnits {
  ns: string;
  ms: string;
  s: string;
  m: string;
  h: string;
  d: string;
}

export const EN_DELTA_TIME_UNITS: DeltaTimeUnits = { ns: 'ns', ms: 'ms', s: 's', m: 'm', h: 'h', d: 'd' };

/** Human Δtime for a non-negative nanosecond span, in the given unit suffixes. */
export function fmtDeltaTime(ns: bigint, units: DeltaTimeUnits = EN_DELTA_TIME_UNITS): string {
  if (ns < 0n) ns = -ns;
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ns}${units.ns}`;
  if (ms < 1_000) return `${Math.round(ms)}${units.ms}`;
  if (ms < 10_000) return `${formatFixed(ms / 1_000, 1)}${units.s}`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}${units.s}`;
  const totalMin = Math.floor(ms / 60_000);
  const totalHr = Math.floor(ms / 3_600_000);
  if (totalHr < 1) return `${totalMin}${units.m} ${Math.round((ms % 60_000) / 1_000)}${units.s}`;
  if (totalHr < 24) return `${totalHr}${units.h} ${totalMin % 60}${units.m}`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}${units.d} ${totalHr % 24}${units.h}`;
}

/** Signed Δprice formatted against the grid's decimals (the price format: always '.'). */
export function fmtDeltaPrice(delta: number, decimals: number): string {
  if (!Number.isFinite(delta)) return '—';
  return `${delta >= 0 ? '+' : '−'}${formatPrice(Math.abs(delta), decimals)}`;
}

/** Δ as a percent of the start price, two decimals, signed, in the UI locale. */
export function fmtDeltaPct(delta: number, base: number): string {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return '—';
  const pct = (delta / base) * 100;
  return `${pct >= 0 ? '+' : '−'}${formatFixed(Math.abs(pct), 2)}%`;
}

/** Summed resting depth inside a half-open row band of the current book. */
export function sumDepthInBand(
  book: BookBuffer | null,
  rowLo: number,
  rowHi: number,
): { bid: number; ask: number | null } | null {
  if (book === null) return null;
  const lo = Math.max(0, Math.floor(Math.min(rowLo, rowHi)));
  const hi = Math.min(book.bid.length, Math.ceil(Math.max(rowLo, rowHi)));
  if (hi <= lo) return null;
  let bid = 0;
  let ask = book.ask === null ? null : 0;
  for (let r = lo; r < hi; r += 1) {
    bid += book.bid[r];
    if (ask !== null && book.ask !== null) ask += book.ask[r];
  }
  if (ask !== null && !Number.isFinite(ask)) ask = null;
  return { bid, ask };
}
