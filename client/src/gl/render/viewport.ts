/**
 * Viewport of the live renderer: the canvas surface and the device-pixel ratio
 * (backing-store sizing, the `(resolution)` watch and the reduced-density flag),
 * the camera gesture controller and the view-changed listeners, and the
 * pointer-to-data mapping (probeAt and the grid/CSS transforms). Renderer keeps one-line delegates with the same
 * names, and reads the controller through its getter.
 */
import { sanitizeDpr } from '../heatmap';
import { KILL_PRICE, KILL_TIME, screenToGrid, type Camera } from '../camera';
import { panFollowKill } from '../follow';
import { applyChartAccessibility } from '../chartAccessibility';
import { attachGestures, type CameraController } from '../../input/gestures';
import { mapScale } from '../overlays/coords';
import { quoteDecimals } from '../overlays/axisTicks';
import {
  priceToRow as scalePriceToRow,
  rowToPrice as scaleRowToPrice,
  stepAtRow as scaleStepAtRow,
} from '../priceScale';
import { fractionRow, rowFraction } from '../priceProjection';
import type { ColumnCache } from '../columnCache';
import type { CrosshairReadout } from '../rendererTypes';
import { isSessionClockMarket } from './overlayLayer';
import type { AxisMap } from './axisMap';
import type { FollowPolicy } from './followPolicy';
import type { FrameState, StateSource } from './frameState';
import type { GpuLifecycle } from './gpuLifecycle';
import type { Shading } from './shading';

/** Keyboard pan step as a fraction of the current viewport span. */
const KEY_PAN_FRAC = 0.15;

/**
 * What the viewport reads from its owner. The modules are live references; the
 * `updateView` closure keeps the Renderer method (a spy target) on the path.
 */
export interface ViewportHost {
  readonly canvas: HTMLCanvasElement;
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly camera: Camera;
  readonly gpu: GpuLifecycle;
  readonly axis: AxisMap;
  readonly shading: Shading;
  readonly follow: FollowPolicy;
  readonly columnCache: ColumnCache;
  updateView(): void;
}

export class Viewport {
  private readonly host: ViewportHost;
  private readonly canvas: HTMLCanvasElement;
  private readonly store: StateSource;
  private readonly frameState: FrameState;
  private readonly camera: Camera;
  private readonly gpu: GpuLifecycle;
  private readonly axis: AxisMap;
  private readonly shading: Shading;
  private readonly follow: FollowPolicy;
  private readonly columnCache: ColumnCache;

  /** Watches the current devicePixelRatio; re-armed on each change. */
  private dprQuery: MediaQueryList | null = null;
  /**
   * The ONE cached device-pixel ratio. Only {@link syncDpr} reads
   * `window.devicePixelRatio`; the drawing buffer, the overlay gutters and the
   * heatmap footprint math all use this value, so they cannot disagree.
   */
  private dpr = 1;

  /** Last resize() inputs; a ResizeObserver callback that didn't change the CSS
   *  box or the DPR is a no-op (no refit, no redraw, no backfill probe). */
  private lastResizeCssW = -1;
  private lastResizeCssH = -1;
  private lastResizeDpr = 0;
  private resizeObserver: ResizeObserver | null = null;
  private gesturesDispose: (() => void) | null = null;
  /** The camera-control surface the gestures drive; also the app-keyboard target. */
  readonly controller: CameraController;

  /** `onViewChanged` listeners (the renderer's view-moved seam; no consumers yet). */
  private readonly viewChangedListeners = new Set<() => void>();
  /** One-shot guard so a throwing view listener warns once, never per column. */
  private viewChangedWarned = false;

  constructor(host: ViewportHost) {
    this.host = host;
    this.canvas = host.canvas;
    this.store = host.store;
    this.frameState = host.frameState;
    this.camera = host.camera;
    this.gpu = host.gpu;
    this.axis = host.axis;
    this.shading = host.shading;
    this.follow = host.follow;
    this.columnCache = host.columnCache;
    this.controller = this.makeController();
  }

  /**
   * Start watching the canvas box and the DPR and attach the gestures and the
   * accessibility labels. Called once by the Renderer after the first resize().
   */
  attach(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.armDprWatch();
    applyChartAccessibility(this.canvas);
    this.gesturesDispose = attachGestures(this.canvas, this.controller);
  }

  /** Disconnect the observers and detach the gestures. */
  dispose(): void {
    this.resizeObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    this.gesturesDispose?.();
  }

