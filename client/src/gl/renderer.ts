/**
 * Live renderer — the end-to-end visible path with pan/zoom.
 *
 * Wires the store's high-frequency column stream to the WebGL2 heatmap:
 *
 *   store.onStream(msg)  →  TileRing.append  →  Camera (view)  →  rAF draw
 *
 * The renderer owns its GL lifecycle (render/gpuLifecycle.ts: the GL context,
 * one {@link TileRing}, one {@link Heatmap} and the thermal LUT) and one
 * {@link Camera}. It subscribes to the store's
 * `onStream` callback (the module-scoped listener Set — NOT React state, so a
 * live feed never triggers a re-render) and, on every {@link DepthColumn},
 * uploads the column into the ring; when the camera is FOLLOWING it re-derives
 * the auto-follow frame so the right edge tracks the newest `col_seq`.
 *
 * view transform: pan/zoom is the {@link Camera} — five scalars → four view
 * uniforms. A user gesture (wheel/drag/keyboard, see input/gestures) turns follow
 * OFF and the view is whatever the camera says; `F`/`R` turn it back on. A
 * column, once uploaded, is NEVER re-uploaded or re-rasterized on pan/zoom, so
 * interaction cost is O(1) in history depth. There is no CPU re-raster of all
 * history on every pan frame.
 *
 * Rendering is rAF-driven but redraws ONLY when `dirty` is set (new column, view
 * change, or resize) — idle frames cost nothing. The GL context uses
 * `preserveDrawingBuffer` so a skipped frame keeps the last image on screen.
 *
 * Bar/Trade/BBO/Marker stream messages are handed to the overlay layer and never
 * crash the renderer.
 *
 * deep scroll-back: the ring is a bounded full-res window over history. When
 * the user pans LEFT past the oldest resident column, the {@link HistoryLoader}
 * fetches older columns and splices them at their true absolute col_seq (the
 * ring slides its window back, evicting the live edge — see gl/tileRing). While
 * the user is scrolled back, live columns at the right edge are NOT written
 * (they'd steal the ring from the viewed region); they resume on go-live. A
 * `webglcontextlost` recreates every GL object and re-fetches the visible range.
 */

import { COLS_PER_TILE, TileRing } from './tileRing';
import { BenchmarkMetrics } from './benchmarkMetrics';
import {
  Heatmap,
  type ChartStyle,
  type DepthChannel,
  type HeatmapView,
} from './heatmap';
import type { Colormap } from './lut';
import type { MipChain } from './mips';
import type { GLContext } from './context';
import {
  Camera,
  limitsFor,
  type PriceFollow,
} from './camera';
import type { ViewportNormalizer } from './normalize';
import { ColumnCache } from './columnCache';
import type { CameraController } from '../input/gestures';
import type { HistoryLoader } from '../net/history';
import type { StreamMsg } from '../net/connection';
import type { FlowMapState } from '../state/store';
import type { DepthColumn, GexLevelUpdate } from '../proto/types';
import { OverlayManager } from './overlays/manager';
import { subscribeTimeZone } from '../i18n/format';
import type { OverlayVisibility } from './overlays/frame';
import type {
  ChartThemeInput,
  CrosshairReadout,
  PerfResult,
  RendererOptions,
  RendererStats,
} from './rendererTypes';
import { AxisMap } from './render/axisMap';
import { OverlayLayer } from './render/overlayLayer';
import { FollowPolicy } from './render/followPolicy';
import { DepthIngest } from './render/depthIngest';
import { createFrameState, type FrameState } from './render/frameState';
import { FrameLoop } from './render/frameLoop';
import { Shading, type ShadingHost } from './render/shading';
import { Viewport } from './render/viewport';
import { TestHooks } from './render/testHooks';
import {
  GpuLifecycle,
  ringLayersFor,
  type GpuHost,
} from './render/gpuLifecycle';

// The public types stay importable from this module; their home is rendererTypes.ts.
export type { ChartThemeInput, CrosshairReadout, PerfResult, RendererOptions, RendererStats } from './rendererTypes';
// The context-lost text stays importable from this module; its home is render/gpuLifecycle.ts.
export { CONTEXT_LOST_MESSAGE } from './render/gpuLifecycle';

/** The renderer only needs the store's imperative surface, not the React hook. */
interface RendererStore {
  getState(): FlowMapState;
}

/**
 * Full-res residency budget: 6144 recent columns = 24 tile layers ×
 * 256 cols. At RG32F (8 B/texel) one column is rows·8 B, so the ring is
 * 6144·rows·8 B — 96 MiB at 2048 rows, 192 MiB at the production
 * 4096-row grid, both ≤ the 300 MB GPU-memory gate. Older ranges are not
 * held full-res; scroll-back re-fetches them (net/history) and deep zoom-out
 * renders from the SUM-mips.
 */
// Include the row-only and SUM mips: ~253 MiB total at 4096 rows. The CPU
// ColumnCache mirrors the same cells at Float32 (bid + ask, 8 B per cell) and
// is NOT part of this figure; it is bounded by the same column budget.
const DEFAULT_CAPACITY_COLS = 6_144;
const DEFAULT_COLUMN_PX = 3;
const DEFAULT_MAX_VISIBLE = 512;

