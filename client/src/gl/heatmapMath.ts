/**
 * Pure sampling, transfer and style math for the heatmap draw pass: view and
 * channel types, mip-level and smoothing selection, the transfer curve, pixel
 * style and DPR sanitising. Only uploadFloatArray touches GL, and nothing here
 * owns GL state.
 */

import type { ViewportNormalizer } from './normalize';

/** Screen→grid mapping. col = colOffset + colScale·uv.x; row = rowOffset + rowScale·uv.y. */
export interface HeatmapView {
  colOffset: number;
  colScale: number;
  rowOffset: number;
  rowScale: number;
}

/** Value-encoding + colormap knobs (normally driven by normalization). */
export interface HeatmapEncoding {
  /** Per-instrument fixed decode scale applied to raw density. */
  decodeScale: number;
  /** Normalization divisor (percentile) mapping intensity into ~[0,1]. */
  norm: number;
  /** Colormap row: RAMP_FLOW | RAMP_INFERNO | RAMP_SYNTH | RAMP_CLASSIC. */
  ramp: number;
}

/** The depth channel a user can view (`Renderer.setDepthChannel`). */
export type DepthChannel = 'sum' | 'bid' | 'ask' | 'imbalance';

/** `DepthChannel` → the shader's `u_channel` code. */
export const DEPTH_CHANNEL_CODE: Record<DepthChannel, number> = {
  sum: 0,
  bid: 1,
  ask: 2,
  imbalance: 3,
};

export const DEFAULT_DEPTH_CHANNEL: DepthChannel = 'sum';

/**
 * Pixel chart style. The block edge is 6 CSS pixels scaled
 * by the device-pixel ratio, so every block covers the same screen area on any
 * display. The shader posterizes to {@link PIXEL_LEVELS} bands.
 */
export const PIXEL_BLOCK_CSS = 6;
export const PIXEL_LEVELS = 7;

/** Chart style: the smooth field or the pixel blocks. */
export type ChartStyle = 'normal' | 'pixel';
export const CHART_STYLES: readonly ChartStyle[] = ['normal', 'pixel'] as const;
export const DEFAULT_CHART_STYLE: ChartStyle = 'normal';

/** Clamp an arbitrary (settings-persisted) value to a valid chart style. */
export function chartStyleOf(value: unknown): ChartStyle {
  return value === 'pixel' ? 'pixel' : 'normal';
}

/** Pixel-style block edge in device pixels for a device-pixel ratio (≥ 1 px). */
export function pixelBlockPx(dpr: number): number {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.round(PIXEL_BLOCK_CSS * ratio));
}

/**
 * CPU mirror of the shader's `posterizePixel`: quantizes a normalized LUT
 * coordinate to {@link PIXEL_LEVELS} flat bands at k/(levels-1). Endpoints are
 * exact (0 → 0, 1 → 1), and out-of-range input is clamped.
 */
export function posterizePixelLevel(v: number): number {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  const steps = PIXEL_LEVELS - 1;
  return Math.min(Math.floor(x * PIXEL_LEVELS) / steps, 1);
}

/** Clamp an arbitrary (settings-persisted) value to a valid channel. */
export function depthChannelOf(value: unknown): DepthChannel {
  return value === 'bid' || value === 'ask' || value === 'imbalance' ? value : 'sum';
}

export const TILE_UNIT = 0;
export const LUT_UNIT = 1;
export const MIP1_UNIT = 2;
export const MIP2_UNIT = 3;
export const ROWMIP_UNIT = 4;
export const GEOMETRY_UNIT = 6;
export const RESOLUTION_UNIT = 7;

/**
 * Default perceptual display gamma. Order-flow density is heavy-tailed:
 * the median active cell is a few percent of the viewport white point while
 * walls sit at 10-100×, so the below-knee exponent decides how much of the
 * faint field is visible at all.
 *
 * Set by measurement on a frozen capture: the below-knee lift is the only lever
 * that brings the faint field off the dark ramp head, and it leaves the wall band
 * (knee to white) unchanged. The older 0.86 stays reachable on the Contrast slider
 * (which reaches 1.4). Elsewhere in the chain f(0)=0 (background), f(knee)=lowSpan
 * and f(1)=1 (LUT 255) stay exact. Pinned equal to
 * gammaForContrast(DEFAULT_CONTRAST) by the tests.
 */
export const DEFAULT_DISPLAY_GAMMA = 0.653;

/**
 * Map a 0–100 "Contrast" slider to a display gamma. HIGHER contrast → HIGHER
 * gamma → a darker mid-field with punchier walls (more separation); LOWER
 * contrast → lower gamma → the field is lifted flat/bright (washed, less
 * separation). The default ({@link DEFAULT_CONTRAST}, 17) lands on 0.653 —
 * the below-knee low-end lift (see {@link DEFAULT_DISPLAY_GAMMA}).
 * Clamped to the legible band [0.5, 1.4].
 */
