/**
 * Price + time axes (price axis right, time axis bottom).
 *
 * Drawn into the gutter {@link TextLayer}s (PriceAxis / TimeAxis canvases) each
 * dirty frame from the current camera, so ticks stay pinned to the heatmap under
 * pan/zoom: the price gutter shares the viewport's HEIGHT (row→y matches the
 * heatmap), the time gutter shares its WIDTH (col→x matches). Optional faint
 * gridlines are drawn on the over-heatmap text layer for orientation. Pure tick
 * math lives in axisTicks.ts; this is the placement/draw glue.
 *
 * Also exposes {@link priceAxisModel} / {@link timeAxisModel} — the computed
 * {label, pos} arrays — so the e2e can assert axis labels + alignment without
 * scraping canvas pixels.
 */

import {
  priceDecimals,
  quoteDecimals,
  priceTickModel,
  timeLabelFormatter,
  timeTickModel,
} from './axisTicks';
import type { GridMap } from './coords';
import type { LastClose } from './priceLine';
import { formatClock, formatPrice, zoneLabel, type TimeZonePref } from '../../i18n/format';
import { PIXEL_BLOCK_CSS } from '../heatmap';
import { OVERLAY } from './palette';
import { DEFAULT_TEXT_SIZE, type TextLayer } from '../textLayer';

const PRICE_TARGET = 8;
const TIME_TARGET = 7;

/** Price-axis tick-label size (CSS px) — the text layer's standard size, hoisted
 *  so axis typography reads as a named constant, not a scattered literal. */
export const AXIS_LABEL_SIZE = DEFAULT_TEXT_SIZE;
/** Price-axis tick-label weight (medium: the ladder reads as data, not chrome). */
export const AXIS_LABEL_WEIGHT = 500;
/** Price-axis major tick mark length (CSS px, 1 px wide). */
export const AXIS_TICK_LEN = 6;
/** Tick-mark opacity — deliberately below the label ink so the ticks read as
 *  subtle guides, not a second ladder (Bookmap-class axis: data is the ink). */
export const AXIS_TICK_ALPHA = 0.55;
/** Time-axis tick-label size (CSS px). Kept one step under the price ladder's
 *  11 px: the gutter is 22 px tall, and 11 px ms-precision labels ("00:00:00.000")
 * would crowd the slot at narrow viewports (measured 10 px min gap at 640 px
 *  wide, deep-zoom ms regime — 11 px labels would close it). */
export const AXIS_TIME_LABEL_SIZE = 10;
/** Approximate advance width of the mono axis font (JetBrains Mono ≈ 0.6 em). */
const MONO_ADVANCE_EM = 0.6;
const TIME_LABEL_GAP_PX = 8;

/** Drawing options shared by the axes and gridlines. */
export interface AxisStyle {
  /**
   * Pixel chart style: tick marks, gridlines and label anchors snap to the centre
   * of their block on the {@link PIXEL_BLOCK_CSS} grid. Label text stays in the
   * UI font.
   */
  readonly pixel?: boolean;
}

/** Snap a CSS-px position to the centre of its pixel block (identity unless pixel style). */
export function snapToPixelBlock(pos: number, pixel: boolean | undefined): number {
  if (pixel !== true || !Number.isFinite(pos)) return pos;
  const block = PIXEL_BLOCK_CSS;
  return Math.floor(pos / block) * block + block / 2;
}

export interface AxisLabel {
  /** CSS-px position along the gutter (y for price, x for time). */
  pos: number;
  label: string;
}

/** Shared label boxes match the actual drawing alignment, including edge
 * labels whose text is clamped inward while their tick stays at its true x. */
function timeLabelPlacement(label: AxisLabel, index: number, count: number, cssW: number): {
  x: number; align: CanvasTextAlign; left: number; right: number;
} {
  const width = label.label.length * AXIS_TIME_LABEL_SIZE * MONO_ADVANCE_EM;
  if (index === 0) {
    const x = Math.max(2, Math.min(label.pos, cssW - 2 - width));
    return { x, align: 'left', left: x, right: x + width };
  }
  if (index === count - 1) {
    const x = Math.max(2 + width, Math.min(label.pos, cssW - 2));
    return { x, align: 'right', left: x - width, right: x };
  }
  return { x: label.pos, align: 'center', left: label.pos - width / 2, right: label.pos + width / 2 };
}