export class Renderer {
  private readonly store: RendererStore;
  private readonly opts: Required<RendererOptions>;
  private readonly benchmark: BenchmarkMetrics | null;
  private benchmarkInput = (event: Event): void => {
    if (event instanceof PointerEvent && (event.buttons === 0 || event.type === 'pointerdown')) return;
    if (event instanceof KeyboardEvent && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'f', 'F', 'r', 'R'].includes(event.key)) return;
    this.benchmark?.input(event.type);
  };
  benchmarkDrain() { return this.benchmark?.drain(this.ingest.pendingDepth) ?? null; }

  /** GL context, LUT, ring and heatmap objects (see render/gpuLifecycle.ts). */
  private readonly gpu: GpuLifecycle;
  private readonly camera: Camera;

  /** Colour, ramp, knob and normalization state (see render/shading.ts). */
  private readonly shading: Shading;
  /** The viewport normalizer, owned by {@link shading}; the GL objects share the same instance. */
  private get normalizer(): ViewportNormalizer {
    return this.shading.normalizer;
  }

  /** Exact CPU column cache: the crosshair readout + instant-recovery data. */
  private readonly columnCache: ColumnCache;
  /** Column scale resolver, delegated so the normalizer and the tests share one resolver (see AxisMap.rawColumnScale). */
  private readonly rawColumnScale = (col: number) => this.axis.rawColumnScale(col);
  /** Overlays, axes and the overlay probes (see render/overlayLayer.ts). */
  private readonly overlayLayer: OverlayLayer;
  /** The overlay manager; tests spy on its methods, so it is read through this getter. */
  private get overlays(): OverlayManager {
    return this.overlayLayer.overlays;
  }

  /** The GL context and GL objects; read through the lifecycle (see render/gpuLifecycle.ts). */
  private get ctx(): GLContext {
    return this.gpu.ctx;
  }
  private get lut(): WebGLTexture {
    return this.gpu.lut;
  }
  private get ring(): TileRing | null {
    return this.gpu.ring;
  }
  private get heatmap(): Heatmap | null {
    return this.gpu.heatmap;
  }
  private get mips(): MipChain | null {
    return this.gpu.mips;
  }
  private get history(): HistoryLoader | null {
    return this.gpu.history;
  }

  /** Shared per-frame state (view, dirty flag, newest column); see render/frameState.ts. */
  private readonly frameState: FrameState;
  /** Column⇄time and price coordinate maps; see render/axisMap.ts. */
  private readonly axis: AxisMap;
  /** Price auto-follow, the time-follow frame and the camera glide (see render/followPolicy.ts). */
  private readonly follow: FollowPolicy;
  /** Stream dispatch and depth-column ingest (see render/depthIngest.ts). */
  private readonly ingest: DepthIngest;
  /** Frame loop: rAF scheduling, render health, the perf run and the stats (see render/frameLoop.ts). */
  private readonly frameLoop: FrameLoop;
  /** Canvas surface, DPR, gestures and the pointer mapping (see render/viewport.ts). */
  private readonly viewport: Viewport;
  /** Test and e2e hooks: preloads, forced framing, scripted perf runs (see render/testHooks.ts). */
  private readonly testHooks: TestHooks;

  /** undefined = manual zoom, null = all resident history, number = duration. */
  get timeWindowMs(): number | null | undefined { return this.follow.requestedTimeWindow; }

  /** A real frame of this session has reached the canvas. No startup placeholder. */
  get marketFrameReady(): boolean {
    const sessionId = this.store.getState().sessionId;
    return sessionId !== null && !this.gpu.contextLostFlag && !this.ingest.awaitingSession
      && this.frameLoop.presentedSessionId === sessionId && this.ingest.lastSessionId === sessionId
      && (this.ring?.residentRange()?.count ?? 0) > 0;
  }

  /** Re-arms the frame when the Time zone preference changes. */
  private readonly unsubscribeZone: () => void;

  private readonly unsubscribeStream: () => void;

  /** The camera-control surface the gestures drive (see render/viewport.ts). */
  private get controller(): CameraController {
    return this.viewport.controller;
  }
  /** The cached device-pixel ratio the backing store was sized for (see render/viewport.ts). */
  private get dpr(): number {
    return this.viewport.devicePixelRatio;
  }

  constructor(canvas: HTMLCanvasElement, store: RendererStore, options: RendererOptions = {}) {
    this.benchmark = options.benchmark ? new BenchmarkMetrics() : null;
    this.store = store;
    this.opts = {
      benchmark: options.benchmark ?? false,
      requireColorBufferFloat: options.requireColorBufferFloat ?? false,
      capacityColsTarget: options.capacityColsTarget ?? DEFAULT_CAPACITY_COLS,
      columnPx: options.columnPx ?? DEFAULT_COLUMN_PX,
      maxVisibleCols: options.maxVisibleCols ?? DEFAULT_MAX_VISIBLE,
    };

    // Provisional limits until the first column reveals the row count; follow ON.
    this.camera = new Camera(limitsFor(1, this.opts.capacityColsTarget));
    this.frameState = createFrameState(this.camera.toView());
    // Axis maps first: the normalizer's sourceColumn closure reads rawColumnScale lazily.
    this.axis = new AxisMap({
      store: this.store,
      frameState: this.frameState,
      columnCache: () => this.columnCache,
      ring: () => this.ring,
      activeOverview: () => this.activeOverview(),
    });

    // GL context, LUT and the ring/heatmap/mips lifecycle. The context is created
    // here, ahead of the CPU caches, which size themselves to its layer limit.
    const gpuHost: GpuHost = {
      store: this.store,
      frameState: this.frameState,
      camera: this.camera,
      axis: this.axis,
      columnCache: () => this.columnCache,
      normalizer: () => this.normalizer,
      overlays: () => this.overlays,
      follow: () => this.follow,
      configureHeatmap: heatmap => this.configureHeatmap(heatmap),
      activeRamp: () => this.shading.activeRamp,
      awaitingSession: () => this.ingest.awaitingSession,
      perfRunning: () => this.frameLoop.perf !== null,
      countUpload: () => this.frameLoop.countUpload(),
      notifyViewChanged: () => this.notifyViewChanged(),
      resize: () => this.viewport.resize(),
      rebuildGL: () => this.recreateGL(),
      spliceColumn: col => this.spliceColumn(col),
      onFrameLost: () => this.frameLoop.onFrameLost(),
      onFrameRestored: () => this.frameLoop.onFrameRestored(),
      setRenderFailure: message => { this.frameLoop.renderFailure = message; },
    };
    this.gpu = new GpuLifecycle(canvas, {
      // Dirty-only render loop: the lifecycle keeps the last frame between draws.
      requireColorBufferFloat: this.opts.requireColorBufferFloat,
      capacityColsTarget: this.opts.capacityColsTarget,
    }, gpuHost);
    if (this.benchmark) {
      for (const kind of ['wheel', 'pointermove', 'keydown']) window.addEventListener(kind, this.benchmarkInput, true);
    }

    // CPU state (no GL) — histograms + exact column cache survive a context
    // loss, so they're built once here and kept across ring rebuilds. The cache
    // is sized to cover the WHOLE ring: a 2048-column cache under a 16 384-column
    // ring made the volume profile silently drop resident columns it could not
    // read (bars under-reported for any window wider than the cache).
    const shadingHost: ShadingHost = {
      store: this.store,
      frameState: this.frameState,
      axis: this.axis,
      rawColumnScale: this.rawColumnScale,
      columnCache: () => this.columnCache,
      gl: () => this.ctx.gl,
      lut: () => this.lut,
      heatmap: () => this.heatmap,
      ring: () => this.ring,
      mips: () => this.mips,
      overlays: () => this.overlays,
      activeOverview: () => this.activeOverview(),
      overviewSurface: () => this.gpu.overviewSurface,
      dpr: () => this.dpr,
      prefersReducedMotion: () => this.prefersReducedMotion(),
      clearBackground: () => this.clearBackground(),
    };
    this.shading = new Shading(shadingHost,
      ringLayersFor(this.opts.capacityColsTarget, this.gpu.ctx.caps.maxArrayTextureLayers) + 1);
    this.columnCache = new ColumnCache({
      capacity: ringLayersFor(this.opts.capacityColsTarget, this.gpu.ctx.caps.maxArrayTextureLayers) * COLS_PER_TILE,
    });

    // Overlays: own GL batches + a 2D text layer sibling over the canvas.
    this.overlayLayer = new OverlayLayer({
      canvas,
      store: this.store,
      frameState: this.frameState,
      axis: this.axis,
      columnCache: () => this.columnCache,
      normalizer: () => this.normalizer,
      gl: () => this.ctx.gl,
      ring: () => this.ring,
      activeOverview: () => this.activeOverview(),
      controller: () => this.controller,
      dpr: () => this.dpr,
      cssWidth: () => this.viewport.cssWidth,
      cssHeight: () => this.viewport.cssHeight,
      glLost: () => this.glLost(),
    });

    // Price auto-follow + camera glide. Built before the first resize(), which refits the follow frame.
    this.follow = new FollowPolicy({
      camera: this.camera,
      frameState: this.frameState,
      axis: this.axis,
      store: this.store,
      columnPx: this.opts.columnPx,
      maxVisibleCols: this.opts.maxVisibleCols,
      ring: () => this.ring,
      overlays: () => this.overlays,
      activeOverview: () => this.activeOverview(),
      overviewComplete: () => this.gpu.overviewComplete(),
      extentLo: () => this.gpu.extents.lo!,
      extentHi: () => this.gpu.extents.hi!,
      extentSeq: () => this.gpu.extents.seq!,
      cssWidth: () => this.viewport.cssWidth,
      cssHeight: () => this.viewport.cssHeight,
      perfRunning: () => this.frameLoop.perf !== null,
      resetHistory: () => this.history?.reset(),
      notifyViewChanged: () => this.notifyViewChanged(),
      applyPriceFitFrame: () => this.applyPriceFitFrame(),
    });
    // Stream dispatch and column ingest: built after every module it writes into
    // and before the stream subscription below (see render/depthIngest.ts).
    this.ingest = new DepthIngest({
      store: this.store,
      frameState: this.frameState,
      gpu: this.gpu,
      axis: this.axis,
      follow: this.follow,
      shading: this.shading,
      overlayLayer: this.overlayLayer,
      camera: this.camera,
      columnCache: this.columnCache,
      benchmark: this.benchmark,
      capacityColsTarget: this.opts.capacityColsTarget,
      updateView: () => this.updateView(),
      forgetPresentedSession: () => this.frameLoop.forgetPresentedSession(),
      countUpload: () => this.frameLoop.countUpload(),
      programsReady: () => this.frameLoop.programsReadyForIngest(),
    });

    // Frame loop: rAF scheduling, render health, the perf run and the stats (see render/frameLoop.ts).
    this.frameLoop = new FrameLoop({
      benchmark: this.benchmark,
      frameState: this.frameState,
      camera: this.camera,
      gpu: this.gpu,
      ingest: this.ingest,
      follow: this.follow,
      shading: this.shading,
      axis: this.axis,
      overlayLayer: this.overlayLayer,
      columnCache: this.columnCache,
      applyPriceFitFrame: () => this.applyPriceFitFrame(),
    });
    // Canvas surface, DPR, gestures and the pointer mapping (see render/viewport.ts).
    this.viewport = new Viewport({
      canvas,
      store: this.store,
      frameState: this.frameState,
      camera: this.camera,
      gpu: this.gpu,
      axis: this.axis,
      shading: this.shading,
      follow: this.follow,
      columnCache: this.columnCache,
      updateView: () => this.updateView(),
    });
    // Test and e2e hooks: built last, since they drive every module above (see render/testHooks.ts).
    this.testHooks = new TestHooks({
      canvas,
      gpu: this.gpu,
      camera: this.camera,
      frameState: this.frameState,
      axis: this.axis,
      shading: this.shading,
      columnCache: this.columnCache,
      overlayLayer: this.overlayLayer,
      ingest: this.ingest,
      follow: this.follow,
      frameLoop: this.frameLoop,
      viewport: this.viewport,
    });

    // Match the backing store to the CSS box, then paint the background once so
    // the pre-data canvas is the terminal near-black, not transparent garbage.
    this.viewport.resize();
    this.clearBackground();
    this.viewport.attach();

    this.unsubscribeStream = store.getState().onStream(this.ingest.onMessage);
    this.unsubscribeZone = subscribeTimeZone(() => {
      this.frameState.dirty = true;
    });

    // Start compilation after initialization's GL queries. Poll it on rAF so
    // cold driver compilation cannot freeze the UI or the incoming stream. A
    // link failure here must not throw out of the constructor (the app would
    // report WebGL as unavailable): record it and let the frame loop retry.
    try {
      this.frameLoop.programsReady();
    } catch (err) {
      this.frameLoop.renderFailure = err instanceof Error ? err.message : String(err);
    }
    this.frameLoop.start();
  }

  /** Newest absolute col_seq appended (or -1 before any column). Diagnostics. */
  get newestColSeq(): number {
    return this.frameState.newestSeq;
  }

  /**
   * First resident col_seq whose ring slot provably holds THAT column (-1
   * before any append). Normally the window oldest; it sits higher only when a
   * forward skip's band could NOT be repaired (band > the zero-fill limit in render/depthIngest.ts),
   * in which case the heatmap gates everything below it to background.
   * Diagnostics / e2e (the vanish probe's ground truth).
   */
  get validFromSeq(): number {
    return this.gpu.validFromSeq();
  }

  /** Resident absolute col_seq range (or null before any column). Diagnostics. */
  residentRange(): ReturnType<GpuLifecycle['residentRange']> {
    return this.gpu.residentRange();
  }

  /** Whether the camera is auto-following the live right edge. Diagnostics. */
  get following(): boolean {
    return this.camera.followTime;
  }

  /** How the PRICE axis is auto-scaling ('fit' | 'track' | 'off'). Diagnostics. */
  get priceFollow(): PriceFollow {
    return this.camera.followPrice;
  }

  /**
   * The TIME-follow POLICY the user/settings asked for - unlike
   * {@link following}, which is false both when the policy is off AND while
   * merely scrolled back. The App reconciles persisted settings against this.
   */
  get wantedFollowTime(): boolean {
    return this.follow.wantFollowTime;
  }

  /**
   * is the newest resident column inside the current view? This is the
   * condition `stepPriceFollow` gates on — when it is false (scrolled back),
   * TRACK cannot act, so the UI must not present it as armed.
   *
   * Read from the LOGICAL camera frame, not the eased draw view: the eased edge
   * trails by up to TIME_GLIDE_MAX_LAG columns while gliding, and a whole-column
   * visibility contract answered "sometimes" mid-glide would strobe the TRK·WAIT
   * chip. Follow policy is about where the camera IS pinned, not where the
   * presentation is still catching up.
   */
  get liveEdgeVisible(): boolean {
    return this.follow.liveEdgeVisible;
  }

  /** A copy of the current view uniforms. Diagnostics / e2e. */
  get viewSnapshot(): HeatmapView {
    return { ...this.frameState.view };
  }

  /**
   * Active colormap row (RAMP_INFERNO 0 / RAMP_FLOW 3 / RAMP_SYNTH 1) — the heatmap encoding's
   * ramp when a heatmap exists, else the mode selected by the last column.
   * Diagnostics / e2e (asserts a SYNTH_PROFILE session renders the amber ramp).
   */
  get currentRamp(): number {
    return this.heatmap?.encoding.ramp ?? this.shading.activeRamp;
  }

  /** Full-res residency budget in columns (ring capacity). Diagnostics / e2e. */
  get residentBudgetCols(): number {
    return this.gpu.residentBudgetCols();
  }

  /** Whether an absolute col_seq is resident full-res. Diagnostics / e2e. */
  isResidentFullRes(colSeq: number): boolean {
    return this.gpu.isResidentFullRes(colSeq);
  }

  /** Scroll-back backfill counters (or null before the ring exists). e2e hook. */
  historyStats(): ReturnType<GpuLifecycle['historyStats']> {
    return this.gpu.historyStats();
  }

  /** Context-loss/restore counters. e2e recovery hook. */
  get contextLostCount(): number {
    return this.gpu.contextLostCount;
  }
  get contextRestoredCount(): number {
    return this.gpu.contextRestoredCount;
  }

  /** Force a WebGL context loss via WEBGL_lose_context (e2e only). */
  loseContextForTest(): boolean {
    return this.gpu.loseContextForTest();
  }

  /** Restore a context lost via {@link loseContextForTest} (e2e only). */
  restoreContextForTest(): void {
    this.gpu.restoreContextForTest();
  }

  dispose(): void {
    if (this.benchmark) {
      for (const kind of ['wheel', 'pointermove', 'keydown']) window.removeEventListener(kind, this.benchmarkInput, true);
    }
    this.normalizer.dispose();
    this.gpu.resetOverview();
    this.frameLoop.stop();
    this.viewport.dispose();
    this.overlayLayer.disposeAxisGestures();
    this.unsubscribeStream();
    this.unsubscribeZone();
    this.overlays.dispose();
    this.gpu.dispose();
    this.ingest.pendingDepth.length = 0;
  }

  // --- overlays -----------------------------------------------------------

  /** Attach the App-owned price/time gutter canvases for axis drawing. */
  attachOverlaySurfaces(
    priceAxisCanvas: HTMLCanvasElement | null,
    timeAxisCanvas: HTMLCanvasElement | null,
  ): void {
    this.overlayLayer.attachOverlaySurfaces(priceAxisCanvas, timeAxisCanvas);
  }

  /**
   * The time-axis gutter canvas the overlay layer draws into, or null before one is
   * attached. The App's price-axis component reads it to rebind both gutters together.
   */
  timeAxisCanvas(): HTMLCanvasElement | null {
    return this.overlayLayer.timeAxisCanvas();
  }

  /**
   * Re-match both gutter backing stores to their own live CSS boxes at `dpr`
   * (see OverlayManager.syncGutters). True when a backing store changed size.
   */
  syncGutters(dpr: number): boolean {
    return this.overlayLayer.syncGutters(dpr);
  }

  /** Toggle which overlays render (App visibility state). */
  setOverlayVisibility(v: Partial<OverlayVisibility>): void {
    this.overlayLayer.setOverlayVisibility(v);
  }

  /** Which overlays are currently on (App reads this to seed its toggles). */
  overlayVisibility(): OverlayVisibility {
    return this.overlayLayer.overlayVisibility();
  }

  /** Bubble draw threshold (min trade size), settings. */
  setBubbleMinSize(minSize: number): void {
    this.overlayLayer.setBubbleMinSize(minSize);
  }

  setGex(gex: GexLevelUpdate | null): void {
    this.overlayLayer.setGex(gex);
  }

  getGex(): GexLevelUpdate | null {
    return this.overlayLayer.getGex();
  }

  /** Heatmap display gamma (Contrast setting); see Shading.setContrast. */
  setContrast(gamma: number): void {
    this.shading.setContrast(gamma);
  }

  /** Active chart theme (atlas rows 5/6 and the themable clear color); see Shading.setChartTheme. */
  setChartTheme(theme: ChartThemeInput | null): void {
    this.shading.setChartTheme(theme);
  }

  /** Apply the renderer's knobs to a freshly built heatmap (see Shading.configureHeatmap). */
  private configureHeatmap(heatmap: Heatmap): void {
    this.shading.configureHeatmap(heatmap);
  }

  /** Heatmap colormap family; honesty still wins (see Shading.setColormap). */
  setColormap(colormap: Colormap): void {
    this.shading.setColormap(colormap);
  }

  /** Heatmap black point (Tolerance); see Shading.setTolerance. */
  setTolerance(floor: number): void {
    this.shading.setTolerance(floor);
  }

  /** Depth channel view; see Shading.setDepthChannel for the modes and the honesty rule. */
  setDepthChannel(mode: DepthChannel): void {
    this.shading.setDepthChannel(mode);
  }

  /** The active depth channel setting (getter). */
  getDepthChannel(): DepthChannel {
    return this.shading.getDepthChannel();
  }

  /** Chart style (normal field or pixel blocks); see Shading.setChartStyle. */
  setChartStyle(style: ChartStyle): void {
    this.shading.setChartStyle(style);
  }

  /**
   * Why the last frame failed, or null while frames render. A persistent shader
   * link failure is reported here, instead of leaving the chart blank behind a
   * "Preparing chart" status.
   */
  getRenderFailure(): string | null {
    return this.frameLoop.getRenderFailure();
  }

  /**
   * Re-arm after a render failure: clears the recorded cause so the startup gate
   * and the fallback stop reporting it (see FrameLoop.retryRender).
   */
  retryRender(): void {
    this.frameLoop.retryRender();
  }

  /** The active chart style. */
  getChartStyle(): ChartStyle {
    return this.shading.getChartStyle();
  }

  /** Tick grouping (rows per cell floor, 1 = off); see Shading.setTickGrouping. */
  setTickGrouping(n: number): void {
    this.shading.setTickGrouping(n);
  }

  /** The requested tick grouping (rows per cell target), 1 = off. */
  getTickGrouping(): number {
    return this.shading.getTickGrouping();
  }

  /**
   * Subscribe to "the camera view moved" (design enabler for crosshair sync).
   * The listeners run on the hot path and are isolated (see Viewport.onViewChanged).
   */
  onViewChanged(cb: () => void): () => void {
    return this.viewport.onViewChanged(cb);
  }

  /** Fire the view-changed listeners (see Viewport.notifyViewChanged). */
  private notifyViewChanged(): void {
    this.viewport.notifyViewChanged();
  }

  /**
   * Render-health snapshot: `{fps, frameMs, uploads, draws,
   * cacheBytes}`. O(1); the counters are maintained inside the existing rAF
   * frame (fps/frameMs EMA-smoothed with alpha ≈ 0.1); this call only copies
   * five numbers into the returned object — safe to poll at a few Hz.
   */
  stats(): RendererStats {
    return this.frameLoop.stats();
  }

  /** Viewport-normalization percentile (white-point / Saturation setting); see Shading.setNormPercentile. */
  setNormPercentile(percentile: number): void {
    this.shading.setNormPercentile(percentile);
  }

  /**
   * Read-only timeline geometry for the minimap + replay seek (see AxisMap.timeline).
   * Null before the first column. Cheap — the Timeline polls it at ≤4 Hz.
   */
  timeline(): ReturnType<AxisMap['timeline']> {
    return this.axis.timeline();
  }

  /** Choose a real time duration without changing the user's follow policy. */
  setTimeWindowMs(durationMs: number | null): boolean {
    return this.follow.setTimeWindowMs(durationMs);
  }

  /**
   * The CVD (cumulative volume delta) points inside the given absolute-column
   * span (see OverlayLayer.cvdSeries). Mapped through the same timeline() transform.
   */
  cvdSeries(loCol: number, hiCol: number): Array<{ col: number; cvd: number }> {
    return this.overlayLayer.cvdSeries(loCol, hiCol);
  }

  /** Cumulative CVD at one column (O(1)); see OverlayLayer.cvdValueAt. */
  cvdValueAt(colSeq: number): number {
    return this.overlayLayer.cvdValueAt(colSeq);
  }

  /** Includes historical corrections, which can leave the live tip unchanged. */
  get cvdRevision(): number {
    return this.overlayLayer.cvdRevision;
  }

  /**
   * First-launch history depth: eagerly pull up to `targetCols` columns of
   * history into the ring so the chosen span is instantly available on scroll-back
   * (the server seeds the deep tail; this loads it). One-shot and bounded — safe
   * because the ring is nearly empty at launch. No-op when history isn't ready.
   */
  prefetchHistory(targetCols: number): void {
    this.gpu.prefetchHistory(targetCols);
  }

  /** `Space` (live mode) / `F`: toggle auto-follow of the live right edge. */
  toggleFollow(): void {
    this.controller.toggleFollow();
  }

  /** Re-pin TIME to the live edge; the price axis (zoom + follow mode) is kept
   *  exactly as the user left it (the `R` / Go-Live control). */
  goLive(): void {
    this.controller.goLive();
  }

  /**
   * Zoom the price axis about the centre of the grid, for the keyboard price-zoom
   * control. `factor` multiplies the visible price span: below 1 zooms in, above 1
   * zooms out. The axis drag and the gutter wheel share this path.
   */
  zoomPriceCentered(factor: number): void {
    this.controller.scalePriceCentered(factor);
  }

  /**
   * Reset the heatmap renderer to a clean, empty slate for a NEW subscription
   * (a symbol / market switch). The full contract is documented on
   * {@link DepthIngest.resetForSession}; the GL teardown waits for a live context.
   */
  resetForSession(): void {
    this.ingest.resetForSession();
  }

  /**
   * Cursor-only reset for a NEW session on the same subscription (see
   * {@link DepthIngest.resetOverlaysForNewSession}). The ring survives.
   */
  resetOverlaysForNewSession(sessionId?: string): void {
    this.ingest.resetOverlaysForNewSession(sessionId);
  }

  // --- gesture control (see render/viewport.ts) ---------------------------------

  /** Turn TIME follow on/off (`Space` in live mode, `F`, the transport pill). */
  setFollowTime(on: boolean): void {
    this.follow.setFollowTime(on);
  }

  /** Set the PRICE follow mode (`P`, the axis chip, a gutter double-click). */
  setPriceFollow(mode: PriceFollow): void {
    this.follow.setPriceFollow(mode);
  }

  // --- stream handling (the ingest lives in render/depthIngest.ts) -----------

  /** The history splice sink the loader and the GPU lifecycle call (see DepthIngest.spliceColumn). */
  private spliceColumn = (col: DepthColumn): void => {
    this.ingest.spliceColumn(col);
  };

  /** The overview surface when the view is zoomed out past the ring, else null. */
  private activeOverview(): ReturnType<GpuLifecycle['activeOverview']> {
    return this.gpu.activeOverview();
  }

  /** The coarse overview surface whatever the view (diagnostics and e2e). */
  get overviewSurface(): GpuLifecycle['overviewSurface'] {
    return this.gpu.overviewSurface;
  }

  overviewStats(): ReturnType<GpuLifecycle['overviewStats']> {
    return this.gpu.overviewStats();
  }

  /** Paint the terminal near-black (see GpuLifecycle.clearBackground). */
  private clearBackground(): void {
    this.gpu.clearBackground();
  }

  // --- view + draw --------------------------------------------------------------

  /** Recompute the view uniforms (see FollowPolicy.updateView). */
  private updateView(): void {
    this.follow.updateView();
  }

  /** Price auto-fit of the follow frame (see FollowPolicy.applyPriceFit). */
  private applyPriceFitFrame(): boolean {
    return this.follow.applyPriceFit();
  }

  /** The OS asks for reduced motion (WCAG 2.3.3): glides snap instead of easing. */
  private prefersReducedMotion(): boolean {
    return this.follow.prefersReducedMotion();
  }

  /** Test seam: the current eased live-edge lag in columns (0 = settled). */
  get liveEdgeLagColumns(): number {
    return this.follow.liveLag;
  }

  /** The device-pixel ratio the backing store was last sized for. */
  get devicePixelRatio(): number {
    return this.dpr;
  }

  /**
   * True while the frame runs without EXT_color_buffer_float: mip levels are
   * unavailable, so zoomed-out walls are averaged by sampling and read coarser.
   * The App requires EXT_color_buffer_float, so this is a diagnostic flag only.
   */
  isReducedDensity(): boolean {
    return this.viewport.isReducedDensity();
  }

  /** SUM-mip level the current view samples (0/1/2); see Shading.currentLevel. */
  private currentLevel(includeFloor = true): number {
    return this.shading.currentLevel(includeFloor);
  }

  /**
   * Crosshair readout at a canvas CSS pixel: the exact CPU column-cache read
   * (see Viewport.probeAt). Null before the first column.
   */
  probeAt(cssX: number, cssY: number): CrosshairReadout | null {
    return this.viewport.probeAt(cssX, cssY);
  }

  /**
   * test hook: the true start time (ns) of a (fractional) column, using the
   * piecewise slot table when it covers the column, else the affine map. e2e
   * verification of the reconstructed-history time warp.
   */
  timestampAtColumn(col: number): bigint | null {
    return this.axis.timestampAtColumn(col);
  }

  /**
   * test hook: the (fractional) column containing `tsNs`, piecewise when the
   * slot table covers it, else the affine inverse. e2e verification hook.
   */
  columnAtTimestamp(tsNs: bigint): number | null {
    return this.axis.columnAtTimestamp(tsNs);
  }

  colToTsForTest(col: number): bigint | null { return this.timestampAtColumn(col); }
  colForTsForTest(tsNs: bigint): number | null { return this.columnAtTimestamp(tsNs); }

  // --- context-loss lifecycle (delegates; see render/gpuLifecycle.ts) -----

  /** Rebuild every GL object after a restore (a spy target: the restore path calls it by name). */
  private recreateGL(): void {
    this.gpu.recreateGL();
  }

  /** True while the GL context is lost, including the window before `webglcontextlost` fires. */
  private glLost(): boolean {
    return this.gpu.glLost();
  }

  // --- test-only perf hooks (driven by tests/e2e/perf.spec) ---------------------

  /** Frames drawn so far (monotonic). */
  get drawCount(): number {
    return this.frameLoop.drawCount;
  }

  /** performance.now() at the end of the last draw (input→frame latency proxy). */
  get lastDrawEndTs(): number {
    return this.frameLoop.lastDrawEndTs;
  }

  /** SUM-mip level the current view samples (0/1/2). e2e scroll-back hook. */
  get currentMipLevel(): number {
    return this.currentLevel();
  }

  /** Deterministic time pan by `dCols` absolute columns (disables follow, like a
   * drag). Drives the real backfill on the next frame. e2e only. */
  panColumnsForTest(dCols: number): void {
    this.testHooks.panColumnsForTest(dCols);
  }

  /** Deterministic price zoom (factor>1 = zoom out → coarser mip). e2e only. */
  zoomPriceForTest(factor: number): void {
    this.testHooks.zoomPriceForTest(factor);
  }

  /** Deterministic time zoom through the same path as a centered user gesture. */
  zoomTimeForTest(factor: number): void {
    this.testHooks.zoomTimeForTest(factor);
  }

  /**
   * Preload `count` deterministic synthetic columns into a fresh ring for the perf
   * gate (see TestHooks.preloadSynthetic). Returns the ring geometry and bytes.
   */
  preloadSynthetic(count: number, rows: number): ReturnType<TestHooks['preloadSynthetic']> {
    return this.testHooks.preloadSynthetic(count, rows);
  }

  /**
   * Preload the normalization/crosshair e2e scenario, network bypassed (see
   * TestHooks.preloadNormalizeScenario).
   */
  preloadNormalizeScenario(): ReturnType<TestHooks['preloadNormalizeScenario']> {
    return this.testHooks.preloadNormalizeScenario();
  }

  /** Set the view directly from edge/scale form (e2e framing). Follow off. */
  setViewForTest(colOffset: number, colScale: number, rowOffset: number, rowScale: number): void {
    this.testHooks.setViewForTest(colOffset, colScale, rowOffset, rowScale);
  }

  /** Forward map a grid cell CENTER to canvas CSS pixels (see Viewport.cellToCanvasCss). */
  cellToCanvasCss(colSeq: number, row: number): { x: number; y: number } {
    return this.viewport.cellToCanvasCss(colSeq, row);
  }

  /** Continuous projection for drawings/indicators (see Viewport.canvasCssToGrid). */
  canvasCssToGrid(x: number, y: number): { col: number; row: number } | null {
    return this.viewport.canvasCssToGrid(x, y);
  }

  /** Grid cell to canvas CSS pixel (see Viewport.gridToCanvasCss). */
  gridToCanvasCss(col: number, row: number): { x: number; y: number } {
    return this.viewport.gridToCanvasCss(col, row);
  }

  /** The EMA-smoothed norm currently fed to u_norm (e2e diagnostics). */
  get currentNorm(): number {
    return this.normalizer.current;
  }

  /** The CPU viewport normalizer (test/e2e diagnostics: histogram totals). */
  get normalizerForTest(): ViewportNormalizer {
    return this.normalizer;
  }

  /**
   * Test-only: pin the viewport norm so repeated grabs of a sealed
   * frame cannot drift through the EMA glide. See
   * {@link ViewportNormalizer.freezeForTest}; cleared by session reset.
   */
  freezeNormForTest(value?: number): void {
    this.normalizer.freezeForTest(value);
  }

  /** The exact CPU column cache (test/e2e diagnostics). */
  get columnCacheForTest(): ColumnCache {
    return this.columnCache;
  }

  /** The shared frame record (view, dirty flag, newest column). Test hook. */
  get frameStateForTest(): FrameState {
    return this.frameState;
  }

  /** The follow policy (price-fit and tracked-row state). Test hook. */
  get followForTest(): FollowPolicy {
    return this.follow;
  }

  /**
   * Force one synchronous full frame and return the canvas as a PNG data URL, the
   * snapshot contract the export and share flows build on. Null while the context
   * is lost (see TestHooks.snapshot).
   */
  snapshot(): string | null {
    return this.testHooks.snapshot();
  }

  // --- overlay e2e hooks (driven by tests/e2e/overlays.spec) ---------------------

  /** Ingest a synthetic overlay stream message through the live path. e2e only (see TestHooks.ingestForTest). */
  ingestForTest(msg: StreamMsg): void {
    this.testHooks.ingestForTest(msg);
  }

  /**
   * Forward-map an overlay event `(ts_ns, price)` to canvas CSS px through the
   * SAME transform the overlays use (see OverlayLayer.overlayPointCss).
   */
  overlayPointCss(tsNs: bigint, price: number): { x: number; y: number } | null {
    return this.overlayLayer.overlayPointCss(tsNs, price);
  }

  /** Overlay data counts + last profile result. e2e diagnostics. */
  overlayDebugForTest(): ReturnType<OverlayLayer['overlayDebugForTest']> {
    return this.overlayLayer.overlayDebugForTest();
  }

  /** The BBO the overlay would draw for the CURRENT session, or null (see OverlayLayer). e2e. */
  overlayEffectiveBboForTest(): ReturnType<OverlayLayer['overlayEffectiveBboForTest']> {
    return this.overlayLayer.overlayEffectiveBboForTest();
  }

  /** Canvas CSS px y of a price row edge (for BBO / axis line sampling). e2e. */
  overlayRowCss(rowf: number): number {
    return this.overlayLayer.overlayRowCss(rowf);
  }

  /**
   * Preload the deterministic overlay scenario and frame it (see
   * TestHooks.preloadOverlayScenario). Returns plain numbers only (no BigInt).
   */
  preloadOverlayScenario(): ReturnType<TestHooks['preloadOverlayScenario']> {
    return this.testHooks.preloadOverlayScenario();
  }

  /** Run a scripted continuous PAN for `durationMs`; resolves with frame timing. */
  perfPan(durationMs: number, panStepCols = 2): Promise<PerfResult> {
    return this.testHooks.perfPan(durationMs, panStepCols);
  }

  /** Run a scripted continuous time ZOOM for `durationMs`; resolves with timing. */
  perfZoom(durationMs: number): Promise<PerfResult> {
    return this.testHooks.perfZoom(durationMs);
  }
}
