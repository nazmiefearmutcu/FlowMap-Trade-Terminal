/**
 * Canvas2D painter + hit-testing for chart drawings in (time-ns, price) data space.
 *
 * This module owns GEOMETRY only and is PURE with respect to the DOM: every
 * function takes an injected {@link DrawProjection} (data space ⇄ CSS px —
 * built by DrawingLayer from the ChartMapPair + the epoch affines) and a plain
 * 2D context. Anchors are mapped through the projection EVERY frame — caching
 * pixels would reintroduce the pan/zoom bug described in types.ts.
 *
 * Hot-loop hygiene: the per-frame paths are plain for-loops over scalars —
 * no intermediate arrays, no closures per drawing (the fib ladder reads the
 * frozen FIB_LEVELS tuple; hit-testing returns ONE best hit, never a list).
 * Each entry point wraps its work in save/restore so callers compose layers
 * without style leaks.
 */

import { formatFixed, formatPrice } from '../i18n/format';
import { DRAWING_INK_DEFAULT } from '../theme/drawInks';
import { FIB_LEVELS, fibPriceAt, timeSpan } from './model';
import { DEFAULT_STYLE, type ChartPoint, type Drawing } from './types';

/** Anchor-handle square, CSS px (pro charting-style endpoint knob). */
export const HANDLE_SIZE = 7;
/** Select/hover tolerance in CSS px (hit-testing is forgiving, handles first). */
export const HIT_TOLERANCE_PX = 6;

/** Data space ⇄ CSS px. Built once per frame by DrawingLayer. */
export interface DrawProjection {
  /** Data time (ns) → CSS x. */
  xAt(tNs: bigint): number;
  /** Price → CSS y (y-DOWN; the projection owns the flip). */
  yAt(price: number): number;
  /** CSS x → data time, or null when the time affine is unknown. */
  tNsAt(x: number): bigint | null;
  /** CSS y → price, or null when the price affine is unknown. */
  priceAt(y: number): number | null;
}

/** What a hit landed on: a draggable handle (anchor) or the shape's body. */
export interface DrawingHit {
  id: string;
  kind: 'handle' | 'body';
  /** Anchor index when kind === 'handle'. */
  handle: number;
}

/** Distance from (px,py) to segment (ax,ay)-(bx,by), CSS px. */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Squared-distance shortcut used where only comparisons matter. */
function within(x1: number, y1: number, x2: number, y2: number, tol: number): boolean {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy <= tol * tol;
}

/**
 * Level ratio → tidy percentage label ('0.618' → '61.8%'; a whole level reads
 * '50%', no trailing '.0'). Rounds first, so float dust never shows. The decimal
 * separator follows the UI locale, so Turkish reads '61,8%'.
 */
export function fmtLevelPct(level: number): string {
  const pct = Math.round(level * 1000) / 10;
  return `${formatFixed(pct, Number.isInteger(pct) ? 0 : 1)}%`;
}

/**
 * Price text for the hline tag. With `decimals` (the venue tick's precision, from
 * quoteDecimals) the tag reads at exactly that precision, as the price axis does.
 * Without it the precision follows the magnitude: two decimals from 1 up, and
 * enough digits below 1 that a small positive price never prints as zero. On that
 * magnitude path trailing zeros are dropped ('101.5', not '101.50'). Prices stay
 * '.'-decimal (formatPrice).
 */