  /** The CSS width the backing store was last sized for (the follow and overlay layouts read it). */
  get cssWidth(): number {
    return this.lastResizeCssW;
  }

  /** The CSS height the backing store was last sized for. */
  get cssHeight(): number {
    return this.lastResizeCssH;
  }

  /**
   * Moving the window to a monitor with another scale factor changes the device-
   * pixel ratio without changing the CSS box, so ResizeObserver stays silent and
   * the backing store keeps the old resolution. A `(resolution)` query
   * matches only the ratio it was built for, so it fires exactly on a change; it
   * is re-armed for the new ratio each time.
   */
  private onDprChange = (): void => {
    this.resize();
    this.frameState.dirty = true;
    this.armDprWatch();
  };

  private armDprWatch(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.dprQuery = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  /**
   * Refresh the cached ratio from the window and hand it to the heatmap. The
   * only reader of `window.devicePixelRatio` in the renderer.
   */
  private syncDpr(): number {
    this.dpr = sanitizeDpr(typeof window === 'undefined' ? 1 : window.devicePixelRatio);
    if (this.gpu.heatmap !== null) this.gpu.heatmap.dpr = this.dpr;
    return this.dpr;
  }

  /** The device-pixel ratio the backing store was last sized for. */
  get devicePixelRatio(): number {
    return this.dpr;
  }

  /**
   * True while the frame runs without EXT_color_buffer_float: mip levels are
   * unavailable, so zoomed-out walls are averaged by sampling and read coarser.
   * The App hard-requires EXT_color_buffer_float, so this stays false in the app
   * and reads true only on a context built without it (diagnostics and tests).
   */
  isReducedDensity(): boolean {
    return !this.gpu.ctx.caps.colorBufferFloat;
  }

  resize(): void {
    const dpr = this.syncDpr();
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    // The ResizeObserver fires on layout churn that leaves the CSS box (and the
    // backing store) unchanged — skip the refit/redirty/backfill-probe in that
    // case. First call always runs (sentinels -1 / 0).
    const changed = cw !== this.lastResizeCssW || ch !== this.lastResizeCssH || dpr !== this.lastResizeDpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.lastResizeCssW = cw;
    this.lastResizeCssH = ch;
    this.lastResizeDpr = dpr;
    if (!changed) return;
    // Visible-column count depends on CSS width; refit (follow) and repaint.
    this.host.updateView();
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
  }

  /**
   * Subscribe to "the camera view moved" (design enabler for crosshair sync,
   * Fired synchronously whenever the view uniforms actually change:
   * gestures/keyboard (onCameraChanged), the per-column time-follow reframe, the
   * price-follow glide, resize, and the e2e setView hook. No consumers today;
   * callbacks run on the hot path (per appended column while following), so they
   * must stay cheap and must not throw — a throwing listener is isolated and
   * warned once, exactly like the stream fanout.
   */
  onViewChanged(cb: () => void): () => void {
    this.viewChangedListeners.add(cb);
    return () => {
      this.viewChangedListeners.delete(cb);
    };
  }

  notifyViewChanged(): void {
    for (const cb of this.viewChangedListeners) {
      try {
        cb();
      } catch (err) {
        if (!this.viewChangedWarned) {
          this.viewChangedWarned = true;
          console.warn('[flowmap] onViewChanged listener failed (suppressed):', err);
        }
      }
    }
  }

  // --- gesture control (input/gestures → Camera) --------------------------------

  makeController(): CameraController {
    const cssW = (): number => Math.max(1, this.canvas.clientWidth);
    const cssH = (): number => Math.max(1, this.canvas.clientHeight);
    return {
      panByPixels: (dx, dy, drag) => {
        // Natural drag: content follows the cursor. Right → earlier columns
        // (colCenter decreases); down → higher rows (rowCenter increases).
        const dCols = -(dx / cssW()) * this.frameState.view.colScale;
        const dRows = (dy / cssH()) * this.frameState.view.rowScale;
        this.follow.pendingOverviewFit = false;
        // Per-axis release from PEAK displacement, so a deliberately horizontal
        // drag keeps price tracking (gl/follow.ts panFollowKill).
        this.camera.pan(dCols, dRows, panFollowKill(drag.peakDx, drag.peakDy));
        this.follow.onCameraChanged();
      },
      zoomTimeAtFraction: (factor, fracX) => {
        this.follow.pendingOverviewFit = false;
        this.follow.requestedTimeWindow = undefined;
        const anchorCol = this.frameState.view.colOffset + this.frameState.view.colScale * fracX;
        this.camera.zoomTime(factor, anchorCol);
        this.follow.userTimeZoomed = true; // user-owned span: follow must preserve it
        this.follow.onCameraChanged();
      },
      zoomPriceAtFraction: (factor, fracFromTop) => {
        this.follow.pendingOverviewFit = false;
        // uv.y = 0 at the bottom of the grid; the cursor's y grows downward.
        const uvY = 1 - fracFromTop;
        this.follow.preparePriceOverview();
        const anchorRow = fractionRow(this.frameState.view, this.camera.priceScale, uvY);
        this.camera.zoomPrice(factor, anchorRow);
        this.follow.onCameraChanged();
      },
      scalePriceCentered: (factor) => {
        this.follow.pendingOverviewFit = false;
        this.follow.preparePriceOverview();
        this.camera.zoomPrice(factor, fractionRow(this.frameState.view, this.camera.priceScale, 0.5));
        this.follow.onCameraChanged();
      },
      panTimeSteps: (dir) => {
        this.follow.pendingOverviewFit = false;
        this.camera.pan(dir * this.frameState.view.colScale * KEY_PAN_FRAC, 0, KILL_TIME);
        this.follow.onCameraChanged();
      },
      panPriceSteps: (dir) => {
        this.follow.pendingOverviewFit = false;
        this.camera.pan(0, dir * this.frameState.view.rowScale * KEY_PAN_FRAC, KILL_PRICE);
        this.follow.onCameraChanged();
      },
      zoomTimeCentered: (factor) => {
        this.follow.pendingOverviewFit = false;
        this.follow.requestedTimeWindow = undefined;
        this.camera.zoomTime(factor, this.camera.state.colCenter);
        this.follow.userTimeZoomed = true; // user-owned span: follow must preserve it
        this.follow.onCameraChanged();
      },
      toggleFollow: () => {
        this.follow.setFollowTime(!this.camera.followTime);
      },
      togglePriceFollow: () => {
        this.follow.setPriceFollow(this.camera.followPrice === 'off' ? 'track' : 'off');
      },
      setPriceFollow: (mode) => {
        this.follow.setPriceFollow(mode);
      },
      setFollowTime: (on) => {
        this.follow.setFollowTime(on);
      },
      goLive: () => {
        this.follow.goLive();
      },
    };
  }

  /**
   * Crosshair readout at a canvas CSS pixel. Maps the pixel back through the
   * camera inverse to (col_seq, row), reads the EXACT summed size from the CPU
   * {@link ColumnCache} (never GPU/mip texels), and the price from the epoch's
   * row→price affine. Returns null before the first column. Grouped rows are
   * summed to match a tick-grouped / zoomed-out view (block = 4^level).
   */
  probeAt(cssX: number, cssY: number): CrosshairReadout | null {
    const overview = this.gpu.activeOverview();
    const ring = overview?.ring ?? this.gpu.ring;
    if (ring === null) return null;

    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const displayScale = this.axis.overlayPriceMap()?.scale ?? null;
    const { colf, rowf: displayRow } = screenToGrid(this.frameState.view, cssX, cssY, cssW, cssH, displayScale);
    const colSeq = Math.floor(colf);
    const sampleCol = overview ? Math.floor(colf / overview.stride) : colSeq;
    const cache = overview?.cache ?? this.columnCache;
    const rows = ring.rows;

    // Epoch geometry for row→price (single-epoch sim; per-column epoch when known).
    const st = this.store.getState();
    const epoch = cache.epochAt(sampleCol) ?? st.gridEpoch ?? 0;
    const params = st.epochs.get(epoch);
    const pmap = cache.priceAt(sampleCol) ?? (params ? this.axis.priceMapFor(params) : null);
    const scale = pmap ? mapScale(pmap) : null;
    // CPU columns retain their native epoch geometry. Interpret the cursor's
    // physical price in that geometry rather than reusing today's row number.
    // Linear cells/events retain their legacy half-row display convention.
    // Physical GPU projection uses that same screen origin before selecting
    // the nearest centered bin in each column's own geometry.
    const cursorPrice = displayScale ? scaleRowToPrice(displayScale,
      displayRow - (displayScale.kind === 'linear' ? .5 : 0)) : null;
    const rowf = scale && cursorPrice !== null ? scalePriceToRow(scale, cursorPrice) : displayRow;
    const centered = displayScale !== null && scale !== null;
    const row = Math.floor(rowf + (centered ? 0.5 : 0));
    const onGrid = Number.isFinite(row) && row >= 0 && row < rows;
    const range = ring.residentRange();
    const inRange = range !== null && sampleCol >= range.oldest && sampleCol <= range.newest && cache.arrays(sampleCol) !== null && onGrid;
    const price = scale && onGrid ? scaleRowToPrice(scale,
      displayScale?.kind === 'hybrid' || scale.kind === 'hybrid' ? rowf : row) : null;
    // Native quote precision is independent of the storage bucket width.
    // Quarter-unit ticks and sub-nanounit prices must remain distinguishable.
    const priceDecimals = quoteDecimals(pmap?.tick ?? pmap?.step ?? Number.NaN);

    // Hybrid pixels choose a LOCAL row footprint, independently of time LOD.
    // Mirror projectedSample, including its neighboring row taps.
    let blk = 4 ** this.shading.currentLevel();
    let taps = 1;
    if (centered && scale && displayScale && cursorPrice !== null) {
      const low = scaleRowToPrice(displayScale, this.frameState.view.rowOffset);
      const high = scaleRowToPrice(displayScale, this.frameState.view.rowOffset + this.frameState.view.rowScale);
      const width = scaleStepAtRow(scale, rowf);
      const footprint = (high - low) / cssH / Math.max(width, 1e-30);
      const maxLevel = this.gpu.mips?.usable ? this.gpu.mips.maxLevel : 0;
      const level = Math.min(maxLevel, Math.max(this.shading.tickGroupingLevel(), footprint >= 16 ? 2 : footprint >= 4 ? 1 : 0));
      blk = 4 ** level;
      taps = Math.max(1, Math.min(4, Math.ceil(footprint / blk)));
    }
    const group = taps * blk;
    const rowStart = (Math.floor((rowf + (centered ? 0.5 : 0)) / blk) - Math.floor((taps - 1) / 2)) * blk;
    const firstRow = Math.max(0, rowStart), lastRow = Math.min(rows, rowStart + group);
    const size = onGrid ? cache.sizeAt(sampleCol, firstRow, lastRow - firstRow) : null;
    // The group's true price EXTENT. A grouped cell spans `blk` ROWS, and on a
    // non-uniform grid that is emphatically not `blk * step` of price — so the
    // readout reports the real [lo, hi) rather than implying a uniform width.
    const priceLo = scale && onGrid ? scaleRowToPrice(scale, rowStart - (centered ? 0.5 : 0)) : null;
    const priceHi = scale && onGrid ? scaleRowToPrice(scale, rowStart + group - (centered ? 0.5 : 0)) : null;

    return {
      colSeq,
      row,
      group,
      price,
      priceLo,
      priceHi,
      priceDecimals,
      bid: size ? size.bid : null,
      ask: size ? size.ask : null,
      timeNs: cache.timeAt(sampleCol),
      averageMs: overview ? overview.stride * this.axis.currentDtNs() / 1e6 : undefined,
      inRange,
      sessionClock: isSessionClockMarket(st.subscription?.market ?? ''),
    };
  }

  /** Forward map a grid cell CENTER to canvas CSS pixels (e2e crosshair hover). */
  cellToCanvasCss(colSeq: number, row: number): { x: number; y: number } {
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const uvX = (colSeq + 0.5 - this.frameState.view.colOffset) / this.frameState.view.colScale;
    const uvY = rowFraction(this.frameState.view, this.axis.overlayPriceMap()?.scale ?? null, row + 0.5);
    return { x: uvX * cssW, y: (1 - uvY) * cssH };
  }

  /** Continuous projection for drawings/indicators, without snapping a price
   *  to an entire coarse storage cell. */
  canvasCssToGrid(x: number, y: number): { col: number; row: number } | null {
    if (this.axis.overlayPriceMap() === null) return null;
    const point = screenToGrid(this.frameState.view, x, y, Math.max(1, this.lastResizeCssW), Math.max(1, this.lastResizeCssH), this.axis.overlayPriceMap()?.scale ?? null);
    return { col: point.colf, row: point.rowf - (this.axis.overlayPriceMap()?.scale?.kind === 'hybrid' ? 0 : 0.5) };
  }

  gridToCanvasCss(col: number, row: number): { x: number; y: number } {
    const scale = this.axis.overlayPriceMap()?.scale ?? null;
    return {
      x: (col - this.frameState.view.colOffset) / this.frameState.view.colScale * Math.max(1, this.lastResizeCssW),
      y: (1 - rowFraction(this.frameState.view, scale, row + (scale?.kind === 'hybrid' ? 0 : 0.5))) * Math.max(1, this.lastResizeCssH),
    };
  }
}