function spacedTimeLabels(labels: AxisLabel[], cssW: number): AxisLabel[] {
  const candidates = labels.filter(label => Number.isFinite(label.pos)
    && label.label.length * AXIS_TIME_LABEL_SIZE * MONO_ADVANCE_EM <= cssW - 4)
    .sort((a, b) => a.pos - b.pos);
  if (candidates.length < 2) return candidates;
  const first = candidates[0], last = candidates[candidates.length - 1];
  let edge = timeLabelPlacement(first, 0, candidates.length, cssW).right;
  const lastLeft = timeLabelPlacement(last, candidates.length - 1, candidates.length, cssW).left;
  if (edge + TIME_LABEL_GAP_PX > lastLeft) return [first];
  const out = [first];
  for (let i = 1; i < candidates.length - 1; i++) {
    const box = timeLabelPlacement(candidates[i], i, candidates.length, cssW);
    if (box.left < edge + TIME_LABEL_GAP_PX || box.right + TIME_LABEL_GAP_PX > lastLeft) continue;
    out.push(candidates[i]);
    edge = box.right;
  }
  out.push(last);
  return out;
}

/**
 * Price ticks with their gutter y (CSS px). Empty when no price affine.
 *
 * Labels always print at the venue tick's precision, which is the floor: the
 * decimals come from the tick step and the venue tick, and are never reduced to
 * make a label narrower. Rounding a 0.05 ladder to one decimal prints
 * 12345.0 | 12345.1 | 12345.1, which is wrong, so a label that is too wide for
 * the gutter is kept exact instead. `_labelWidthPx` is accepted for call-site
 * compatibility and is not used for rounding; the gutter has to be wide enough.
 */