export function fmtPriceTag(price: number, decimals?: number): string {
  if (decimals !== undefined || !Number.isFinite(price)) return formatPrice(price, decimals ?? 2);
  if (Number.isInteger(price)) return String(price);
  const abs = Math.abs(price);
  const digits = abs >= 1 ? 2 : Math.min(20, 2 - Math.floor(Math.log10(abs)));
  const text = formatPrice(price, digits);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

// --- hit-testing (pure; unit-tested with fixed projections) ---------------------

/**
 * Hit-test ONE drawing at CSS-px (x, y). Handles (anchor knobs) win first —
 * they are the resize affordance — then the shape's body. `tol` is CSS px
 * (default {@link HIT_TOLERANCE_PX}). Null when nothing is touched.
 */
export function hitTestDrawing(
  d: Drawing,
  x: number,
  y: number,
  proj: DrawProjection,
  tol: number = HIT_TOLERANCE_PX,
): DrawingHit | null {
  // Handles first (topmost affordance), checked back-to-front so the LAST
  // anchor wins a tie — it is the one the eye grabs.
  for (let i = d.points.length - 1; i >= 0; i -= 1) {
    const p = d.points[i];
    if (within(x, y, proj.xAt(p.tNs), proj.yAt(p.price), tol + HANDLE_SIZE / 2)) {
      return { id: d.id, kind: 'handle', handle: i };
    }
  }
  switch (d.tool) {
    case 'trendline': {
      const a = d.points[0];
      const b = d.points[1];
      const dist = distanceToSegment(
        x,
        y,
        proj.xAt(a.tNs),
        proj.yAt(a.price),
        proj.xAt(b.tNs),
        proj.yAt(b.price),
      );
      return dist <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'hline': {
      const dy = Math.abs(y - proj.yAt(d.points[0].price));
      return dy <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'hray': {
      // Horizontal ray: exact level from the anchor's x RIGHTWARD forever.
      const x0 = proj.xAt(d.points[0].tNs);
      if (x < x0 - tol) return null;
      const dy = Math.abs(y - proj.yAt(d.points[0].price));
      return dy <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'rect': {
      const a = d.points[0];
      const b = d.points[1];
      const x0 = proj.xAt(a.tNs);
      const x1 = proj.xAt(b.tNs);
      const y0 = proj.yAt(a.price);
      const y1 = proj.yAt(b.price);
      const lox = Math.min(x0, x1);
      const hix = Math.max(x0, x1);
      const loy = Math.min(y0, y1);
      const hiy = Math.max(y0, y1);
      if (x < lox - tol || x > hix + tol || y < loy - tol || y > hiy + tol) return null;
      // Inside the rect (or on an edge within tol) is a body hit — the whole
      // wash is draggable, which is how these tools feel in every package.
      return { id: d.id, kind: 'body', handle: -1 };
    }
    case 'fib': {
      const [a, b] = d.points;
      const span = timeSpan(a, b);
      const xa = proj.xAt(span.from);
      const xb = proj.xAt(span.to);
      const lox = Math.min(xa, xb) - tol;
      const hix = Math.max(xa, xb) + tol;
      if (x < lox || x > hix) return null;
      // Any of the seven level lines within tol vertically is a body hit.
      for (let i = 0; i < FIB_LEVELS.length; i += 1) {
        const price = fibPriceAt(FIB_LEVELS[i], a, b);
        const dy = Math.abs(y - proj.yAt(price));
        if (dy <= tol) return { id: d.id, kind: 'body', handle: -1 };
      }
      return null;
    }
    case 'text': {
      // The label's painted box, grown by the tolerance: left edge 4 px right of
      // the anchor (paintDrawing), text centred vertically on it, and the whole
      // measured width. Only the first few pixels used to be clickable.
      const p = d.points[0];
      const left = proj.xAt(p.tNs) + 4;
      const mid = proj.yAt(p.price);
      const width = labelWidths.get(labelKey(d.id, d.text)) ?? d.text.length * TEXT_CHAR_PX_FALLBACK;
      const half = TEXT_LINE_PX / 2;
      const inside =
        x >= left - tol && x <= left + width + tol && y >= mid - half - tol && y <= mid + half + tol;
      return inside ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
  }
}

/**
 * Hit-test ALL drawings TOP-DOWN (end of `items` = topmost paint order wins).
 * Single best hit or null — the hot path never materializes a list.
 */
export function hitTestDrawings(
  items: readonly Drawing[],
  x: number,
  y: number,
  proj: DrawProjection,
  tol: number = HIT_TOLERANCE_PX,
): DrawingHit | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const hit = hitTestDrawing(items[i], x, y, proj, tol);
    if (hit !== null) return hit;
  }
  return null;
}

// --- painting -------------------------------------------------------------------

/** One anchor handle: a filled square; `active` adds an accent ring. */
export function paintHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  active: boolean,
): void {
  const half = HANDLE_SIZE / 2;
  ctx.fillStyle = color;
  ctx.fillRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
  if (active) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const r = half + 2;
    ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
  }
}

/**
 * The bundled mono stack (the --font-mono token and the axis text layer's stack), so
 * labels match the rest of the window's type on every OS. Canvas cannot read a CSS
 * variable, so the stack is spelled out here.
 */
const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** A label font for canvas text (mirrors the axis text style). */
const LABEL_FONT = `10px ${MONO_STACK}`;
const TEXT_FONT = `12px ${MONO_STACK}`;
/** Line box of the 12 px label: the vertical extent of its hit area. */
const TEXT_LINE_PX = 14;
/** Width estimate for a label no paint has measured yet (12 px monospace advance). */
const TEXT_CHAR_PX_FALLBACK = 7.2;
/** Bound on remembered label widths; the cache is rebuilt by painting, so a clear is safe. */
const LABEL_WIDTH_CACHE_MAX = 2000;
/** Measured label widths (CSS px) keyed by drawing id + text. */
const labelWidths = new Map<string, number>();

function labelKey(id: string, text: string): string {
  return `${id}\u0000${text}`;
}

/** Remember the painted width of a label so the hit area matches what is drawn. */
function rememberLabelWidth(ctx: CanvasRenderingContext2D, id: string, text: string): void {
  const key = labelKey(id, text);
  if (labelWidths.has(key) || typeof ctx.measureText !== 'function') return;
  const w = ctx.measureText(text).width;
  if (!Number.isFinite(w)) return;
  if (labelWidths.size >= LABEL_WIDTH_CACHE_MAX) labelWidths.clear();
  labelWidths.set(key, w);
}
const TAG_PAD_X = 6;
const TAG_H = 16;
const TAG_MARGIN = 4;
const TAG_TEXT_DARK = '#000000';
const TAG_TEXT_LIGHT = '#FFFFFF';

/** WCAG relative luminance of a `#rrggbb` ink; null for any other colour form. */
function inkLuminance(color: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m === null) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/**
 * Text colour for a price tag filled with the drawing's ink: pure black or white,
 * whichever reads at more contrast. The tag plate is the ink itself, so it cannot
 * depend on the theme ground, and the better of the two clears 4.5:1 (AA, 10 px
 * text) for every ink: the two curves cross at luminance 0.18, where both reach
 * 4.58:1.
 */
export function tagTextColor(ink: string): string {
  const lum = inkLuminance(ink);
  if (lum === null) return TAG_TEXT_DARK;
  const toWhite = 1.05 / (lum + 0.05);
  const toBlack = (lum + 0.05) / 0.05;
  return toWhite > toBlack ? TAG_TEXT_LIGHT : TAG_TEXT_DARK;
}

export interface PaintOpts {
  /** CSS px extent of the drawing surface (for infinite lines + tags). */
  width: number;
  height: number;
  /** When it equals `d.id`, the shape's anchor handles are painted too. */
  selectedId?: string | null;
  /** Paint dashed + slightly transparent (the placement ghost). */
  draft?: boolean;
  /** Stroke color for the draft ghost + its handles (the pending style). */
  selectedColor?: string;
  /** Ghost stroke width (falls back to the default hairline). */
  draftWidth?: number;
  /** Decimals of the instrument's price grid (quoteDecimals(tick)) for hline tags. */
  priceDecimals?: number;
}

/** Shared dash arrays — setLineDash copies, so these are never mutated. */
const SOLID_DASH: number[] = [];
const DASH_DASH: number[] = [4, 4];

/** Ghost-draft identity + fallback style (the pending drawing is ephemeral). */
const DRAFT_ID = '__draft__';
const DEFAULT_GHOST_COLOR = DRAWING_INK_DEFAULT;
const DEFAULT_GHOST_WIDTH = DEFAULT_STYLE.width;

/**
 * Replay ONE finished drawing onto `ctx` in CSS px. Per tool: trendline
 * segment, hline full-width + right-edge price tag, hray from its anchor
 * rightward, rect wash + outline, the 7-level fib ladder with % labels, and
 * the text label. Selection adds one anchor handle per stored point. Dash
 * state is set/cleared per shape so no style leaks between drawings.
 */
export function paintDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  const { width } = opts;
  ctx.save();
  ctx.strokeStyle = d.style.color;
  ctx.fillStyle = d.style.color;
  ctx.lineWidth = d.style.width;
  ctx.setLineDash(opts.draft === true ? DASH_DASH : SOLID_DASH);
  if (opts.draft === true) ctx.globalAlpha = 0.7;
  const selected = opts.selectedId != null && d.id === opts.selectedId;

  switch (d.tool) {
    case 'trendline': {
      const a = d.points[0];
      const b = d.points[1];
      ctx.beginPath();
      ctx.moveTo(proj.xAt(a.tNs), proj.yAt(a.price));
      ctx.lineTo(proj.xAt(b.tNs), proj.yAt(b.price));
      ctx.stroke();
      break;
    }
    case 'hline': {
      const y = proj.yAt(d.points[0].price);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      // Right-edge price tag so the level is readable without tracing the line
      // to the axis. The plate is the drawing's ink, so the tag reads as the line.
      ctx.font = LABEL_FONT;
      const text = fmtPriceTag(d.points[0].price, opts.priceDecimals);
      const tagW = ctx.measureText(text).width + TAG_PAD_X * 2;
      ctx.fillStyle = d.style.color;
      ctx.fillRect(width - TAG_MARGIN - tagW, y - TAG_H / 2, tagW, TAG_H);
      ctx.fillStyle = tagTextColor(d.style.color);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width - TAG_MARGIN - TAG_PAD_X, y);
      break;
    }
    case 'hray': {
      const p = d.points[0];
      const x0 = proj.xAt(p.tNs);
      const y = proj.yAt(p.price);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      // Origin knob so the ray's start is visible even off-selection.
      ctx.fillRect(x0 - 2, y - 2, 4, 4);
      break;
    }
    case 'rect': {
      const a = d.points[0];
      const b = d.points[1];
      const x0 = proj.xAt(a.tNs);
      const x1 = proj.xAt(b.tNs);
      const y0 = proj.yAt(a.price);
      const y1 = proj.yAt(b.price);
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      ctx.globalAlpha = (opts.draft === true ? 0.5 : 1) * 0.12;
      ctx.fillRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.globalAlpha = opts.draft === true ? 0.7 : 1;
      ctx.strokeRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
      break;
    }
    case 'fib': {
      const [a, b] = d.points;
      const span = timeSpan(a, b);
      const xa = proj.xAt(span.from);
      const xb = proj.xAt(span.to);
      const labelX = Math.min(xa, xb);
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (let i = 0; i < FIB_LEVELS.length; i += 1) {
        const level = FIB_LEVELS[i];
        const y = proj.yAt(fibPriceAt(level, a, b));
        // The 0% / 100% rails read stronger than the intermediate targets —
        // same convention as every mainstream charting package.
        ctx.globalAlpha = (opts.draft === true ? 0.7 : 1) * (level === 0 || level === 1 ? 1 : 0.75);
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        ctx.fillText(fmtLevelPct(level), labelX + 3, y - 2);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'text': {
      if (d.text !== '') {
        const p = d.points[0];
        ctx.font = TEXT_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.text, proj.xAt(p.tNs) + 4, proj.yAt(p.price));
        rememberLabelWidth(ctx, d.id, d.text);
      }
      break;
    }
  }

  if (selected) {
    ctx.setLineDash(SOLID_DASH);
    for (let i = 0; i < d.points.length; i += 1) {
      const p = d.points[i];
      paintHandle(ctx, proj.xAt(p.tNs), proj.yAt(p.price), d.style.color, false);
    }
  }
  ctx.restore();
}