export function gammaForContrast(contrast: number): number {
  const c = Math.min(100, Math.max(0, contrast));
  return 0.5 + (c / 100) * 0.9;
}

/** Slider position (0–100) whose gamma equals the default — the reset point. */
export const DEFAULT_CONTRAST = 17;

/**
 * Above-knee log-compression strength of the two-segment transfer curve
 * (Bookmap-class overhaul). `u_gamma` owns the below-knee lift; this
 * constant owns the upper segment: the wall band (p97..p99.7) no longer clamps
 * into the top few LUT entries but spreads across `log1p` space. Fixed (not a
 * user setting) — the Contrast slider keeps its single below-knee-gamma meaning.
 */
export const TRANSFER_LOG_SCALE = 6.0;

/**
 * Output span of the BELOW-knee transfer segment (calibrated on live books).
 * The knee sits at `p97 / p99.7` in
 * t-space — a SMALL fraction on heavy-tailed books (≈0.18 live BTC) — so a
 * curve whose below-knee segment ends at `k` capped ~97% of active cells at
 * LUT ≤ k·255 (≈45): the field read as black in recorded/scrollback regions
 * while only walls glowed. The below-knee segment now owns a FIXED output
 * share [0, lowSpan] (the mids stay visible under the gamma lift) and the
 * above-knee log compression owns the wall band [lowSpan, 1]. Both endpoints
 * stay exact (f(0)=0, f(1)=1); the segments meet continuously at the knee.
 */
export const TRANSFER_LOW_SPAN = 0.85;

/**
 * Knee fraction used when no {@link ViewportNormalizer} is attached (unit tests,
 * the synthetic e2e hook): `u_knee = 0.55`. With a normalizer attached the draw
 * uploads the live `knee / white` ratio (clamped [0.05, 0.95]) instead.
 */
export const DEFAULT_KNEE_FRACTION = 0.55;

/** Clamp the per-frame knee fraction into the legible, division-safe band. */
export function clampKneeFraction(v: number): number {
  return Math.min(0.95, Math.max(0.05, Number.isFinite(v) ? v : DEFAULT_KNEE_FRACTION));
}

/**
 * The two-segment transfer curve (Bookmap-class overhaul) — the TS mirror of
 * the fragment shader's post-floor mapping, for tests:
 *
 *   t <= k : t = S * pow(t / k, gamma)                              // lift, span S
 *   t >  k : t = S + (1-S) * log(1 + L*(t-k)/(1-k)) / log(1 + L)    // wall compress
 *
 * `S = lowSpan` (default {@link TRANSFER_LOW_SPAN}) is the output share the
 * below-knee segment owns — see the constant's docblock for why fixing it at
 * `k` (the original formula) crushed the heavy-tail mid-field to black.
 * Endpoints are exact (f(0) = 0 → background, f(1) = 1 → LUT 255) and the two
 * segments meet continuously at the knee (both equal `S`). Gaussian-free, pure.
 */
export function transferCurve(
  t: number,
  {
    knee,
    gamma,
    logScale,
    lowSpan,
  }: { knee: number; gamma: number; logScale: number; lowSpan?: number },
): number {
  const tc = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const k = Number.isFinite(knee)
    ? Math.min(0.999999, Math.max(0.000001, knee))
    : DEFAULT_KNEE_FRACTION;
  const g = Number.isFinite(gamma) ? Math.max(1e-6, gamma) : 1;
  const L = Number.isFinite(logScale) && logScale > 0 ? logScale : TRANSFER_LOG_SCALE;
  const S =
    typeof lowSpan === 'number' && Number.isFinite(lowSpan) && lowSpan > 0 && lowSpan < 1
      ? lowSpan
      : TRANSFER_LOW_SPAN;
  if (tc <= k) return S * Math.pow(tc / k, g);
  return S + (1 - S) * (Math.log1p((L * (tc - k)) / (1 - k)) / Math.log1p(L));
}

/** Shader safety ceiling after a calibrated cut is scaled by row footprint. */
export const TOLERANCE_MAX_FLOOR = 0.85;

/** Zero preserves every positive density sample. */
export const DEFAULT_TOLERANCE = 0;

/**
 * Resolve a slider value through its visible density distribution. A cold or
 * missing normalizer keeps the field visible until real samples arrive.
 */
export function floorForTolerance(
  tolerance: number,
  normalizer?: Pick<ViewportNormalizer, 'floorForTolerance'> | null,
): number {
  return normalizer?.floorForTolerance(tolerance) ?? 0;
}

