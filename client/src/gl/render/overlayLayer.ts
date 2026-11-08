/**
 * Overlay layer of the live renderer: the overlay manager wiring, the reused
 * overlay draw context, the overlay setters and probes, the CVD readout, the
 * per-window prune and the 2D ink teardown. Renderer keeps one-line delegates with the same names.
 */
import { OverlayManager, type OverlayDrawContext } from '../overlays/manager';
import type { TimeAxisClock } from '../overlays/axes';
import type { OverlayVisibility } from '../overlays/frame';
import { mapScale, slotTsToCol, type PriceMap, type TimeMap } from '../overlays/coords';
import { priceToPlotRow } from '../priceScale';
import { rowFraction } from '../priceProjection';
import { exchangeZoneFor, getTimeZonePref, type TimeZonePref } from '../../i18n/format';
import { marketGroup } from '../../ui/symbols';
import { attachAxisGestures, type CameraController } from '../../input/gestures';
import type { EpochParams, GexLevelUpdate } from '../../proto/types';
import type { ColumnCache } from '../columnCache';
import type { ViewportNormalizer } from '../normalize';
import type { TileRing } from '../tileRing';
import type { OverviewSurface } from '../overviewSurface';
import type { AxisMap } from './axisMap';
import type { FrameState, StateSource } from './frameState';

/**
 * Slack (in columns) around the resident window for the per-window overlay
 * prune. Re-pruning is a no-op until an edge has moved by more
 * than this, so a live append burst costs ONE map scan per ~64 columns instead
 * of one per column; the maps may hold up to this many extra columns between
 * sweeps, which is exactly the pad the prune keeps anyway.
 */
const OVERLAY_PRUNE_PAD = 64;

/** What the overlay layer reads from the renderer. The getters keep live values current. */
export interface OverlayLayerHost {
  readonly canvas: HTMLCanvasElement;
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly axis: AxisMap;
  columnCache(): ColumnCache;
  normalizer(): ViewportNormalizer;
  gl(): WebGL2RenderingContext;
  ring(): TileRing | null;
  activeOverview(): OverviewSurface | null;
  controller(): CameraController;
  dpr(): number;
  cssWidth(): number;
  cssHeight(): number;
  glLost(): boolean;
}

export class OverlayLayer {
  /** Overlays: trades/BBO/VWAP/profile/markers + axes + text layer. */
  readonly overlays: OverlayManager;
  /**
   * Reused overlay-draw context (micro GC): every field is reassigned per dirty
   * frame, nothing allocated. `columnArrays` reads the (pooled) column cache.
   */
  private readonly overlayCtx: OverlayDrawContext;
  private readonly overlayResident = { oldest: 0, newest: 0 };
  /** Last (oldest,newest) the overlay maps were pruned to; -1 = never. */
  private lastPruneOldest = -1;
  private lastPruneNewest = -1;
  /** Reused time-axis clock, mutated per frame rather than reallocated. */
  private readonly axisClock: { pref: TimeZonePref; exchangeZone: string } = { pref: 'local', exchangeZone: 'UTC' };
  /** Price-gutter gesture disposer; null until the gutter canvas is attached. */
  private axisGesturesDispose: (() => void) | null = null;
  private readonly host: OverlayLayerHost;
  private readonly canvas: HTMLCanvasElement;
  private readonly store: StateSource;
  private readonly frameState: FrameState;
  private readonly axis: AxisMap;

  constructor(host: OverlayLayerHost) {
    this.host = host;
    this.canvas = host.canvas;
    this.store = host.store;
    this.frameState = host.frameState;
    this.axis = host.axis;
    this.overlays = new OverlayManager(host.gl(), host.canvas);
    this.overlayCtx = {
      view: { colOffset: 0, colScale: 0, rowOffset: 0, rowScale: 0 },
      dims: { drawW: 0, drawH: 0, cssW: 0, cssH: 0 },
      dpr: 1,
      resident: null,
      capability: null,
      time: null,
      price: null,
      columnArrays: this.axis.rawColumnArrays,
      changed: () => { this.frameState.dirty = true; },
      newestArrays: null,
      mipLevel: 0,
    };
  }