/**
 * Live placement preview: the placed anchors plus, while a two-point shape is
 * one anchor short, a GHOST second anchor at `cursor` — the rubber band is
 * drawn as the real thing (a stretching trendline, a live rect wash, fib
 * levels breathing with the pointer), not a separate doodle. Single-anchor
 * tools never ghost (the layer shows their in-place handles only).
 */
export function paintDraft(
  ctx: CanvasRenderingContext2D,
  tool: Drawing['tool'],
  pts: readonly ChartPoint[],
  cursor: ChartPoint | null,
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  if (pts.length === 0) return;
  const color = opts.selectedColor ?? DEFAULT_GHOST_COLOR;
  const twoPoint = tool === 'trendline' || tool === 'rect' || tool === 'fib';
  if (twoPoint && cursor !== null) {
    const style = { color, width: opts.draftWidth ?? DEFAULT_GHOST_WIDTH };
    const draft: Drawing =
      tool === 'trendline'
        ? { id: DRAFT_ID, tool, createdAt: 0, points: [pts[0], cursor], style }
        : tool === 'rect'
          ? { id: DRAFT_ID, tool, createdAt: 0, points: [pts[0], cursor], style }
          : { id: DRAFT_ID, tool: 'fib', createdAt: 0, points: [pts[0], cursor], style };
    paintDrawing(ctx, draft, proj, { ...opts, draft: true });
  }
  // Placed anchors get handles; the ghost cursor does not.
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    paintHandle(ctx, proj.xAt(p.tNs), proj.yAt(p.price), color, false);
  }
}

/**
 * Paint the WHOLE layer: clear, then each finished drawing in order (earlier
 * = deeper). The placement ghost is a separate `paintDraft` call the layer
 * composes after this one. Plain indexed loops — the hot path must not
 * allocate per drawing per frame.
 */
export function paintLayer(
  ctx: CanvasRenderingContext2D,
  items: readonly Drawing[],
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (let i = 0; i < items.length; i += 1) {
    paintDrawing(ctx, items[i], proj, opts);
  }
}