/** The mip level + tap geometry to sample this frame (see {@link selectLevel}). */
export interface LevelSel {
  level: number;
  blk: number;
  nRowTaps: number;
  /**
   * Row-only mip selected. Present ONLY
   * when true, so every pre-existing caller/assertion keeps its exact object
   * shape; the draw then overrides level/blk/taps itself (see {@link Heatmap.draw}).
   */
  rowOnly?: boolean;
}

/**
 * Row-only mip eligibility edge (rpp >= 1.5). Below it the level-0 triple is
 * the row sampler. From here the row-mip chain's dense Gaussian kernel takes
 * over, because the level-0 triple is structurally sparse: its ±dy taps do not
 * overlap an isolated single-row level when dy > 1 row, which left a 2.0–2.5
 * rows-per-pixel band with hairline edges.
 */
export const ROW_MIP_EDGE = 1.5;

/**
 * Choose the SUM-mip level from the pixel's footprint on BOTH axes.
 *
 * `rowsPerPixel` (price axis): how many price rows collapse into one device
 * pixel. `colPerPixel` (time axis): how many columns a device pixel spans when
 * the user zooms OUT in time — historically ignored, which made a time-zoomed-out
 * + price-zoomed-in view sample hundreds of columns per pixel through the 3-tap
 * level-0 blur (temporal aliasing: walls strobe while panning, thin events
 * vanish). Level L's texels sum a 4^L×4^L block, so the level picked is the
 * COARSER of the two axes' needs (`max`), clamped to `maxLevel`; the leftover row
 * footprint is covered by 1..4 finer-level taps summed in the shader.
 *
 * Per-level intensity/floor semantics are UNCHANGED: intensity sums
 * `nRowTaps` row-blocks and divides the column dimension by blk, so a view at a
 * given (level, taps) reads the same whether that level was chosen by the row or
 * the column axis — a col-driven level behaves exactly like a price zoom to the
 * same blk, and the black point keeps scaling by `nRowTaps·blk` (the row
 * footprint at that level). With no mips (`maxLevel === 0`) this is the
 * identity: level 0, one tap.
 *
 * `colPerPixel` defaults to 1 so every historical 2-arg call — and every
 * row-driven selection — produces EXACTLY the pre-axis output.
 *
 * `levelFloor` (tick grouping) is a LOWER BOUND on the chosen
 * level: `Renderer.setTickGrouping(n)` passes the smallest level whose block
 * already groups at least `n` rows (`ceil(log4(n))`), so the displayed cell is
 * 4^level ≥ n rows. The floor is clamped to `maxLevel`; with no mips
 * (`maxLevel === 0`) it is ignored (there is no coarser texture to sample).
 * `levelFloor = 0` — the default, and every pre-tickGrouping call — reproduces
 * the exact previous output.
 *
 * `rowOnly: true` is a purely ADDITIVE flag:
 * present only when the row axis needs 4-row grouping (rpp >= {@link ROW_MIP_EDGE}),
 * the time axis is NOT zoomed out (cpp < 1.5) and no tick-grouping floor is active.
 * {@link Heatmap.draw} then samples the row-only chain (4-row sums of ONE
 * column) instead of the 4x4 SUM mip; level/blk/nRowTaps remain the historical
 * SUM-path fields so every pre-existing consumer output is unchanged.
 */
export function selectLevel(
  rowsPerPixel: number,
  maxLevel: number,
  colPerPixel = 1,
  levelFloor = 0,
): LevelSel {
  if (maxLevel <= 0) return { level: 0, blk: 1, nRowTaps: 1 };
  const rpp = Number.isFinite(rowsPerPixel) ? rowsPerPixel : 1;
  const cpp = Number.isFinite(colPerPixel) ? colPerPixel : 1;
  // log4 via log2/2: Math.log2 is exact for powers of two on V8, so the
  // level boundary at exact 4^k footprints no longer rides on log/log rounding.
  //
  // The ROW axis takes the 4-row SUM mip at rpp >= 2.5. A single texel fetch
  // gives the footprint smoothing that a per-pixel multi-tap sum cannot afford
  // within the draw budget. Below 2.5 the level-0 bilinear field is smooth
  // (several pixels per row).
  const rowLevel = rpp >= 2.5 ? Math.max(1, Math.min(maxLevel, Math.floor(Math.log2(rpp) / 2))) : 0;
  const colLevel = cpp > 1 ? Math.min(maxLevel, Math.floor(Math.log2(cpp) / 2)) : 0;
  const floorLevel = Number.isFinite(levelFloor)
    ? Math.max(0, Math.min(maxLevel, Math.floor(levelFloor)))
    : 0;
  // Row-only decoupling: the ROW axis alone needs 4-row grouping (at
  // rpp >= {@link ROW_MIP_EDGE}). When the time axis is NOT zoomed out
  // (cpp < 1.5) that grouping skips the 4-column averaging the 4x4 SUM mip
  // applies, so scrolled-back and reconstructed columns keep crisp cell edges
  // instead of 4-column blocks. The flag is additive: level/blk stay the
  // SUM-path fields so every existing consumer output is unchanged, and the
  // draw derives the actual row-mip taps (blk 4) itself. A tick-grouping floor
  // keeps the forced SUM path (the floor is an explicit user choice of block
  // size).
  //
  // Engaging the row-mip chain from ROW_MIP_EDGE with a continuous weight (see
  // rowFadeFor) avoids a dead zone where the rowFade renormalisation zeroed the
  // row-mip path while the level-0 triple painted isolated levels as sparse
  // hairlines.
  const rowOnly = rpp >= ROW_MIP_EDGE && cpp < 1.5 && floorLevel === 0;
  const level = Math.max(floorLevel, Math.max(0, Math.max(rowLevel, colLevel)));
  const blk = 4 ** level;
  // COVERAGE, not rounding: round(rpp/blk) picked 1 tap for rpp
  // in (4,6), leaving ~30% of the pixel's price footprint unsampled — when
  // price is zoomed far out that aliasing paints every price row as a dashed
  // line. ceil() guarantees the summed taps span the whole footprint; the ×4
  // clamp covers 64 rows at level 2, more than any viewport at the 4096-row
  // grid can demand.
  const nRowTaps = Math.max(1, Math.min(4, Math.ceil(rpp / blk)));
  return rowOnly ? { level, blk, nRowTaps, rowOnly: true } : { level, blk, nRowTaps };
}

