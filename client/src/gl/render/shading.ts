/**
 * Colour and shading state of the live renderer: the colormap family and the
 * honesty-aware ramp selection, the theme atlas rows and the themable clear
 * colour, the channel view, chart style, black point (tolerance), display gamma
 * (contrast), the tick-grouping floor, the viewport percentile normaliser
 * (u_norm) and the mip LOD selection.
 * The Renderer keeps one-line delegates with the same names.
 *
 * Every knob remembers its value, so a Heatmap built later (session reset,
 * context restore, preload) inherits it through {@link Shading.configureHeatmap}.
 */
import { COLS_PER_TILE, type TileRing } from '../tileRing';
import {
  DEFAULT_CHART_STYLE,
  DEFAULT_DEPTH_CHANNEL,
  DEFAULT_DISPLAY_GAMMA,
  DEPTH_CHANNEL_CODE,
  chartStyleOf,
  depthChannelOf,
  selectLevel,
  type ChartStyle,
  type DepthChannel,
  type Heatmap,
} from '../heatmap';
import {
  RAMP_FLOW,
  RAMP_SYNTH,
  RAMP_THEME,
  RAMP_THEME_SYNTH,
  rampForMode,
  setThemeStops,
  uploadLUTAtlas,
  type Colormap,
} from '../lut';
import { honestDepthTier } from '../depthTier';
import { ViewportNormalizer } from '../normalize';
import type { ColumnCache } from '../columnCache';
import type { MipChain } from '../mips';
import type { OverlayManager } from '../overlays/manager';
import type { OverviewSurface } from '../overviewSurface';
import { projectedRowsPerPixel } from '../priceProjection';
import { rowToPrice as scaleRowToPrice } from '../priceScale';
import { clamp } from '../numeric';
import { MODE_SYNTH_PROFILE } from '../../proto/types';
import type { ChartThemeInput } from '../rendererTypes';
import type { AxisMap } from './axisMap';
import type { FrameState, StateSource } from './frameState';

/** Max tick-grouping request: 16 rows = mip level 2, the coarsest block the
 *  SUM-mip chain can build (levels clamp further if the chain is shallower).
 *  Clamping HERE (not only at shade time) keeps getTickGrouping() honest. */
const TICK_GROUPING_MAX = 16;

/** What the shading state reads from the renderer. Getters are read at use time. */
export interface ShadingHost {
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly axis: AxisMap;
  /** The column scale resolver the normalizer reads (the Renderer's delegate to the axis map). */
  rawColumnScale: AxisMap['rawColumnScale'];
  columnCache(): ColumnCache;
  /** The GL context: the LUT atlas upload and the drawing-buffer size. */
  gl(): WebGL2RenderingContext;
  lut(): WebGLTexture;
  heatmap(): Heatmap | null;
  ring(): TileRing | null;
  mips(): MipChain | null;
  overlays(): OverlayManager;
  activeOverview(): OverviewSurface | null;
  overviewSurface(): OverviewSurface | null;
  dpr(): number;
  prefersReducedMotion(): boolean;
  clearBackground(): void;
}

