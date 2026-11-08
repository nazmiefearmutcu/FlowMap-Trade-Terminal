/**
 * The data-space ⇄ CSS-px projection the drawing layer paints and hit-tests
 * through. It sits apart from the component so the paint loop, the placement
 * handlers and the select-mode gestures all share one definition.
 */

import { priceToRow, rowToPrice, scaleFromEpoch } from '../gl/priceScale';
import type { DrawProjection } from '../drawings/painter';
import type { EpochParams } from '../proto/types';
import type { ChartMapPair } from './MeasureTool';

/** Column⇄time anchor — the exact shape of Renderer.timeline().timeBase. */
export interface TimeBaseLike {
  anchorSeq: number;
  anchorT0Ns: bigint;
  dtNs: number;
}

/** Container px = grid space. The layer's fallback when no chart mapping is passed. */
export const IDENTITY: Required<ChartMapPair> = {
  fromChart: (x, y) => ({ col: x, row: y }),
  toChart: (col, row) => ({ x: col, y: row }),
};

/** Clamp a placement-cursor coordinate to the layer (no upper bound before layout). */
export function clampCursor(v: number, extent: number): number {
  const lo = Math.max(v, 0);
  return extent > 0 ? Math.min(lo, extent) : lo;
}

/**
 * Build the data-space ⇄ CSS-px projection from the chart mapping pair, the
 * time anchor and the epoch scale. The x/y projections use the axis-decoupled
 * convention of `cellToCanvasCss` (x depends only on col, y only on row), so
 * the inverse probes evaluate `fromChart` at the vertical/horizontal CENTRE —
 * a renderer's `probeAt` may legitimately return null off the resident grid,
 * which callers treat as "cannot place here".
 */
export function makeProjection(
  map: ChartMapPair,
  timeBase: TimeBaseLike | null,
  params: EpochParams | null,
  cssW: number,
  cssH: number,
): DrawProjection | null {
  if (timeBase === null || params === null || !(timeBase.dtNs > 0)) return null;
  const scale = scaleFromEpoch(params);
  const { anchorSeq, anchorT0Ns, dtNs } = timeBase;
  const midX = cssW / 2;
  const midY = cssH / 2;
  const colOf = (tNs: bigint): number =>
    anchorSeq + Number(tNs - anchorT0Ns) / dtNs;
  const toChart = map.toChart ?? IDENTITY.toChart;
  const fromChart = map.fromChart ?? IDENTITY.fromChart;
  return {
    xAt: (tNs) => toChart(colOf(tNs), 0).x,
    yAt: (price) => toChart(0, priceToRow(scale, price)).y,
    tNsAt: (x) => {
      const p = fromChart(x, midY);
      if (p === null || !Number.isFinite(p.col)) return null;
      return anchorT0Ns + BigInt(Math.round((p.col - anchorSeq) * dtNs));
    },
    priceAt: (y) => {
      const p = fromChart(midX, y);
      if (p === null || !Number.isFinite(p.row)) return null;
      return rowToPrice(scale, p.row);
    },
  };
}