/**
 * Smooth SUM-mip level cross-fade.
 *
 * The historical SUM-mip selector switched levels at hard 4^k footprints: at
 * colsPerPixel 4.0 the shader jumped from a single level-0 column sample to a
 * 4x4 SUM block (equivalently at 16.0 for level 2), a measured mean-luma spike
 * of 88.9 — 9.4x the median — exactly at the boundary. This returns a blend
 * plan instead: across a transition band [0.75*4^k, 4^k] the draw mixes the
 * FINER level (k-1) into the coarse level k with weight `fade` (smoothstep,
 * zero slope at both band ends), so the LOD change is continuous.
 *
 * Pure function, byte-identical outside the band:
 *   - fp <= 1 / non-finite / <= 0        -> pure level 0 (no finer sample).
 *   - fp < 0.75*4^k (outside the band)   -> pure level k-1 (fade 0; the draw
 *     then uploads the LEGACY selectLevel() values verbatim).
 *   - fp >= 4^k (k < maxLevel)           -> pure level k (fade 1; equals the
 *     old selectLevel() output at every historical switch point 4.0/16.0...).
 *   - 0.75*4^k < fp < 4^k                -> { level: k, finerLevel: k-1,
 *     fade: w } with w = smoothstep((fp/4^k - 0.75) / 0.25).
 *   - fp beyond 4^maxLevel               -> pure maxLevel (weight saturates).
 *   - `levelFloor > 0` (tick grouping) or `maxLevel < 1` -> fade 0: a forced
 *     or absent level must stay pure and bit-exact (the draw falls back to the
 *     legacy selectLevel() upload; nothing is blended).
 *
 * `fp` is the dominant footprint axis the selector uses,
 * `max(rowsPerPixel, colsPerPixel)`. `finerLevel` is -1 whenever no second
 * sample exists (fade 0 or 1); the draw reports it additively for diagnostics.
 */
export function levelBlendFor(
  fp: number,
  maxLevel: number,
  levelFloor = 0,
): { level: number; finerLevel: number; fade: number } {
  if (!Number.isFinite(fp) || fp <= 0) return { level: 0, finerLevel: -1, fade: 0 };
  const maxL = Number.isFinite(maxLevel) ? Math.max(0, Math.floor(maxLevel)) : 0;
  const floor = Number.isFinite(levelFloor)
    ? Math.max(0, Math.min(maxL, Math.floor(levelFloor)))
    : 0;
  if (maxL < 1 || floor > 0) {
    return { level: Math.max(0, Math.min(floor, maxL)), finerLevel: -1, fade: 0 };
  }
  // Smallest integer k with fp <= 4^k (log2 is exact for powers of two on V8,
  // so the 4^k boundaries never ride on log/log rounding).
  const kRaw = Math.ceil(Math.log2(fp) / 2);
  if (kRaw <= 0) return { level: 0, finerLevel: -1, fade: 0 };
  const k = Math.min(maxL, kRaw);
  const boundary = 4 ** k;
  // The band is deliberately WIDE (0.55..1.00 of the boundary): the LOD change
  // is a brightness ramp of the aggregation factor (up to 4x), so a narrow band
  // still concentrates it into a couple of wheel steps. 0.55..1.0 spreads the
  // same total change over ~4x more zoom range (zoom-ladder re-measured).
  // Exact band edges: the two pure regimes compare against their own constants
  // so fp == bandLo and fp == boundary are bit-exact endpoints (a t-formula
  // would land on 0.9999999999999999 and break endpoint byte-identity).
  const bandLo = boundary * 0.55;
  if (fp <= bandLo) return { level: k - 1, finerLevel: -1, fade: 0 };
  if (fp >= boundary) return { level: k, finerLevel: -1, fade: 1 };
  const t = (fp - bandLo) / (boundary - bandLo);
  // LINEAR ramp, not smoothstep: the pixel delta per zoom step is ~proportional
  // to the weight change, so a uniform ramp minimizes the MAX per-step pop
  // (smoothstep concentrated ~1.5x the average change in the band's middle —
  // measured on the zoom ladder). The band edges meet constant regimes, so the
  // slope kink there is sub-step and invisible.
  const w = t;
  return { level: k, finerLevel: k - 1, fade: w };
}

