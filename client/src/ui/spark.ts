/**
 * Sparkline path math (pure, unit-tested) for the search palette's mini price
 * preview. Turns a short price series into an SVG polyline `d` string in a w×h
 * box, and reports the net direction so the caller can colour it up/down.
 */

import { formatFixed, formatPrice } from '../i18n/format';

/** SVG polyline `d` for `values` fitted into a `w`×`h` box with `pad` margin. */
export function sparkPath(values: readonly number[], w: number, h: number, pad = 1): string {
  const n = values.length;
  if (n === 0) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return '';
  const span = max - min || 1;
  const iw = Math.max(1, w - pad * 2);
  const ih = Math.max(1, h - pad * 2);
  const step = n > 1 ? iw / (n - 1) : 0;
  let d = '';
  let started = false;
  for (let i = 0; i < n; i++) {
    // A non-finite point (a gap in the quote series) must not print "LNaN" —
    // skip it and let the path resume from the next good value.
    if (!Number.isFinite(values[i])) continue;
    const x = pad + i * step;
    const y = pad + (1 - (values[i] - min) / span) * ih;
    d += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    started = true;
  }
  return d;
}

/** Net direction of a series: +1 up, -1 down, 0 flat/empty. */
export function sparkDirection(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return last > first ? 1 : last < first ? -1 : 0;
}

/** Compact signed percent, e.g. +3.21% / −0.50%. */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  // A value that rounds to 0.00 carries no sign: -0.001 reads 0.00%, never −0.00%.
  const sign = Number(Math.abs(v).toFixed(2)) === 0 ? '' : v > 0 ? '+' : '−';
  return `${sign}${formatFixed(Math.abs(v), 2)}%`;
}

/**
 * Compact price, adapting decimals to magnitude. Never digit-grouped: the top
 * bar, DOM ladder, price axis and tape print prices ungrouped, so the search
 * palette must print the same number the same way.
 */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1) return formatPrice(v, 2);
  if (a >= 0.01) return formatPrice(v, 4);
  if (a === 0) return '0.00';
  // Sub-cent quotes: fixed-point with ~3 significant digits. `toPrecision`
  // would print "1.2e-9" here — exponential notation is not an honest price.
  return formatPrice(v, Math.min(20, Math.ceil(-Math.log10(a)) + 2));
}
