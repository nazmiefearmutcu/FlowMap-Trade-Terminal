/**
 * Pure math for the CVD lower pane (unit-tested, no DOM — the replay.ts pattern).
 *
 * The pane draws the cumulative-volume-delta series in its own strip below the
 * heatmap. Horizontally it must map a column to the SAME x the heatmap/price-line
 * use, so dragging the chart drags CVD in lock-step; vertically it has its own
 * signed value axis (CVD is not a price). These helpers own both mappings so the
 * component stays a thin draw loop.
 */

import { formatFixed } from '../i18n/format';

export interface CvdBounds {
  min: number;
  max: number;
}

/** Raw extremes over the finite values of the series. */
interface RawBounds {
  min: number;
  max: number;
}

/** Shared pad/fallback arithmetic so {@link cvdBounds} and the single-pass
 *  {@link cvdProject} can never drift apart. */
function boundsFromRaw(raw: RawBounds): CvdBounds {
  let { min, max } = raw;
  if (min === 0 && max === 0) return { min: -1, max: 1 };
  const range = max - min;
  // Asymmetric headroom (Bookmap-class sub-pane): the side the series is pinned
  // to gets 15% of the raw range, while the zero-baseline side keeps the
  // standard 8%. An intraday-accumulating CVD rides its running extreme for
  // hours, so without this the line glues to the pane edge and the strip reads
  // as one flat slab; the extra air keeps the line a line.
  const padHi = max > 0 ? range * 0.15 : range * 0.08;
  const padLo = min < 0 ? range * 0.15 : range * 0.08;
  min -= padLo;
  max += padHi;
  return { min, max };
}

/**
 * Value bounds over the visible CVD points, ALWAYS spanning 0 (the baseline a
 * signed cumulative reads against), with a fallback range so a flat/empty series
 * is still drawable. A little headroom is added so the extreme point isn't glued
 * to the pane edge.
 */
export function cvdBounds(values: readonly number[]): CvdBounds {
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return boundsFromRaw({ min, max });
}

/**
 * Canvas y (top-down px) for a CVD value inside a strip of `height` px, leaving
 * `pad` px of margin top and bottom. Higher value → higher on screen (smaller y).
 */
export function cvdValueToY(v: number, b: CvdBounds, height: number, pad = 4): number {
  const span = b.max - b.min || 1;
  const t = (v - b.min) / span; // 0 at min, 1 at max
  const usable = Math.max(1, height - pad * 2);
  return pad + (1 - t) * usable;
}

/**
 * Canvas x (px) for a column, matching the heatmap/price-line transform exactly:
 * the column CENTER (`col + 0.5`) mapped through the view's [startCol, endCol)
 * window. `startCol`/`endCol` come straight from `renderer.timeline()`.
 */
export function cvdColToX(col: number, startCol: number, endCol: number, width: number): number {
  const span = endCol - startCol || 1;
  return ((col + 0.5 - startCol) / span) * width;
}

/** The compact CVD tiers, ascending. `digits` is the precision each tier prints at. */
const CVD_TIERS: readonly { readonly div: number; readonly suffix: string; readonly digits: number }[] = [
  { div: 1e3, suffix: 'K', digits: 1 },
  { div: 1e6, suffix: 'M', digits: 2 },
  { div: 1e9, suffix: 'B', digits: 2 },
];

/**
 * Compact signed label for a CVD magnitude (e.g. +1.20M, −45.0K, 0). The digits
 * follow the UI locale's decimal separator (`+1,20M` in Turkish).
 */
export function fmtCvd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const sign = v > 0 ? '+' : '−';
  const a = Math.abs(v);
  if (a < 1) return `${sign}${formatFixed(a, 2)}`;
  // The tier is picked after rounding at its own precision, so a value that rounds
  // up to 1000 of its unit moves up a tier: 999,960 reads 1.00M, not 1000.0K.
  let idx = -1; // -1 is the unit tier, printed without a suffix
  for (let i = 0; i < CVD_TIERS.length; i += 1) if (a >= CVD_TIERS[i].div) idx = i;
  const shown = idx < 0 ? Number(a.toFixed(0)) : Number((a / CVD_TIERS[idx].div).toFixed(CVD_TIERS[idx].digits));
  if (shown >= 1000 && idx < CVD_TIERS.length - 1) idx += 1;
  if (idx < 0) return `${sign}${formatFixed(a, 0)}`;
  const tier = CVD_TIERS[idx];
  return `${sign}${formatFixed(a / tier.div, tier.digits)}${tier.suffix}`;
}

// --- single-pass projection (the CvdPane repaint path) ---------------------------

export interface CvdPoint {
  col: number;
  cvd: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface CvdProjection {
  bounds: CvdBounds;
  /** Screen positions, index-aligned with the input points (length === count). */
  xy: readonly ProjectedPoint[];
  count: number;
}

/**
 * Project the visible CVD series to screen space with ZERO per-repaint
 * allocations: `x` never depends on the value bounds, so one walk computes the
 * extremes AND the x positions, and a second arithmetic walk (no allocations)
 * fills y in place. The caller owns `out` — the pane reuses one buffer across
 * repaints (it is consumed synchronously inside the same paint, so reuse is
 * safe). Output is numerically IDENTICAL to composing
 * `cvdBounds(values) → cvdColToX / cvdValueToY` per point.
 */
export function cvdProject(
  pts: readonly CvdPoint[],
  startCol: number,
  endCol: number,
  width: number,
  height: number,
  out: ProjectedPoint[] = [],
): CvdProjection {
  // Match the input length exactly: stale tail cells from a previous, larger
  // repaint must never leak into the drawing loops.
  out.length = pts.length;
  let min = 0;
  let max = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const v = p.cvd;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const x = cvdColToX(p.col, startCol, endCol, width);
    let cell = out[i];
    if (cell === undefined) {
      cell = { x, y: 0 };
      out[i] = cell;
    } else {
      cell.x = x;
    }
  }
  const bounds = boundsFromRaw({ min, max });
  for (let i = 0; i < pts.length; i += 1) {
    out[i]!.y = cvdValueToY(pts[i].cvd, bounds, height);
  }
  return { bounds, xy: out, count: pts.length };
}