/**
 * Gaussian field-sampler law (Bookmap-class overhaul; replaces the
 * crisp/3-tap-blur cross-fade). The historical kernel was either a fixed
 * 3-column blur (sub-pixel columns) or hard nearest-cell sampling (deep zoom);
 * both produced artifacts at their opposite ends (confetti vs 40–200 px
 * smear/step aliasing). The new sampler is one width-scaled Gaussian on the
 * TIME axis, `sigma` pinned in SCREEN pixels:
 *
 *   sigmaCols = clamp(SMOOTH_SIGMA_PX * colsPerPixel · dpr, 0.12, 2.0)
 *   taps      = 9 (offsets −4..+4) when sigmaCols > 0.12, else 1 (pure bilinear)
 *
 * so the edge response stays ~`2.563 * 2.5 ≈ 6.4 px` (10–90) at deep zoom and
 * only sharpens as columns become sub-pixel (the 2.0-column cap). The vertical
 * axis is untouched — price stays crisp. Non-finite input degrades to the
 * minimum plan (single bilinear tap).
 *
 * DPR portability: the screen pixel here is a
 * **CSS pixel**, NOT a framebuffer pixel. The caller ({@link Heatmap.draw})
 * converts the framebuffer-denominated footprints to CSS px with the
 * device-pixel ratio (`colsPerPixel = colScale / drawingBufferWidth · dpr` /
 * `rowsPerPixel · dpr`) BEFORE applying any law, so a retina panel renders the
 * same CSS edge widths as DPR1 instead of a ~2× harder field (at DPR2 the
 * un-scaled law measured 1-tap barcodes, 96–98% sub-3-px hairlines). DPR1 is
 * byte-identical: the ratio reads exactly 1 there.
 */
export const SMOOTH_SIGMA_PX = 2.5;
/** Odd tap budget baked into the GLSL loop bound (offsets −4..+4). */
export const SMOOTH_MAX_TAPS = 9;
/** Sigma floor in column units — guards the div-by-zero / one-column smear. */
export const SMOOTH_SIGMA_COLS_MIN = 0.12;
/** Sigma ceiling in column units — beyond this the edge smears multi-cell. */
export const SMOOTH_SIGMA_COLS_MAX = 2.0;
/**
 * Tap-count tiers (perf calibration): the frame uploads only the taps
 * whose Gaussian weight is non-negligible at its sigma — the full 9-tap table
 * failed the SwiftShader p10 draw gate (33.7 ms). Boundaries in COLUMN units:
 * σ ≤ 0.35 → 1 tap, ≤ 0.75 → 3, ≤ 1.25 → 5, else 9. HONESTY:
 * these are ±1.3–1.6σ truncations, so the effective second moment is NOT
 * preserved — measured σ_eff shifts ~11–13% downward at tier boundaries
 * (0.35→0.18, 0.75→0.67, 1.25→1.11). The tiers are a perf trade, not a claim
 * of sigma preservation; the visual acceptance bars (smooth-zoom spec) are
 * the arbiter.
 */
export const SMOOTH_TAPS_TIERS: readonly { maxSigma: number; taps: number }[] = [
  { maxSigma: 0.35, taps: 1 },
  { maxSigma: 0.75, taps: 3 },
  { maxSigma: 1.25, taps: 5 },
  { maxSigma: Number.POSITIVE_INFINITY, taps: 9 },
];

export interface SmoothPlan {
  /** Gaussian sigma in COLUMN units (never 0 — 1-tap plans keep the min). */
  sigmaCols: number;
  /** Odd tap count, one of 1/3/5/9, ≤ {@link SMOOTH_MAX_TAPS}. */
  taps: number;
}

