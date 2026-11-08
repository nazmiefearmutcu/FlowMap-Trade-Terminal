/**
 * Public option, result and readout types of the WebGL renderer. Split out of
 * renderer.ts so the class file holds behaviour only; renderer.ts re-exports
 * every name here, so import sites are unchanged.
 */

import type { RampStop } from './lut';

export interface RendererOptions {
  /** Raw CPU diagnostics for the isolated Windows benchmark only. */
  benchmark?: boolean;
  /**
   * Hard-require EXT_color_buffer_float (default false). The renderer uses only
   * the array-texture path, which does not need float FBOs; the SUM-mip passes
   * flip this to true for the display context.
   */
  requireColorBufferFloat?: boolean;
  /** Target ring capacity in columns; rounded up to whole tile layers. */
  capacityColsTarget?: number;
  /** Approximate on-screen width of one column, in CSS px (auto-follow count). */
  columnPx?: number;
  /** Cap on the auto-follow visible-column count. */
  maxVisibleCols?: number;
}

/** Timing samples from a scripted pan/zoom perf run (test hook). */
export interface PerfResult {
  /** rAF frame-to-frame deltas in ms. */
  deltas: number[];
  /** Per-frame draw+finish cost in ms (the history-independent metric). */
  drawMs: number[];
  /** Frames drawn during the run. */
  frames: number;
}

/**
 * Live render-health counters (the PerfHud chip consumes ONLY
 * this). `fps` and `frameMs` are EMA-smoothed (alpha ≈ 0.1) inside the
 * existing rAF frame; `uploads`/`draws` are cumulative monotonic counters (a
 * HUD diffs them between polls); `cacheBytes` is the CPU column-cache pool +
 * metadata footprint (the exact-readout pool, mirroring the GPU ring).
 */
export interface RendererStats {
  /** EMA-smoothed frames per second (rAF cadence, not dirty frames). */
  fps: number;
  /** EMA-smoothed heatmap draw cost in ms (no gl.finish — a cheap sample). */
  frameMs: number;
  /** Depth columns uploaded to the GPU ring since renderer creation. */
  uploads: number;
  /** Heatmap draw calls since renderer creation. */
  draws: number;
  /** CPU column-cache pool + metadata bytes (0 before the first column). */
  cacheBytes: number;
}

/**
 * Crosshair liquidity readout at a hovered pixel. Sizes come from the
 * exact CPU {@link ColumnCache}, NEVER from GPU-filtered/mip texels; price from
 * the epoch's row→price affine. `hasData` is false when the hovered column is not
 * cached (deep history) — the UI then shows the price but "—" for size.
 */
export interface CrosshairReadout {
  /** Absolute col_seq under the cursor (floor of the fractional column). */
  colSeq: number;
  /** Absolute row under the cursor (row 0 = bottom of the price grid). */
  row: number;
  /** Number of rows summed into the size (tick-grouping / mip block = 4^level). */
  group: number;
  /** Price at the hovered row via `p0 + row·tick·tick_multiple`, or null off-grid. */
  price: number | null;
  /** Price at the BOTTOM of the grouped cell (null off-grid). */
  priceLo: number | null;
  /** Price at the TOP of the grouped cell — NOT priceLo + group*step on a
   *  non-uniform grid, which is exactly why it is reported. */
  priceHi: number | null;
  /** Price-format decimals derived from the tick, for the UI. */
  priceDecimals: number;
  /** Exact summed bid size at the (grouped) cell, or null when not cached. */
  bid: number | null;
  /** Exact summed ask size at the (grouped) cell, or null when not cached. */
  ask: number | null;
  /** Column start time (ns) from the cache, or null when not cached. */
  timeNs: bigint | null;
  /** Time span of an averaged history bucket; absent on full-resolution data. */
  averageMs?: number;
  /**
   * True on a sim feed, whose `timeNs` is session-relative (T+ from session start)
   * rather than wall time. The UI shows the T+ clock for it, with no zone label.
   * Absent on older readouts, which mean wall time.
   */
  sessionClock?: boolean;
  /** Whether the cursor is over a resident column and an on-grid row. */
  inRange: boolean;
}

/**
 * A theme's chart ramps as the renderer consumes them (structural — the theme
 * registry's `ChartPalette` satisfies this without a gl↔theme import).
 * Every theme, midnight included, resolves its density through the
 * theme-owned row 5 and its dedicated synthetic row 6.
 */
export interface ChartThemeInput {
  readonly id: string;
  readonly density: readonly RampStop[];
  readonly synth: readonly RampStop[];
  readonly imbalance?: readonly RampStop[];
}