  private get ring(): TileRing | null { return this.host.ring(); }
  private get gl(): WebGL2RenderingContext { return this.host.gl(); }
  private get columnCache(): ColumnCache { return this.host.columnCache(); }
  private get normalizer(): ViewportNormalizer { return this.host.normalizer(); }
  private get controller(): CameraController { return this.host.controller(); }
  private get dpr(): number { return this.host.dpr(); }
  private get lastResizeCssW(): number { return this.host.cssWidth(); }
  private get lastResizeCssH(): number { return this.host.cssHeight(); }
  private get rawColumnArrays() { return this.axis.rawColumnArrays; }
  private get rawColumnScale() { return this.axis.rawColumnScale; }

  private glLost(): boolean { return this.host.glLost(); }
  private activeOverview(): OverviewSurface | null { return this.host.activeOverview(); }
  private currentDtNs(): number { return this.axis.currentDtNs(); }
  private overlayPriceMap(): PriceMap | null { return this.axis.overlayPriceMap(); }
  private overlayTimeMap(): TimeMap | null { return this.axis.overlayTimeMap(); }
  private priceMapFor(ep: EpochParams): PriceMap { return this.axis.priceMapFor(ep); }

  /** Detach the price-gutter gestures (Renderer.dispose). */
  disposeAxisGestures(): void {
    this.axisGesturesDispose?.();
  }

  /** Session reset: forget the last pruned window so the next write re-bounds the maps. */
  forgetPrune(): void {
    this.lastPruneOldest = -1;
    this.lastPruneNewest = -1;
  }

  /**
   * The time-axis clock for this frame. A sim feed keeps the
   * session-relative T+ axis, because its timestamps are not wall time. A live
   * feed reads wall time in the Settings → Time zone choice, using the
   * instrument's exchange zone for the `exchange` option.
   */
  timeAxisClockFor(): TimeAxisClock | null {
    const market = this.store.getState().subscription?.market ?? '';
    if (isSessionClockMarket(market)) return null;
    this.axisClock.pref = getTimeZonePref();
    this.axisClock.exchangeZone = exchangeZoneFor(marketGroup(market));
    return this.axisClock;
  }

  /** Attach the App-owned price/time gutter canvases for axis drawing. */
  attachOverlaySurfaces(
    priceAxisCanvas: HTMLCanvasElement | null,
    timeAxisCanvas: HTMLCanvasElement | null,
  ): void {
    this.overlays.attachAxes(priceAxisCanvas, timeAxisCanvas);
    // The price gutter is a CONTROL surface: wheel = price zoom, vertical
    // drag = price scale, double-click = auto-fit. Listeners live on the canvas
    // so the AUTO chip can be an absolutely-positioned sibling whose clicks
    // never reach it. Re-attachable — the old disposer runs first.
    this.axisGesturesDispose?.();
    this.axisGesturesDispose = priceAxisCanvas
      ? attachAxisGestures(priceAxisCanvas, this.controller)
      : null;
    this.frameState.dirty = true;
  }

  /** Toggle which overlays render (App visibility state). */
  setOverlayVisibility(v: Partial<OverlayVisibility>): void {
    this.overlays.setVisibility(v);
    this.frameState.dirty = true;
  }

  /** Which overlays are currently on (App reads this to seed its toggles). */
  overlayVisibility(): OverlayVisibility {
    return this.overlays.getVisibility();
  }

  /** Bubble draw threshold (min trade size), settings. */
  setBubbleMinSize(minSize: number): void {
    this.overlays.setBubbleMinSize(minSize);
    this.frameState.dirty = true;
  }

  setGex(gex: GexLevelUpdate | null): void {
    this.overlays.setGex(gex);
    this.frameState.dirty = true;
  }

  getGex(): GexLevelUpdate | null {
    return this.overlays.getGex();
  }

  /**
   * The CVD (cumulative volume delta) points inside the given absolute-column
   * span, in ascending column order — for the lower CVD pane, which maps them
   * through the SAME `timeline()` transform as the heatmap so it stays locked
   * horizontally under pan/zoom/scroll-back. Empty before any bar arrives.
   */
  cvdSeries(loCol: number, hiCol: number): Array<{ col: number; cvd: number }> {
    const overview = this.activeOverview();
    if (overview) return overview.bars.cvd.series(loCol / overview.stride, hiCol / overview.stride).map(p => ({ ...p, col: (p.col + 0.5) * overview.stride - 0.5 }));
    return this.overlays.cvdSeries(loCol, hiCol);
  }