export class Shading {
  /** Viewport-percentile normalization: per-tile histograms → u_norm. One instance
   *  is shared with every Heatmap and overview surface (`heatmap.normalizer = …`). */
  readonly normalizer: ViewportNormalizer;
  private readonly host: ShadingHost;
  /** Display gamma (Contrast setting) — kept here so it survives heatmap
   *  re-creation on session reset and is re-applied to each new Heatmap. */
  private contrastGamma = DEFAULT_DISPLAY_GAMMA;
  /** Fixed per-instrument decode scale (capability-driven; 1 for the sim). */
  private decodeScale = 1;
  /** Current colormap row (inferno / synth / classic), from mode + user choice. */
  private ramp = RAMP_FLOW;
  /** The user's colormap family. Remembered here, like {@link contrastGamma},
   *  so it survives Heatmap re-creation on session reset / context restore. */
  private colormap: Colormap = 'inferno';
  /** Active chart theme for the `'theme'` colormap. `null` resolves
   *  to the frozen FLOW/SYNTH rows; every non-null theme (midnight included)
   *  serves its density from the theme-owned row 5. */
  private chartTheme: ChartThemeInput | null = null;
  /** Render mode of the last column, for re-deriving the ramp on a knob change. */
  private lastColMode: number | null = null;
  /** Black point (Tolerance), re-applied to every freshly built Heatmap. */
  private toleranceFloor = 0;
  /** Depth channel view, re-applied like {@link toleranceFloor}. */
  private depthChannel: DepthChannel = DEFAULT_DEPTH_CHANNEL;
  /** Chart style: normal field or pixel blocks. Re-applied
   *  to every freshly built Heatmap, like {@link depthChannel}. */
  private chartStyle: ChartStyle = DEFAULT_CHART_STYLE;
  /** Tick-grouping request (1..{@link TICK_GROUPING_MAX}), re-applied like the
   *  other knobs. 1 = today's rendering; see {@link setTickGrouping}. */
  private tickGrouping = 1;

