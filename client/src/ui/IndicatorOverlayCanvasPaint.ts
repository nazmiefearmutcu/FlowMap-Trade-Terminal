/**
 * Paint routines of IndicatorOverlayCanvas: the overlay polylines drawn through
 * the chart mapping, and the sub-pane strip (RSI / MACD / ATR / OBV) with its
 * per-lane scale, zero line and labels. Both are pure canvas drawing over one
 * {@link PaintFrame}; the component owns the kernels, the paint signature and
 * the chart chrome colours.
 */

import type { Candle } from '../candles/synth';
import { priceToRow as scalePriceToRow, type PriceScale } from '../gl/priceScale';
import { formatFixed, formatNumber } from '../i18n/format';
import { SLOT_CAP } from '../indicators/feed';
import type { IndicatorKernel } from '../indicators/kernels/types';
import { outputLabel } from '../indicators/labels';
import type { IndicatorDef, OutputSpec } from '../indicators/registry';
import type { ActiveIndicator } from '../indicators/store';

/** Sub-pane label font: the bundled mono token, with the system stack as the fallback. */
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const slotOf = (bi: number): number => bi % SLOT_CAP;

/** Per-active-indicator drawn state: kernel + one value ring per output key. */
export interface InstanceState {
  uid: string;
  def: IndicatorDef;
  kernel: IndicatorKernel;
  /** Value per candle slot (NaN = no value), one Float64Array per output key. */
  rings: Float64Array[];
  paramsSig: string;
  /** Bucket id of the last CLOSED candle committed to the kernel (−1 = none). */
  lastFedBi: number;
  /** Close of the last committed bar; carries the price across empty buckets. */
  lastClose: number;
}

/** The chart chrome colours of the sub-pane strip, resolved from the theme tokens. */
export interface PaneChrome {
  chipBg: string;
  chipBorder: string;
  gridInk: string;
  inkDim: string;
  zeroInk: string;
  titleInk: string;
}

/** Everything one repaint reads: the canvas, the candles and their columns, the mapping and the scale. */
export interface PaintFrame {
  ctx: CanvasRenderingContext2D;
  cssW: number;
  cssH: number;
  candles: readonly Candle[];
  /** Fractional chart column of each candle (NaN when unmappable). */
  colAt: Float64Array;
  to: (col: number, row: number) => { x: number; y: number };
  /** The epoch's price scale; null until the geometry is known (overlays then draw nothing). */
  scale: PriceScale | null;
  active: readonly ActiveIndicator[];
  instances: ReadonlyMap<string, InstanceState>;
  colorOf: (uid: string, out: OutputSpec) => string;
  themedVar: (name: string, fallback: string) => string;
  chrome: PaneChrome;
}