  /** Cumulative CVD at one column (O(1)) — the CVD pane folds the newest column's
   *  value into its repaint signature so the live tip tracks a forming bar. */
  cvdValueAt(colSeq: number): number {
    const overview = this.activeOverview();
    if (overview) return overview.bars.cvd.valueAt(Math.floor(colSeq / overview.stride));
    return this.overlays.cvdValueAt(colSeq);
  }

  /** Includes historical corrections, which can leave the live tip unchanged. */
  get cvdRevision(): number {
    return this.activeOverview()?.bars.cvd.dataRevision ?? this.overlays.cvdRevision;
  }

  /**
   * the synchronous 2D ink teardown (text layer + both gutter canvases,
   * no GL) owned by the overlay manager. Called on session resets and before
   * the `drawOverlays` early returns so a frame/session that paints nothing
   * cannot leave the previous frame's ink floating over the chart.
   */
  clearOverlayInk(): void {
    this.overlays.clearInk();
  }

  /**
   * Bound the per-window overlay maps (VWAP / price line / CVD) to the resident
   * range — but only when an edge actually moved beyond the prune's slack. This
   * runs from `writeColumn`, i.e. for every appended column (4–20/s live, whole
   * 256-column pages during scroll-back splices), and each call would otherwise
   * be an O(resident) scan of three Maps. The resident window is contiguous, so
   * a one-column slide cannot put any key more than one column outside the
   * previously pruned window: re-pruning is a no-op until an edge has moved by
   * more than the pad, at which point ONE scan re-bounds everything. The maps
   * hold at most `pad` extra columns between sweeps — exactly the slack prune
   * keeps anyway — so this trades a bounded amount of memory for turning
   * O(columns × resident) work into O(resident × columns / pad).
   */
  pruneOverlayWindows(oldest: number, newest: number): void {
    if (
      this.lastPruneOldest >= 0 &&
      Math.abs(oldest - this.lastPruneOldest) <= OVERLAY_PRUNE_PAD &&
      Math.abs(newest - this.lastPruneNewest) <= OVERLAY_PRUNE_PAD
    ) {
      return;
    }
    this.lastPruneOldest = oldest;
    this.lastPruneNewest = newest;
    this.overlays.prune(oldest, newest, OVERLAY_PRUNE_PAD);
  }

  /**
   * Draw the overlays over the heatmap for the current view. All O(visible): each
   * overlay emits geometry only for the columns/rows in the viewport. Returns
   * early (no cost) when nothing can be placed — no epoch geometry yet, or every
   * overlay is toggled off. The context object + dims are reused scratch (micro
   * GC: nothing here may allocate per frame).
   */
  drawOverlays(): void {
    if (this.glLost()) {
      // A lost context must not leave 2D ink floating over a dead frame.
      this.clearOverlayInk();
      return;
    }
    const overlays = this.overlays;
    // The 2D ink (price line / dashed level / axis labels / pill) is NOT
    // GL — the manager's own clear only runs when it draws. On the early-exit
    // paths below the previous frame's ink would stay floating over the live
    // heatmap (toggling every overlay off could never clear it),
    // so clear the ink BEFORE returning.
    if (!overlays.anyVisible) {
      this.clearOverlayInk();
      return;
    }
    const price = this.overlayPriceMap();
    const overview = this.activeOverview();
    const time = overview ? overview.timeMap(this.currentDtNs()) : this.overlayTimeMap();
    // Need at least a price affine (axes/BBO/profile) or a time affine (events);
    // with neither there is nothing to map onto the camera.
    if (price === null && time === null) {
      this.clearOverlayInk();
      return;
    }

    const gl = this.gl;
    const range = overview?.ring.residentRange() ?? this.ring?.residentRange() ?? null;
    const ctx = this.overlayCtx;
    ctx.view = overview ? overview.view(this.frameState.view) : this.frameState.view;
    ctx.overviewBars = overview?.bars ?? null;
    ctx.columnArrays = overview?.columnArrays ?? this.rawColumnArrays;
    ctx.columnScale = overview ? col => overview.priceScaleAt(col) : this.rawColumnScale;
    ctx.dataVersion = (overview?.normalizer ?? this.normalizer).tilesVersion;
    ctx.dims.drawW = gl.drawingBufferWidth;
    ctx.dims.drawH = gl.drawingBufferHeight;
    ctx.dims.cssW = Math.max(1, this.lastResizeCssW);
    ctx.dims.cssH = Math.max(1, this.lastResizeCssH);
    ctx.dpr = this.dpr;
    if (range !== null) {
      this.overlayResident.oldest = range.oldest;
      this.overlayResident.newest = range.newest;
      ctx.resident = this.overlayResident;
    } else {
      ctx.resident = null;
    }
    ctx.capability = this.store.getState().capability;
    ctx.timeAxisClock = this.timeAxisClockFor();
    ctx.time = time;
    ctx.price = price;
    ctx.newestArrays = this.frameState.newestSeq >= 0 ? this.columnCache.arrays(this.frameState.newestSeq) : null;
    const newestEpoch = this.columnCache.epochAt(this.frameState.newestSeq);
    const newestParams = newestEpoch === null ? undefined : this.store.getState().epochs.get(newestEpoch);
    ctx.newestPrice = this.columnCache.priceAt(this.frameState.newestSeq) ?? (newestParams ? this.priceMapFor(newestParams) : null);
    // Profile accumulation is independent of local heatmap sampling footprints.
    ctx.mipLevel = 0; // The profile sums native price intervals, independently of heatmap LOD.
    overlays.draw(ctx);
  }