export function priceAxisModel(gm: GridMap, cssH: number, _labelWidthPx?: number): AxisLabel[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const { step, ticks } = axisTicks(gm, pLo, pHi);
  // Decimals come from the TICK step, not the finer grid step, so whole-number
  // ticks print without a '.00'. The venue tick is also a FLOOR on the places:
  // a 0.25 tick prints 5234.25 with two places, never '5234.3', and a 0.01 tick
  // prints two places even on whole-number ticks (60000.00), because the venue's
  // precision is kept rather than reduced.
  const tickStep = step > 0 ? step : localStep(gm);
  const dec = Math.max(priceDecimals(tickStep), quoteDecimals(gm.price.tick ?? tickStep));
  const out: AxisLabel[] = [];
  for (const price of ticks) {
    // Event convention (cell centre), the same row the price line and GEX use,
    // so a label sits on the line it names.
    const y = gm.cssY(gm.priceEventToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push({ pos: y, label: formatPrice(price, dec) });
  }
  return out;
}

/** The grid's row height at the CENTRE of the current view — the right
 *  "smallest meaningful step" for a non-uniform axis. */
function localStep(gm: GridMap): number {
  const s = gm.stepAtRow(gm.view.rowOffset + gm.view.rowScale / 2);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/**
 * Pick the tick ladder for the current price window.
 *
 * A uniform grid — and a non-uniform one the user has zoomed into the linear
 * core — takes the arithmetic ladder verbatim, so those axes are pixel-identical
 * to before. Only a genuinely wide window on a non-uniform scale (more than a
 * 1.5× price ratio top-to-bottom, which a linear axis cannot meaningfully even
 * express since its `pLo` may be negative) switches to a decade ladder, where a
 * single arithmetic step would otherwise be invisible at the bottom of the view
 * and the only tick at the top.
 */
function axisTicks(gm: GridMap, pLo: number, pHi: number): { step: number; ticks: number[] } {
  const scale = gm.price?.scale;
  if (scale?.kind === 'hybrid') {
    // Storage-segment boundaries have no bearing on a price-uniform screen.
    return priceTickModel(pLo, pHi, PRICE_TARGET, scale.coreStep);
  }
  return priceTickModel(pLo, pHi, PRICE_TARGET, localStep(gm) || gm.price!.step);
}

/**
 * How the time axis reads its clock. `null` keeps the session-relative
 * T+ clock: a sim feed's timestamps are not wall time, so they must not be
 * dressed up as one. A clock object formats every tick as wall time in the
 * Settings → Time zone choice.
 */
export interface TimeAxisClock {
  readonly pref: TimeZonePref;
  /** The `exchange` zone: America/New_York for equities, UTC for crypto. */
  readonly exchangeZone: string;
}

/** The time-axis label formatter for a tick step, on the chosen clock (see {@link TimeAxisClock}). */
export function timeAxisLabelFormatter(stepNs: bigint, clock: TimeAxisClock | null): (ns: bigint) => string {
  if (clock === null) return timeLabelFormatter(stepNs);
  const withMs = stepNs > 0n && stepNs <= 500_000_000n;
  return (ns: bigint): string => formatClock(Number(ns / 1_000_000n), clock.pref, clock.exchangeZone, withMs);
}

/** Gap (CSS px) between the zone label and the time labels before it. */
const ZONE_LABEL_GAP_PX = 8;

/** The zone abbreviation shown at the right end of the time strip, or '' on the session clock. */
export function timeAxisZoneText(clock: TimeAxisClock | null): string {
  if (clock === null) return '';
  return zoneLabelCached(clock.pref, clock.exchangeZone);
}

/** Zone abbreviations change only at a DST switch: refresh them once a minute, not every frame. */
const ZONE_CACHE_MS = 60_000;
let zoneCache: { key: string; text: string; at: number } | null = null;

function zoneLabelCached(pref: TimeZonePref, exchangeZone: string): string {
  const key = `${pref}|${exchangeZone}`;
  const now = Date.now();
  if (zoneCache === null || zoneCache.key !== key || now - zoneCache.at >= ZONE_CACHE_MS) {
    zoneCache = { key, text: zoneLabel(pref, exchangeZone, now), at: now };
  }
  return zoneCache.text;
}

/** Width (CSS px) the zone label takes at the right end of the strip, with its gap. */
function zoneReservePx(zone: string): number {
  return zone === '' ? 0 : zone.length * AXIS_TIME_LABEL_SIZE * MONO_ADVANCE_EM + ZONE_LABEL_GAP_PX;
}

/**
 * Time ticks with their gutter x (CSS px). Empty when no time affine. On a clock
 * the zone label takes the right end of the strip, so the labels are laid out
 * in the width that is left.
 */
export function timeAxisModel(gm: GridMap, cssW: number, clock: TimeAxisClock | null = null): AxisLabel[] {
  if (!gm.hasEvents) return [];
  const tLo = gm.colToTsNs(gm.view.colOffset);
  const tHi = gm.colToTsNs(gm.view.colOffset + gm.view.colScale);
  if (tLo === null || tHi === null) return [];
  const { step, ticks } = timeTickModel(tLo, tHi, TIME_TARGET);
  // adaptive labels: the millisecond format is reserved for genuinely
  // sub-second ladders (< 0.5 s) — 0.5 s ticks already read as clock seconds at
  // a glance, and every 1 s+ ladder before this change paid invisible `.mmm`.
  const fmt = timeAxisLabelFormatter(step, clock);
  const plotW = cssW - zoneReservePx(timeAxisZoneText(clock));
  const out: AxisLabel[] = [];
  for (const t of ticks) {
    const x = gm.cssX(gm.tsToCol(t));
    if (x < -1 || x > plotW + 1) continue;
    out.push({ pos: x, label: fmt(t) });
  }
  // Irregular recorded cadence and restart gaps can squeeze distant clock
  // ticks into a few pixels. Filter their projected boxes, never their times.
  return spacedTimeLabels(out, plotW);
}

/**
 * Price tick gutter-y positions only (no label strings) — the string-free twin
 * of {@link priceAxisModel}: EXACTLY the labeled major ticks (same ladder, same
 * viewport filter), which is the gridline-coverage contract (no minor
 * tick may draw a line the axis does not label). For {@link drawGridlines},
 * which needs positions but throws labels away, this avoids the per-dirty-frame
 * toFixed allocation.
 */
export function priceTickPositions(gm: GridMap, cssH: number): number[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const out: number[] = [];
  for (const price of axisTicks(gm, pLo, pHi).ticks) {
    const y = gm.cssY(gm.priceEventToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push(y);
  }
  return out;
}

/**
 * Time tick gutter-x positions only: EXACTLY the collision-filtered labels.
 * Sharing the layout keeps gridlines and visible labels on the same ticks.
 */
export function timeTickPositions(gm: GridMap, cssW: number): number[] {
  return timeAxisModel(gm, cssW).map(label => label.pos);
}

/**
 * Draw the right-hand price axis into its gutter layer.
 *
 * `last` (the newest close, when the price overlay is on) is drawn as a
 * near-white rounded pill pinned to the gutter edge at its price — the
 * TradingView "last price tag": the one number on the axis that matters gets a
 * plate, and it stays readable over any heatmap. Clamped into the gutter so a
 * last price at the very edge of the visible band keeps its tag.
 */
export function drawPriceAxis(layer: TextLayer, gm: GridMap, last: LastClose | null = null, style: AxisStyle = {}): void {
  layer.clear();
  const cssW = layer.width;
  const model = priceAxisModel(gm, layer.height);
  for (const t of model) {
    const y = snapToPixelBlock(t.pos, style.pixel);
    layer.line(0, y, AXIS_TICK_LEN, y, OVERLAY.axis.css, 1, AXIS_TICK_ALPHA);
    layer.text(cssW - 6, y, t.label, {
      align: 'right',
      baseline: 'middle',
      color: OVERLAY.axis.css,
      size: AXIS_LABEL_SIZE,
      weight: AXIS_LABEL_WEIGHT,
    });
  }
  if (last === null || gm.price === null) return;
  const dec = quoteDecimals(gm.price.tick ?? gm.price.step);
  // Row-cell centre (`+0.5`), matching the price line and its dashed level —
  // the pill must sit on the cell the heatmap paints.
  const y = gm.cssY(gm.priceEventToRow(last.price));
  if (y < -8 || y > layer.height + 8) return;
  layer.badge(cssW - 3, Math.min(Math.max(y, 9), layer.height - 9), formatPrice(last.price, dec), {
    align: 'right',
    bg: OVERLAY.pricePill.css,
    color: OVERLAY.pricePillText.css,
    size: 10,
    weight: 600,
    radius: 3,
  });
}

/**
 * Draw the bottom time axis into its gutter layer, on the chosen clock (default:
 * session-relative). On a clock the zone abbreviation is printed at the right end.
 */
export function drawTimeAxis(layer: TextLayer, gm: GridMap, clock: TimeAxisClock | null = null, style: AxisStyle = {}): void {
  layer.clear();
  const cssW = layer.width;
  const model = timeAxisModel(gm, cssW, clock);
  for (let i = 0; i < model.length; i++) {
    const t = { pos: snapToPixelBlock(model[i].pos, style.pixel), label: model[i].label };
    layer.line(t.pos, 0, t.pos, AXIS_TICK_LEN, OVERLAY.axis.css, 1, AXIS_TICK_ALPHA);
    // Clamp the edge labels inward so the first/last time isn't half-clipped by
    // the gutters (the tick mark itself stays at t.pos).
    const { x, align } = timeLabelPlacement(t, i, model.length, cssW);
    layer.text(x, 15, t.label, {
      align,
      baseline: 'alphabetic',
      color: OVERLAY.axis.css,
      size: AXIS_TIME_LABEL_SIZE,
      weight: AXIS_LABEL_WEIGHT,
    });
  }
  const zone = timeAxisZoneText(clock);
  if (zone !== '') {
    layer.text(cssW - 2, 15, zone, {
      align: 'right',
      baseline: 'alphabetic',
      color: OVERLAY.axis.css,
      size: AXIS_TIME_LABEL_SIZE,
      weight: AXIS_LABEL_WEIGHT,
    });
  }
}

/**
 * Coincidence test for gridlines: two gutter positions rasterize onto the same
 * CSS-pixel row/column when their rounded values match (NaN never matches, so
 * the first iteration always draws).
 */
function sameGridline(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

/**
 * Faint gridlines over the heatmap — LABELED ticks only (the gridline-coverage
 * contract): exactly one horizontal line per price-axis label and one vertical
 * line per time-axis label, at the label's own position. The position helpers
 * are the string-free twins of the label models, so no minor tick can produce a
 * line the axis does not label. Coincident positions (ticks rasterizing onto
 * one pixel row, e.g. an edge tick landing on a major) are drawn once.
 * Color/width stay `OVERLAY.grid` / 1 px (alpha is owned by the palette).
 */
export function drawGridlines(text: TextLayer, gm: GridMap, style: AxisStyle = {}): void {
  const cssW = text.width;
  const cssH = text.height;
  let prev = Number.NaN;
  for (const raw of priceTickPositions(gm, cssH)) {
    const y = snapToPixelBlock(raw, style.pixel);
    if (sameGridline(y, prev)) continue;
    prev = y;
    text.line(0, y, cssW, y, OVERLAY.grid.css, 1);
  }
  prev = Number.NaN;
  for (const raw of timeTickPositions(gm, cssW)) {
    const x = snapToPixelBlock(raw, style.pixel);
    if (sameGridline(x, prev)) continue;
    prev = x;
    text.line(x, 0, x, cssH, OVERLAY.grid.css, 1);
  }
}