/**
 * Map the time-axis footprint (`colsPerPixel`, SCREEN = CSS pixels — the
 * caller scales the framebuffer footprint by the device-pixel ratio, see
 * {@link SMOOTH_SIGMA_PX}) to the frame's sampler plan. Pure and
 * monotone in `colsPerPixel`; non-finite input (and negatives) degrade to the
 * minimum plan. `taps` follows the tier table above; the truncation is honest
 * about its cost (see {@link SMOOTH_TAPS_TIERS} — effective σ shifts ≲13%
 * downward at tier boundaries, a perf trade whose result the smooth-zoom
 * pixel bars enforce). In CSS units the plan is DPR-invariant:
 * `smoothPlanFor(cpp_fb · dpr)` is the same plan at every DPR for the same
 * CSS framing.
 */
export function smoothPlanFor(colsPerPixel: number): SmoothPlan {
  const cpp = Number.isFinite(colsPerPixel) ? Math.max(0, colsPerPixel) : 0;
  const sigmaCols = Math.min(
    SMOOTH_SIGMA_COLS_MAX,
    Math.max(SMOOTH_SIGMA_COLS_MIN, SMOOTH_SIGMA_PX * cpp),
  );
  let taps = SMOOTH_MAX_TAPS;
  for (const tier of SMOOTH_TAPS_TIERS) {
    if (sigmaCols <= tier.maxSigma) {
      taps = tier.taps;
      break;
    }
  }
  return { sigmaCols, taps };
}

/** Vertical softening target in SCREEN (CSS) pixels (barcode fix, 2026-09-13). */
export const SMOOTH_ROW_SIGMA_PX = 2.2;
/**
 * Cap on the total vertical blend band in SCREEN (CSS) pixels. The triple spans ±dy rows → `2·dy / rowsPerPixel`
 * screen px; the pixel-denominated dy already bounds that at `2·sigma_px` =
 * 4.4 px. The cap is the guard for a future sigma raise (and documents the
 * ≤10 px acceptance bound) — it never binds at the shipped 2.2 px sigma.
 */
export const SMOOTH_ROW_BAND_MAX_PX = 10;

/**
 * Vertical (price-axis) softening offset in ROW units for a draw — the
 * barcode killer. A live book concentrates liquidity on single price
 * ROWS; the rows-per-pixel at the DEFAULT book zoom is ~3, so each level
 * paints as a hard 1-px hairline. The shader blends a 0.25/0.5/0.25 triple at
 * ±dy rows around each sample, turning each level into a soft band (the
 * Bookmap look).
 *
 * dy is PIXEL-denominated and ACTIVE at every zoom: `dy = sigma_px ·
 * rowsPerPixel · dpr` makes ±dy a constant ~{@link SMOOTH_ROW_SIGMA_PX} CSS
 * px worth of rows (a level spreads over ~2·sigma_px px, edge 10–90 ≈ 4 px —
 * soft, never a hairline, under the mush bar). The old `rpp >= 2 → 0` cutoff
 * made the mechanism inert EXACTLY at the default (rpp ≈ 3) — the field
 * stayed a barcode; the cutoff is gone. The only 0 endpoint left is
 * non-finite / non-positive input (legacy single-sample path for a poisoned
 * view). The shader applies this triple in BOTH display paths: the level-0
 * field (`fieldAt`) and the deep-row mip fetch (`rowMipSoft`, converted to
 * 4-row texel units by the draw's `* 0.25`), so the default view — which
 * rides the row-mip path — is softened too.
 *
 * `rowsPerPixel` is in SCREEN = CSS pixels (the caller scales the
 * framebuffer footprint by the device-pixel ratio, see {@link SMOOTH_SIGMA_PX}, so at DPR2 the kernel covers twice the ROWS for the same CSS
 * framing and the band measures the same CSS px. DPR1 is byte-identical.
 */
export function rowSmoothDyFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel) || rowsPerPixel <= 0) return 0;
  const dyRows = SMOOTH_ROW_SIGMA_PX * rowsPerPixel;
  const capRows = (SMOOTH_ROW_BAND_MAX_PX / 2) * rowsPerPixel;
  return Math.min(dyRows, capRows);
}

/** Deep-row softening enable (see {@link rowMipSoftenFor}) — 1 mip-row step. */
export const SMOOTH_ROW_MIP_DY = 1;

/**
 * One-entry memo of the last table: the plan is stable across frames, so
 * the per-draw Float32Array allocations are paid only when sigma or the tap count
 * actually changes. Callers only read the tables.
 */
let gaussMemo: { sigma: number; count: number; out: { offsets: Float32Array; weights: Float32Array } } | null = null;

/**
 * CPU Gaussian tap table for a plan: `taps` symmetric offsets centered on 0
 * (so the shader's fixed `for t < u_smoothTaps` loop reads the CENTERED
 * subset) and `exp(-0.5 * (off / sigma)^2)` weights, normalized to sum 1 here
 * — the shader re-normalizes over the VALID taps only, so window edges fold
 * to the core. Uploaded as uniforms (padded to 9): no per-fragment `exp`
 * (driver determinism across SwiftShader/GPU).
 */
