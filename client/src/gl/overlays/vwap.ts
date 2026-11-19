/**
 * Session VWAP overlay.
 *
 * A polyline of session VWAP over time. Each {@link BarColumn} carries CUMULATIVE
 * `vwap_num_cum = Σ(price·vol)` and `vwap_den_cum = Σ vol` from the session start,
 * so session VWAP at a column is simply `num/den` (chosen over per-column deltas:
 * it's the standard anchored-session VWAP traders read, and monotone-cumulative
 * inputs make it robust to a dropped column). One vertex per visible column, so
 * the draw is O(visible).
 *
 * Works in both markets: crypto/equity tape seeds the cumulants; equity keyless
 * derives them from 1-minute bars (Σ typical×vol / Σ vol) — the renderer badges
 * that case "approx". No bars ⇒ nothing drawn.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';
import { addUnderStrokedSegments, type TraceSegment } from './underStroke';
import { traceRuns } from './traceRuns';

/** CSS-px width of the VWAP core stroke. */
const VWAP_WIDTH_PX = 2.4;

/** Session VWAP from cumulative sums, or NaN when denominator is empty. Pure. */
export function sessionVwap(numCum: number, denCum: number): number {
  return denCum > 0 ? numCum / denCum : Number.NaN;
}

interface Entry {
  num: number;
  den: number;
  t0: bigint;
  xCol: number;
}

export class Vwap {
  private readonly bars = new Map<number, Entry>();

  /** Record / refresh a bar column's cumulants at its absolute col_seq. */
  add(bar: BarColumn, closeColumn = bar.col_seq + 0.5): void {
    this.bars.set(bar.col_seq, { num: bar.vwap_num_cum, den: bar.vwap_den_cum, t0: bar.t0_ns, xCol: closeColumn });
  }

  get size(): number {
    return this.bars.size;
  }

  /** Drop bars outside `[oldest-pad, newest+pad]` (bounds memory to the window). */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const seq of this.bars.keys()) {
      if (seq < lo || seq > hi) this.bars.delete(seq);
    }
  }

  reset(): void {
    this.bars.clear();
  }

  /** VWAP value at a column (for tests / readouts), or NaN. */
  valueAt(colSeq: number): number {
    const e = this.bars.get(colSeq);
    return e ? sessionVwap(e.num, e.den) : Number.NaN;
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid } = frame;
    if (!gm.hasEvents || this.bars.size === 0) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;

    // Collect visible vertices in ascending column order (one per column).
    // `+0.5` = row-cell centre (the line family must sit on the
    // density cell the heatmap paints, matching the bubbles and markers).
    const pts: Array<{ col: number; t0: bigint; xCol: number; x: number; y: number }> = [];
    const projection = gm.view.timeProjection;
    for (let c = range.lo; c <= range.hi; c++) {
      const e = this.bars.get(c);
      if (e === undefined) continue;
      const v = sessionVwap(e.num, e.den);
      if (!Number.isFinite(v)) continue;
      const x = gm.clipX(e.xCol);
      if (projection?.emptyAt((x + 1) / 2)) continue;
      pts.push({ col: c, t0: e.t0, xCol: e.xCol, x, y: gm.clipY(gm.priceEventToRow(v)) });
    }
    if (pts.length === 0) return;

    const segments: TraceSegment[] = [];
    for (const run of traceRuns(pts, gm.time)) {
      for (let i = 1; i < run.length; i++) {
        segments.push({ x0: run[i - 1].x, y0: run[i - 1].y, x1: run[i].x, y1: run[i].y });
      }
      // An isolated observation stays visible without implying a connection.
      if (run.length === 1) {
        const dx = gm.pxToClipW(3);
        segments.push({ x0: run[0].x - dx, y0: run[0].y, x1: run[0].x + dx, y1: run[0].y });
      }
    }
    solid.begin();
    // The violet core sits over the hot end of the density ramp, so it gets the
    // same contrast under-stroke as the price line.
    addUnderStrokedSegments(solid, segments, VWAP_WIDTH_PX, OVERLAY.vwap.gl, gm.dims.cssW, gm.dims.cssH);
    solid.flush();
  }
}