  /** `maxTiles` is the normalizer's tile budget (the ring's layer count + 1). */
  constructor(host: ShadingHost, maxTiles: number) {
    this.host = host;
    this.normalizer = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 1e-8,
      useWorker: true, onAsyncReady: () => { host.frameState.dirty = true; },
      maxTiles, sourceColumn: col => {
        const arrays = host.columnCache().arrays(col);
        return arrays ? { ...arrays, scale: host.rawColumnScale(col) } : null;
      } });
  }

  /** The colormap row the frame uses; the background clear colour follows it. */
  get activeRamp(): number {
    return this.ramp;
  }

  /** Heatmap display gamma (Contrast setting). Applied live + remembered
   *  so a session reset's fresh Heatmap inherits it. */
  setContrast(gamma: number): void {
    this.contrastGamma = gamma;
    const heatmap = this.host.heatmap();
    if (heatmap) heatmap.gamma = gamma;
    this.host.frameState.dirty = true;
  }

  /**
   * Re-derive the active colormap row from the CURRENT column mode, the feed's
   * honesty tier and the user's colormap choice, and push it into the heatmap.
   *
   * The tier check inside {@link rampForMode} is unconditional, so this is
   * safe to call at any time — including with no column seen yet, where the
   * mode falls back to the synthetic-safe MODE_SYNTH_PROFILE rather than
   * assuming real depth. That matters because `currentRamp` is exactly what the
   * parity e2e asserts, and a colormap click mid-session-reset must never make a
   * SYNTH session report a real-depth ramp.
   */
  private applyRamp(): void {
    const depthTier = honestDepthTier(this.host.store.getState().capability);
    const mode = this.lastColMode ?? MODE_SYNTH_PROFILE;
    // Active appearances always use adaptive density and dedicated synthetic rows.
    const themed =
      this.chartTheme !== null
        ? {
            density: RAMP_THEME,
            synth: RAMP_THEME_SYNTH,
          }
        : null;
    this.ramp = rampForMode(mode, depthTier, this.colormap, themed);
    const heatmap = this.host.heatmap();
    if (heatmap !== null && heatmap.encoding.ramp !== this.ramp) {
      heatmap.encoding = { ...heatmap.encoding, ramp: this.ramp };
    }
    // The channel follows the honesty ramp: a SYNTH session forces 'sum'.
    this.applyChannel();
  }

  /**
   * Record the render mode of the column just written and re-derive the ramp
   * from it (the honesty tier is read inside {@link applyRamp}).
   */
  noteColumnMode(mode: number): void {
    this.lastColMode = mode;
    this.applyRamp();
  }

  /**
   * Active chart theme: owns atlas rows 5/6 and the themable clear color.
   * Pushes the stops into the lut store, re-uploads the atlas into the EXISTING
   * texture (the Heatmap holds a readonly handle — re-specifying keeps every
   * binding valid and leaks nothing), then re-derives the ramp and clears.
   * Idempotent: a repeat call with the same ramps is a no-op (the App effect
   * calls this on every settings change, like {@link setColormap}).
   */
  setChartTheme(theme: ChartThemeInput | null): void {
    const prev = this.chartTheme;
    const same =
      prev === theme ||
      (prev !== null &&
        theme !== null &&
        prev.id === theme.id &&
        prev.density === theme.density &&
        prev.synth === theme.synth &&
        prev.imbalance === theme.imbalance);
    if (same) return;
    this.chartTheme = theme;
    setThemeStops(theme);
    uploadLUTAtlas(this.host.gl(), this.host.lut());
    this.applyRamp();
    this.host.clearBackground();
    this.host.frameState.dirty = true;
  }

  /**
   * Apply the renderer's knobs to a freshly built heatmap, then the active ramp.
   * The GL lifecycle calls this for every ring build (see render/gpuLifecycle.ts).
   */
  configureHeatmap(heatmap: Heatmap): void {
    heatmap.normalizer = this.normalizer;
    heatmap.gamma = this.contrastGamma;
    heatmap.toleranceValue = this.toleranceFloor;
    heatmap.levelFloor = this.tickGroupingLevel();
    heatmap.pixel = this.chartStyle === 'pixel';
    heatmap.dpr = this.host.dpr();
    this.applyRamp();
  }

  /** Heatmap colormap family. Honesty still wins: a SYNTH feed keeps
   *  the amber ramp whatever the user picks. */
  setColormap(colormap: Colormap): void {
    this.colormap = colormap;
    this.applyRamp();
    this.host.frameState.dirty = true;
  }

  /**
   * Heatmap black point (Tolerance) — the normalized-density level below
   * which a cell renders as background. Clamped to the legible band and
   * guarded against non-finite input (a NaN floor blanks the whole heatmap, and
   * this is reachable from `window.__flowmapLive` in dev/e2e builds).
   */
  setTolerance(floor: number): void {
    const f = Number.isFinite(floor) ? floor : 0;
    this.toleranceFloor = Math.min(100, Math.max(0, f));
    const heatmap = this.host.heatmap();
    if (heatmap) heatmap.toleranceValue = this.toleranceFloor;
    this.host.frameState.dirty = true;
  }

  /**
   * Depth channel view: how the two RG density channels render.
   *   'sum'       — (bid+ask) total density. The DEFAULT; bit-identical to
   *                 pre-channel releases (golden tests).
   *   'bid'/'ask' — one side's density alone (norm still the two-sided
   *                 percentile, so intensities scale down accordingly).
   *   'imbalance' — signed (bid−ask)/(bid+ask) on a FIXED [−1,1] domain (no
   *                 histogram fit), colored by the divergent atlas row
   *                 (ask = blue, balanced = quiet neutral, bid = orange).
   * Honesty overrides the user: while the SYNTH amber ramp is active the
   * heatmap keeps rendering 'sum' whatever this is set to (fabricated equity
   * depth has no honest bid/ask direction to show).
   */
  setDepthChannel(mode: DepthChannel): void {
    this.depthChannel = depthChannelOf(mode);
    this.applyChannel();
    this.host.frameState.dirty = true;
  }

  /** The active depth channel setting (getter). */
  getDepthChannel(): DepthChannel {
    return this.depthChannel;
  }

  /**
   * Chart style. `'normal'` is the smooth field and the
   * round-joined price line; `'pixel'` draws the heatmap as posterized device-
   * pixel blocks (colours still come from the active theme and colormap), the
   * price line as a staircase and the trade bubbles as squares. Applied live:
   * the heatmap and overlay flags flip and the next frame redraws, with no
   * reload. Unknown values fall back to 'normal'. Idempotent.
   */
  setChartStyle(style: ChartStyle): void {
    this.chartStyle = chartStyleOf(style);
    const heatmap = this.host.heatmap();
    if (heatmap !== null) heatmap.pixel = this.chartStyle === 'pixel';
    this.host.overlays().setPixelStyle(this.chartStyle === 'pixel');
    this.host.frameState.dirty = true;
  }

  /** The active chart style. */
  getChartStyle(): ChartStyle {
    return this.chartStyle;
  }

  /** Push the effective channel code into the heatmap (see setDepthChannel). */
  private applyChannel(): void {
    const heatmap = this.host.heatmap();
    if (heatmap === null) return;
    const synthetic = this.ramp === RAMP_SYNTH || this.ramp === RAMP_THEME_SYNTH;
    const effective = synthetic ? DEFAULT_DEPTH_CHANNEL : this.depthChannel;
    const code = DEPTH_CHANNEL_CODE[effective];
    if (heatmap.channel !== code) heatmap.channel = code;
  }

  /**
   * Tick grouping: group at least `n` price rows into one heatmap
   * cell by imposing a LOWER BOUND on the SUM-mip level — the displayed block is
   * 4^level ≥ n rows. `n` is clamped to [1, 16]; `n = 1` (the default) is the
   * identity (the level comes from the pixel footprint exactly as before).
   *
   * The ceiling is 16 because mip level 2 is the coarsest block this build's
   * chain can build, so a stored 17..32 is clamped to 16 up front and
   * {@link getTickGrouping} never claims a grouping the chain cannot paint
   * Non-power-of-4 requests can NOT be represented (mips group in 4^k
   * blocks and this build does not stack sub-blocks): they round UP to the next
   * block (2..4 → 4 rows, 5..16 → 16 rows), so the guarantee is "≥ n", never
   * fewer. The crosshair (`probeAt`) reports the true effective block, so the
   * readout never claims a finer grouping than what is painted. With no mip
   * chain (`maxLevel = 0`: float FBOs unavailable / rows % 4 !== 0) the floor is
   * clamped away and rendering is unchanged — documented, not silent.
   */
  setTickGrouping(n: number): void {
    const int = Number.isFinite(n) ? Math.floor(n) : 1;
    this.tickGrouping = clamp(int, 1, TICK_GROUPING_MAX);
    const heatmap = this.host.heatmap();
    if (heatmap !== null) heatmap.levelFloor = this.tickGroupingLevel();
    this.host.frameState.dirty = true;
  }

  /** The requested tick grouping (rows per cell target), 1 = off. */
  getTickGrouping(): number {
    return this.tickGrouping;
  }

  /**
   * The mip level the tick grouping forces, BEFORE the chain clamp: the
   * smallest L with 4^L ≥ n, i.e. ceil(log4 n) = ceil(log2 n / 2). 0 for n ≤ 1.
   * `Math.log2` is exact for powers of two, so n = 4/16 land on exactly 1/2.
   */
  tickGroupingLevel(): number {
    const n = this.tickGrouping;
    if (n <= 1) return 0;
    return Math.ceil(Math.log2(n) / 2);
  }

  /** Viewport-normalization percentile (white-point / Saturation setting).
   *  The normalizer reads it fresh each frame, so this takes effect next draw. */
  setNormPercentile(percentile: number): void {
    const white = Math.min(100, Math.max(80, Number.isFinite(percentile) ? percentile : 99.7));
    this.normalizer.whitePercentile = white;
    // Preserve the default p97/p99.7 shoulder while moving the white endpoint.
    this.normalizer.percentile = Math.max(50, white - 2.7);
    const overview = this.host.overviewSurface();
    if (overview) {
      overview.normalizer.percentile = this.normalizer.percentile;
      overview.normalizer.whitePercentile = white;
    }
    this.host.frameState.dirty = true;
  }

  /** Back to the FLOW ramp at unit decode scale (the preload scenarios' reset). */
  resetEncoding(): void {
    this.decodeScale = 1;
    this.ramp = RAMP_FLOW;
  }

  /** Session reset: the encoding goes back to FLOW and the column mode is forgotten. */
  resetSession(): void {
    this.resetEncoding();
    this.lastColMode = null;
  }

  /** SUM-mip level the current view would sample (0/1/2). The TIME axis counts
   *  too: both axes determine the displayed density block. Mips share the
   *  full-res residency window; selecting a mip never makes history available.
   *
   * `includeFloor = false` reports the NATURAL level (no tick-grouping floor):
   * display diagnostics use it independently of the selected grouping. The
   * crosshair and the viewport
   * normalizer use the floored level, exactly what is painted. */
  currentLevel(includeFloor = true): number {
    const overview = this.host.activeOverview();
    if (overview) return overview.level(overview.view(this.host.frameState.view));
    const m = this.host.mips();
    const maxLevel = m !== null && m.usable ? m.maxLevel : 0;
    const gl = this.host.gl();
    return selectLevel(
      projectedRowsPerPixel(this.host.frameState.view, this.host.axis.overlayPriceMap()?.scale ?? null, gl.drawingBufferHeight),
      maxLevel,
      this.host.frameState.view.colScale / Math.max(1, gl.drawingBufferWidth),
      includeFloor ? this.tickGroupingLevel() : 0,
    ).level;
  }

  /**
   * Recompute u_norm from the VISIBLE window: merge the covered tiles'
   * histograms, extract the percentile, EMA-smooth, and fold the mip scaling.
   * O(tiles in view) — never O(history). Skipped when the normalizer has no data
   * (the perf preload path sets its own fixed norm and never feeds histograms),
   * so the perf gate is untouched. When the EMA is still gliding this keeps
   * the frame dirty so the contrast settles smoothly (~0.3 s) instead of snapping.
   */
  updateNormalization(): void {
    const ring = this.host.ring();
    const heatmap = this.host.heatmap();
    if (ring === null || heatmap === null || !this.normalizer.hasData()) return;

    const range = ring.residentRange();
    if (range === null) return;

    const view = this.host.frameState.view;
    // Visible absolute column span, clamped to the resident window so the tile
    // merge stays bounded even on a whole-ring zoom-out (≤ ring layers).
    const left = Math.floor(view.colOffset);
    const right = Math.floor(view.colOffset + view.colScale);
    const oldest = Math.max(range.oldest, ring.validFromSeq(), Math.min(left, right));
    const newest = Math.min(range.newest, Math.max(left, right));
    if (newest < oldest) return;

    const rowLo = Math.max(0, Math.floor(view.rowOffset));
    const rowHi = Math.min(ring.rows - 1, Math.floor(view.rowOffset + view.rowScale));
    const level = this.currentLevel();
    const scale = this.host.axis.overlayPriceMap()?.scale;
    const shift = scale?.kind === 'linear' ? .5 : 0;
    this.normalizer.channel = heatmap.channel === 3 ? 0 : heatmap.channel;
    this.normalizer.setSnap(this.host.prefersReducedMotion());
    const norm = this.normalizer.updateNorm(
      { oldest, newest },
      { lo: rowLo, hi: rowHi, priceLo: scale ? scaleRowToPrice(scale, view.rowOffset - shift) : undefined,
        priceHi: scale ? scaleRowToPrice(scale, view.rowOffset + view.rowScale - shift) : undefined,
        referenceStep: scale?.kind === 'hybrid' ? scale.coreStep : scale?.step },
      level,
    );
    // Mutate in place: this runs on EVERY dirty frame, and `encoding` has no
    // identity holders (all consumers read its fields), so a fresh object here
    // would be pure per-frame garbage.
    heatmap.encoding.decodeScale = this.decodeScale;
    heatmap.encoding.norm = norm;
    heatmap.encoding.ramp = this.ramp;
    // Note: re-dirtying to keep the EMA gliding is done in frame() AFTER the
    // draw block clears `dirty` — setting it here would be overwritten.
  }

  /** Whether the viewport norm is still gliding toward its target (settle loop). */
  normSettling(): boolean {
    const overview = this.host.activeOverview();
    if (overview) return overview.normalizer.hasData() && !overview.normalizer.settled;
    const heatmap = this.host.heatmap();
    return heatmap !== null && this.normalizer.hasData() && !this.normalizer.settled;
  }
}