/**
 * Adaptive value formatting for pane labels (compact, finite-safe). Digits go
 * through the UI locale's decimal separator (`4,00` in Turkish), like the rest
 * of the chart's non-price numbers.
 */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${formatFixed(v / 1_000_000, 2)}M`;
  if (abs >= 10_000) return `${formatFixed(v / 1_000, 1)}K`;
  if (abs >= 100) return formatFixed(v, 1);
  if (abs >= 1) return formatFixed(v, 2);
  if (abs === 0) return '0';
  return formatNumber(v, { minimumSignificantDigits: 2, maximumSignificantDigits: 2, useGrouping: false });
}

/**
 * Overlay pane: polylines through the same price scale and camera as the
 * heatmap. A candle with no value (warm-up, gap) breaks the line, so nothing is
 * bridged across a missing bucket.
 */
export function paintOverlayLines(f: PaintFrame, chartBottom: number): void {
  const { ctx, candles: cs, colAt, to, scale, active, instances, colorOf, cssW } = f;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const a of active) {
    const inst = instances.get(a.uid);
    if (inst === undefined || inst.def.pane !== 'overlay' || scale === null) continue;
    for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
      const out = inst.def.outputs[oi];
      const ring = inst.rings[oi];
      ctx.strokeStyle = colorOf(a.uid, out);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cssW, chartBottom); // overlays never run into the sub strip
      ctx.clip();
      let started = false;
      for (let i = 0; i < cs.length; i += 1) {
        const v = ring[slotOf(cs[i].bi)];
        const col = colAt[i];
        if (i > 0 && cs[i].bi - cs[i - 1].bi > 1) started = false; // no candle in between: do not bridge
        if (!Number.isFinite(v) || !Number.isFinite(col)) {
          started = false;
          continue;
        }
        const p = to(col, scalePriceToRow(scale, v));
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(p.x, p.y);
        else {
          ctx.moveTo(p.x, p.y);
          started = true;
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Sub-pane strip, pinned to the bottom of the canvas: one lane per active
 * indicator, each with its own min/max scale across all of its outputs.
 */
export function paintSubPanes(f: PaintFrame, subActive: readonly ActiveIndicator[], stripH: number): void {
  const { ctx, candles: cs, colAt, to, cssW, cssH, instances, colorOf, themedVar } = f;
  const { chipBg, chipBorder, gridInk, inkDim, zeroInk, titleInk } = f.chrome;
  const laneH = stripH / subActive.length;
  ctx.fillStyle = chipBg;
  ctx.fillRect(0, cssH - stripH, cssW, stripH);
  ctx.strokeStyle = chipBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cssH - stripH + 0.5);
  ctx.lineTo(cssW, cssH - stripH + 0.5);
  ctx.stroke();

  ctx.font = `10px ${themedVar('--font-mono', MONO_FALLBACK)}`;
  ctx.textBaseline = 'top';

  for (let li = 0; li < subActive.length; li += 1) {
    const a = subActive[li];
    const inst = instances.get(a.uid);
    if (inst === undefined) continue;
    const laneTop = cssH - stripH + li * laneH;
    const laneBottom = laneTop + laneH;
    const y0 = laneTop + 3;
    const y1 = laneBottom - 5;

    // Lane scale: min/max across ALL outputs of this indicator.
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const ring of inst.rings) {
      for (let i = 0; i < cs.length; i += 1) {
        const v = ring[slotOf(cs[i].bi)];
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (hi === lo) {
      hi += Math.abs(hi) * 1e-6 + 1e-9;
      lo -= Math.abs(lo) * 1e-6 + 1e-9;
    }
    const yOf = (v: number): number => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

    // Lane separator + scale labels.
    ctx.strokeStyle = gridInk;
    ctx.beginPath();
    if (li < subActive.length - 1) {
      ctx.moveTo(0, laneBottom - 0.5);
      ctx.lineTo(cssW, laneBottom - 0.5);
    }
    ctx.stroke();
    ctx.fillStyle = inkDim;
    ctx.textAlign = 'left';
    ctx.fillText(fmtVal(hi), 4, y0);
    ctx.fillText(fmtVal(lo), 4, y1 - 10);

    const xOf = (i: number): number => {
      const col = colAt[i];
      return Number.isFinite(col) ? to(col, 0).x : Number.NaN;
    };

    // Zero line when the lane spans it (MACD-style lanes).
    if (lo < 0 && hi > 0) {
      const zy = yOf(0);
      ctx.strokeStyle = zeroInk;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, zy);
      ctx.lineTo(cssW, zy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Histogram outputs first (behind the lines), then lines.
    for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
      const out = inst.def.outputs[oi];
      if (!out.histogram) continue;
      const ring = inst.rings[oi];
      ctx.fillStyle = colorOf(a.uid, out);
      const zy = yOf(0);
      const halfW = Math.max(1, Math.min(4, cssW / Math.max(8, cs.length) / 2));
      for (let i = 0; i < cs.length; i += 1) {
        const v = ring[slotOf(cs[i].bi)];
        if (!Number.isFinite(v)) continue;
        const x = xOf(i);
        if (!Number.isFinite(x)) continue;
        const y = yOf(v);
        ctx.fillRect(x - halfW, Math.min(y, zy), halfW * 2, Math.max(1, Math.abs(y - zy)));
      }
    }
    for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
      const out = inst.def.outputs[oi];
      if (out.histogram) continue;
      const ring = inst.rings[oi];
      ctx.strokeStyle = colorOf(a.uid, out);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < cs.length; i += 1) {
        const v = ring[slotOf(cs[i].bi)];
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const x = xOf(i);
        if (!Number.isFinite(x)) {
          started = false;
          continue;
        }
        if (i > 0 && cs[i].bi - cs[i - 1].bi > 1) started = false; // gap: do not bridge
        const y = yOf(v);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
    }

    // Lane title (left, after the scale labels) + latest values (right).
    ctx.fillStyle = titleInk;
    ctx.textAlign = 'left';
    ctx.fillText(inst.def.outputs.map((o) => outputLabel(o.key, o.label)).join('·'), 40, y0);
    let labelX = cssW - 6;
    ctx.textAlign = 'right';
    for (let oi = inst.def.outputs.length - 1; oi >= 0; oi -= 1) {
      const out = inst.def.outputs[oi];
      const ring = inst.rings[oi];
      let last = Number.NaN;
      for (let i = cs.length - 1; i >= 0; i -= 1) {
        const v = ring[slotOf(cs[i].bi)];
        if (Number.isFinite(v)) {
          last = v;
          break;
        }
      }
      if (!Number.isFinite(last)) continue;
      const text = fmtVal(last);
      ctx.fillStyle = colorOf(a.uid, out);
      ctx.fillText(text, labelX, y0);
      labelX -= ctx.measureText(text).width + 10;
    }
  }
}