export function gaussianTaps(
  sigmaCols: number,
  taps: number,
): { offsets: Float32Array; weights: Float32Array } {
  const count = Math.max(1, Math.min(SMOOTH_MAX_TAPS, Math.round(taps)));
  if (gaussMemo !== null && gaussMemo.sigma === sigmaCols && gaussMemo.count === count) return gaussMemo.out;
  const out = buildGaussianTaps(sigmaCols, count);
  gaussMemo = { sigma: sigmaCols, count, out };
  return out;
}

export function buildGaussianTaps(
  sigmaCols: number,
  count: number,
): { offsets: Float32Array; weights: Float32Array } {
  const offsets = new Float32Array(SMOOTH_MAX_TAPS);
  const weights = new Float32Array(SMOOTH_MAX_TAPS);
  const half = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const off = i - half;
    const rel = off / sigmaCols;
    const w = Math.exp(-0.5 * rel * rel);
    offsets[i] = off;
    weights[i] = w;
    sum += w;
  }
  for (let i = 0; i < count; i++) weights[i] /= sum;
  return { offsets, weights };
}

/**
 * Row-mip cross-fade weight (resolution-transition polish; the
 * edge sits at {@link ROW_MIP_EDGE}).
 *
 * The historical row LOD switch was a hard threshold: rpp < 2.5 sampled the
 * level-0 single-row bilinear, rpp >= 2.5 sampled the 4-row-sum mip — a
 * measured brightness/pop spike in the zoom ladder through rpp 2.4–3.9 (the
 * band where row aggregation flips). This ramps the handoff instead:
 *
 *   - rpp <= 1.5  → 0 (pure level-0 rows, EXACT legacy output)
 *   - rpp >= 2.5  → 1 (pure row-mip sums, EXACT post-4.1 output)
 *   - in between  → linear (rpp−1.5)/1.0
 *
 * The lower edge is the coverage extension (zones: "2.0–2.5 rowFade
 * renormalization cliff" and "0.70–2.0 the pixel triple misses the feature").
 * At the old [2.0, 3.0] ramp the renormalization zeroed the row-mip weight
 * through [2.0, 2.5], so one wheel notch in from the default (rpp 2.07) rode
 * the SPARSE level-0 triple (dy 4.55 rows → three disconnected hairlines);
 * measured 98% sub-3-px edges there. Ramping from 1.5 gives that zone a
 * real row-mip share (2.07 → 0.57) while the DEFAULT keeps the completed
 * handoff calibrated (rpp ≥ 2.5 → pure row-mip). Both endpoints stay exact:
 * 1.5 → 0 is the legacy level-0 sample, 2.5 → 1 is the full row path.
 *
 * Non-finite input degrades to 0 (the legacy level-0 path) rather than
 * poisoning the blend weight. NOTE the DRAW applies this only inside the
 * row-mip eligibility regime — see {@link effectiveRowMode}, which is the
 * single source of truth for the uploaded weight.
 */
export function rowFadeFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel) || rowsPerPixel <= ROW_MIP_EDGE) return 0;
  if (rowsPerPixel >= 2.5) return 1;
  // Linear ramp (see levelBlendFor): uniform weight deltas minimize the max
  // per-step pop; the edge is exact (knee = rowFadeFor(ROW_MIP_EDGE) = 0, so
  // effectiveRowMode's renormalization is the identity).
  return (rowsPerPixel - ROW_MIP_EDGE) / (2.5 - ROW_MIP_EDGE);
}

/**
 * The draw-side effective row mode for a frame — the SINGLE source of truth for
 * `{rowOnly, rowFade}`. `Heatmap.draw` and `testHook.levelInfo` both call this,
 * so the reported selection can never drift from the painted one.
 *
 * Eligibility (`rowEligible`) is `selectLevel`'s `rowOnly` regime: rpp >=
 * {@link ROW_MIP_EDGE}, a deep time zoom, and no tick-grouping floor. Outside
 * it the time-zoomed-out SUM path, a forced tick-grouping floor, and the
 * rpp < ROW_MIP_EDGE level-0 path keep their exact historical output. Inside
 * the regime the weight from {@link rowFadeFor} is renormalized against the
 * edge knee — with the edge at 1.5 that knee is exactly 0, so the ramp is
 * continuous from the legacy level-0 sample (fade 0) to the full row path
 * (fade 1 at rpp 2.5) with no step at either end.
 *
 * Without a usable row-mip chain (`rowUsable` false) the weight is 0: the
 * legacy selection is used verbatim.
 */