  /**
   * Forward-map an overlay event `(ts_ns, price)` to canvas CSS px through the
   * SAME transform the overlays use (bubble/marker center), so the spec can
   * pixel-sample where a glyph must land. Null before any epoch/column.
   */
  overlayPointCss(tsNs: bigint, price: number): { x: number; y: number } | null {
    const priceMap = this.overlayPriceMap();
    const time = this.overlayTimeMap();
    if (priceMap === null || time === null) return null;
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    // Same ts→col transform the overlay glyphs use (coords.ts GridMap.tsToCol):
    // piecewise through the slot table when it covers the ts, affine otherwise.
    const piecewise = time.slots !== undefined ? slotTsToCol(time.slots, tsNs) : null;
    const colOf = piecewise ?? time.anchorSeq + Number(tsNs - time.anchorT0Ns) / time.dtNs;
    const colf = colOf + 0.5;
    // The row must come from the AUTHORITATIVE scale (hybrid-aware), not
    // the core affine — on a wide-band epoch the two disagree away from the core.
    const rowf = priceToPlotRow(mapScale(priceMap), price);
    const uvX = (colf - this.frameState.view.colOffset) / this.frameState.view.colScale;
    const uvY = rowFraction(this.frameState.view, this.overlayPriceMap()?.scale ?? null, rowf);
    return { x: uvX * cssW, y: (1 - uvY) * cssH };
  }

  /** Overlay data counts + last profile result. e2e diagnostics. */
  overlayDebugForTest(): ReturnType<OverlayManager['debug']> {
    return this.overlays.debug();
  }

  /**
   * The BBO the overlay would draw for the CURRENT session (capability + newest
   * book), or null when it honestly draws nothing. e2e: a SYNTH_PROFILE keyless
   * equity session MUST return null — no fabricated bid/ask quote.
   */
  overlayEffectiveBboForTest(): ReturnType<OverlayManager['effectiveBboForTest']> {
    const newest = this.frameState.newestSeq >= 0 ? this.columnCache.arrays(this.frameState.newestSeq) : null;
    const epoch = this.columnCache.epochAt(this.frameState.newestSeq);
    const params = epoch === null ? undefined : this.store.getState().epochs.get(epoch);
    return this.overlays.effectiveBboForTest(
      this.store.getState().capability,
      this.overlayPriceMap(),
      newest,
      this.columnCache.priceAt(this.frameState.newestSeq) ?? (params ? this.priceMapFor(params) : null),
    );
  }

  /** Canvas CSS px y of a price row edge (for BBO / axis line sampling). e2e. */
  overlayRowCss(rowf: number): number {
    const cssH = Math.max(1, this.canvas.clientHeight);
    const uvY = rowFraction(this.frameState.view, this.overlayPriceMap()?.scale ?? null, rowf);
    return (1 - uvY) * cssH;
  }
}

/**
 * True when a market's timestamps are session-relative rather than wall time (a
 * sim feed). The time axis and the crosshair readout both key on this predicate.
 */
export function isSessionClockMarket(market: string): boolean {
  return marketGroup(market) === 'sim';
}