export function effectiveRowMode(
  rowsPerPixel: number,
  rowUsable: boolean,
  rowEligible = true,
): { rowOnly: boolean; rowFade: number } {
  if (!rowUsable || !rowEligible) return { rowOnly: false, rowFade: 0 };
  const raw = rowFadeFor(rowsPerPixel);
  const knee = rowFadeFor(ROW_MIP_EDGE);
  const rowFade = raw <= knee ? 0 : (raw - knee) / (1 - knee);
  return { rowOnly: rowFade > 0, rowFade };
}

/**
 * Deep-row softening enable for a draw (composes with
 * {@link rowSmoothDyFor}). When the price axis
 * collapses rows into sub-pixel footprints (the row-mip regime, rpp >=
 * {@link ROW_MIP_EDGE} — the same edge {@link effectiveRowMode} uses), a single
 * price level paints as a ~1-px hairline at the default book zoom (rpp ~3): a
 * barcode pattern. The shader then blends each 4-row mip texel with its
 * MIP-row neighbours, and wraps that fetch in the SAME
 * pixel-denominated 0.25/0.5/0.25 triple the level-0 field uses (`rowMipSoft`
 * in the shader, offset = `rowSmoothDyFor(rpp) / 4` mip texels). Without the
 * triple the isolated-wall exemption kept exactly the single-level spikes
 * crisp, which is what defeated the first fix at the default. Returns exactly
 * 0 outside the regime so the historical single-fetch row path stays
 * byte-exact.
 */
export function rowMipSoftenFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel)) return 0;
  return rowsPerPixel >= ROW_MIP_EDGE ? SMOOTH_ROW_MIP_DY : 0;
}

/** Deep-row Gaussian target in SCREEN (CSS) pixels (barcode fix, 2026-09-13). */
export const SMOOTH_ROW_MIP_SIGMA_PX = 2.0;
/** Deep-row Gaussian tap count (offsets -3..3 in 4-row mip texels). */
export const SMOOTH_ROW_MIP_TAPS = 7;

/**
 * The deep-row Gaussian weights for a draw — the vertical counterpart of
 * {@link smoothPlanFor}'s column kernel. Taps sit on integer 4-row mip texels
 * (offset -3..3); the Gaussian sigma is pinned in SCREEN (CSS) pixels and
 * converted to texel units by `SMOOTH_ROW_MIP_SIGMA_PX · rpp / 4` (one mip
 * texel = 4 rows), clamped to [0.4, 2.5] texels so the kernel stays inside the
 * 7-tap support at both ends of the regime. Normalized to sum 1 (edge taps
 * clamp to the grid edge in the shader). At the rpp ~3.05 default zoom sigma ≈
 * 1.2 texels → a ~5 px soft band with a smooth falloff (the shader
 * reconstructs between texels bilinearly), replacing the hard 1-px hairline.
 *
 * `rowsPerPixel` is in SCREEN = CSS pixels (same convention as
 * {@link rowSmoothDyFor}); the caller scales the framebuffer footprint by the
 * device-pixel ratio, so the same CSS framing gets the same texel
 * sigma at every DPR. DPR1 is byte-identical.
 */
let rowMipMemo: { sigmaTexels: number; w: Float32Array } | null = null;

export function rowMipWeightsFor(rowsPerPixel: number): Float32Array {
  const rpp = Number.isFinite(rowsPerPixel) ? Math.max(1e-6, rowsPerPixel) : 1;
  const sigmaTexels = Math.min(2.5, Math.max(0.4, (SMOOTH_ROW_MIP_SIGMA_PX * rpp) / 4));
  // Same sigma as last time: the same table (no per-draw allocation).
  if (rowMipMemo !== null && rowMipMemo.sigmaTexels === sigmaTexels) return rowMipMemo.w;
  const w = new Float32Array(SMOOTH_ROW_MIP_TAPS);
  const half = (SMOOTH_ROW_MIP_TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < SMOOTH_ROW_MIP_TAPS; i++) {
    const off = (i - half) / sigmaTexels;
    const val = Math.exp(-0.5 * off * off);
    w[i] = val;
    sum += val;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  rowMipMemo = { sigmaTexels, w };
  return w;
}

/**
 * Sanitise a device-pixel ratio: a missing, zero, negative or non-finite value
 * degrades to 1 (DPR1, the calibrated and byte-pinned state).
 */
export function sanitizeDpr(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Upload a float uniform array. Real WebGL2 contexts always expose
 * `uniform1fv`; the optional-call guard lets the jsdom FakeGL (which predates
 * array uniforms) degrade to a no-op instead of throwing mid-draw.
 */
export function uploadFloatArray(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  data: Float32Array,
): void {
  const fn = (
    gl as unknown as {
      uniform1fv?: (loc: WebGLUniformLocation | null, v: Float32Array) => void;
    }
  ).uniform1fv;
  if (typeof fn === 'function') fn.call(gl, location, data);
}

