/**
 * GL object lifecycle of the live renderer: the WebGL context and the LUT
 * texture, the ring / heatmap / SUM-mip objects and their teardown, the ring's
 * per-slot extent companion, the scroll-back loader factory, the coarse overview
 * layer, context loss and restore, the background clear and the resident-range
 * diagnostics. The Renderer keeps
 * one-line delegates for every name a test or a sibling module reaches.
 */

import { COLS_PER_TILE, TileRing, type ResidentRange } from '../tileRing';
import { Heatmap } from '../heatmap';
import { MipChain } from '../mips';
import { initGL, type GLContext } from '../context';
import { clearColorForRamp, createLUTTexture } from '../lut';
import { releaseHeatmapProgram } from '../heatmapProgram';
import { limitsFor, type Camera } from '../camera';
import { clamp } from '../numeric';
import { SpliceMipBatch } from '../spliceMips';
import { OverviewSurface } from '../overviewSurface';
import { displayHistoryGap } from '../historyGap';
import { OverviewHistory } from '../../net/overviewHistory';
import {
  HistoryLoader,
  pageColsForRows,
  HISTORY_DEV_FRAME_BUDGET_BYTES,
  HISTORY_FRAME_BUDGET_BYTES,
} from '../../net/history';
import { serverOrigin } from '../../net/serverBase';
import type { DepthColumn } from '../../proto/types';
import type { ColumnCache } from '../columnCache';
import type { ViewportNormalizer } from '../normalize';
import type { OverlayManager } from '../overlays/manager';
import type { AxisMap } from './axisMap';
import type { FollowPolicy } from './followPolicy';
import type { FrameState, StateSource } from './frameState';

/** Failure text while the GL context is lost; the restore event clears it. */
export const CONTEXT_LOST_MESSAGE = 'WebGL context lost';

/**
 * Tile layers the ring gets for a column target — the exact allocation
 * arithmetic used at ring creation AND for the CPU column-cache sizing, so the
 * cache always covers the ring it mirrors. The device's layer limit is a
 * parameter so the Renderer can size those caches before the GL module exists.
 */
export function ringLayersFor(target: number, maxLayers: number): number {
  return clamp(Math.ceil(target / COLS_PER_TILE), 2, maxLayers);
}

/**
 * Per-slot non-zero row extent (lo/hi), -1 = empty, plus the absolute col_seq
 * each slot was written for. Sized to ring capacity; null until allocated.
 *
 * The col_seq stamp is REQUIRED, not belt-and-braces: `Residency.note()`
 * (gl/tileRing.ts) is a pure interval, so ONE backfilled column instantly makes
 * `residentRange()` claim a whole capacity-wide window whose slots still hold
 * the PREVIOUS live columns' extents. The price auto-fit scans that window, so
 * without this stamp it would fit to a foreign price band mid-backfill.
 */
export class RingExtents {
  private loArr: Int32Array | null = null;
  private hiArr: Int32Array | null = null;
  private seqArr: Int32Array | null = null;

  get lo(): Int32Array | null {
    return this.loArr;
  }

  get hi(): Int32Array | null {
    return this.hiArr;
  }

  get seq(): Int32Array | null {
    return this.seqArr;
  }

  /** Allocate the three arrays for a ring of `cap` slots. */
  allocate(cap: number): void {
    this.loArr = new Int32Array(cap).fill(-1);
    this.hiArr = new Int32Array(cap).fill(-1);
    this.seqArr = new Int32Array(cap).fill(-1);
  }

  /** Drop the arrays with their ring. */
  clear(): void {
    this.loArr = null;
    this.hiArr = null;
    this.seqArr = null;
  }

  /** Record a written slot's extent and the col_seq it now holds. */
  write(slot: number, lo: number, hi: number, seq: number): void {
    this.loArr![slot] = lo;
    this.hiArr![slot] = hi;
    this.seqArr![slot] = seq;
  }
}

/**
 * What the GL lifecycle needs from its owner. Getters are read at use time, so
 * the owner's later reassignments are seen.
 */
export interface GpuHost {
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly camera: Camera;
  readonly axis: AxisMap;
  columnCache(): ColumnCache;
  normalizer(): ViewportNormalizer;
  overlays(): OverlayManager;
  follow(): FollowPolicy;
  /**
   * Applies the Renderer's knobs (normalizer, contrast, black point, tick
   * grouping, chart style, dpr) and the active ramp to a freshly built heatmap.
   */
  configureHeatmap(heatmap: Heatmap): void;
  /** The active colormap row, which the background clear colour follows. */
  activeRamp(): number;
  /** The per-session gate is closed (the new session has not identified itself). */
  awaitingSession(): boolean;
  /** A scripted perf run owns the frame. */
  perfRunning(): boolean;
  countUpload(): void;
  notifyViewChanged(): void;
  resize(): void;
  /** Rebuilds through the Renderer, so a spy on its recreateGL sees a restore. */
  rebuildGL(): void;
  /** The Renderer's history splice sink. */
  spliceColumn(col: DepthColumn): void;
  /** The frame loop forgets the presented session and any scripted run. */
  onFrameLost(): void;
  /** The frame loop re-arms its program-readiness retry. */
  onFrameRestored(): void;
  setRenderFailure(message: string | null): void;
}

export class GpuLifecycle {
  /** The live GL context. Rebuilt on restore, so the Renderer reads it through a getter. */
  ctx: GLContext;
  /** The LUT atlas texture. Theme changes re-specify it in place. */
  lut: WebGLTexture;
  /** Created lazily on the first column, once the row count is known. */
  ring: TileRing | null = null;
  heatmap: Heatmap | null = null;
  /** SUM-mip chain for correct zoom-out. null when float FBOs are absent. */
  mips: MipChain | null = null;
  readonly extents = new RingExtents();
  /**
   * Deferred SUM-mip regeneration range for history-page splices: the loader's
   * per-column sink extends this instead of firing an FBO pass per appended
   * column, and the page end flushes ONE range pass per level per tile layer
   * (a 256-column page would otherwise fire 80 tiny 1-px viewports).
   */
  readonly spliceMips = new SpliceMipBatch();
  /** Deep scroll-back backfill. Created with the ring. */
  history: HistoryLoader | null = null;

  /** Ring geometry, remembered so context-restore can rebuild identically. */
  private ringRows = 0;
  private ringLayers = 0;

  private overviewHistory: OverviewHistory | null = null;
  private overview: OverviewSurface | null = null;
  private overviewEpoch: number | null = null;

  // Context-loss lifecycle: recreate GL + re-fetch on restore.
  private contextLost = false;
  private contextLostCountN = 0;
  private contextRestoredCountN = 0;
  /** WEBGL_lose_context handle kept from the pre-loss ctx (e2e-driven loss). */
  private lostCtxExt: { loseContext(): void; restoreContext(): void } | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly requireColorBufferFloat: boolean;
  private readonly capacityColsTarget: number;
  private readonly host: GpuHost;
  private readonly store: StateSource;
  private readonly frameState: FrameState;
  private readonly camera: Camera;
  private readonly axis: AxisMap;

  constructor(
    canvas: HTMLCanvasElement,
    opts: { requireColorBufferFloat: boolean; capacityColsTarget: number },
    host: GpuHost,
  ) {
    this.canvas = canvas;
    this.requireColorBufferFloat = opts.requireColorBufferFloat;
    this.capacityColsTarget = opts.capacityColsTarget;
    this.host = host;
    this.store = host.store;
    this.frameState = host.frameState;
    this.camera = host.camera;
    this.axis = host.axis;

    this.ctx = initGL(canvas, {
      requireColorBufferFloat: this.requireColorBufferFloat,
      // Dirty-only render loop: keep the last frame between draws (see renderer.ts).
      preserveDrawingBuffer: true,
    });
    this.lut = createLUTTexture(this.ctx.gl);

    // Context-loss recovery: preventDefault on lost so the browser will
    // fire `restored`, where we rebuild every GL object + re-fetch the view.
    canvas.addEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored as EventListener, false);
  }

  /** Remove the context listeners and free the GL objects this lifecycle owns. */
  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost as EventListener);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored as EventListener,
    );
    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.ctx.gl.deleteTexture(this.lut);
    releaseHeatmapProgram(this.ctx.gl);
  }

  // --- residency and context diagnostics ------------------------------------

  /** Resident absolute col_seq range (or null before any column). Diagnostics. */
  residentRange(): ReturnType<TileRing['residentRange']> {
    return this.ring ? this.ring.residentRange() : null;
  }

  /**
   * First resident col_seq whose ring slot provably holds THAT column (-1
   * before any append). Diagnostics / e2e (the vanish probe's ground truth).
   */
  validFromSeq(): number {
    return this.ring?.validFromSeq() ?? -1;
  }

  /** Full-res residency budget in columns (ring capacity). Diagnostics / e2e. */
  residentBudgetCols(): number {
    return this.ring?.budgetCols ?? 0;
  }

  /** Whether an absolute col_seq is resident full-res. Diagnostics / e2e. */
  isResidentFullRes(colSeq: number): boolean {
    return this.ring?.isResidentFullRes(colSeq) ?? false;
  }

  /** Scroll-back backfill counters (or null before the ring exists). e2e hook. */
  historyStats(): {
    requestCount: number;
    inFlight: boolean;
    startOfHistory: boolean;
    error: string | null;
  } | null {
    if (!this.history) return null;
    return {
      requestCount: this.history.requestCount,
      inFlight: this.history.inFlight,
      startOfHistory: this.history.startOfHistory,
      error: this.history.error,
    };
  }

  /** Context-loss counter. e2e recovery hook. */
  get contextLostCount(): number {
    return this.contextLostCountN;
  }

  /** Context-restore counter. e2e recovery hook. */
  get contextRestoredCount(): number {
    return this.contextRestoredCountN;
  }

  /**
   * The loss flag set by the `webglcontextlost` event. Unlike {@link glLost},
   * it does not consult the live context, so it reads false during a restore.
   */
  get contextLostFlag(): boolean {
    return this.contextLost;
  }

  /** Force a WebGL context loss via WEBGL_lose_context (e2e only). */
  loseContextForTest(): boolean {
    const ext = this.ctx.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    this.lostCtxExt = ext;
    ext.loseContext();
    return true;
  }

  /** Restore a context lost via {@link loseContextForTest} (e2e only). */
  restoreContextForTest(): void {
    this.restoreLostContext();
  }

  /** Ask the browser to restore a lost context, when a loss handle is held. */
  restoreLostContext(): void {
    this.lostCtxExt?.restoreContext();
  }

  /** True while the GL context is lost — including the window between the
   *  WEBGL_lose_context call and the `webglcontextlost` event firing. */
  glLost(): boolean {
    return this.contextLost || this.ctx.gl.isContextLost();
  }

  // --- ring construction and teardown ---------------------------------------

  /** Build the ring, heatmap, mips and loader at a row count (first column of a session). */
  createRing(rows: number): void {
    if (rows > this.ctx.caps.maxTextureSize) {
      throw new Error(
        `flowmap/renderer: rows ${rows} exceed MAX_TEXTURE_SIZE ${this.ctx.caps.maxTextureSize}`,
      );
    }
    const layers = ringLayersFor(this.capacityColsTarget, this.ctx.caps.maxArrayTextureLayers);

    this.ringRows = rows;
    this.ringLayers = layers;
    const ring = this.installRing(rows, layers);

    // Real geometry known: update the camera's clamps and (re)frame live.
    this.camera.setLimits(limitsFor(rows, ring.capacityCols));
    this.camera.reset(ring.residentRange(), rows);
    this.host.follow().applyWantedFollow();
  }

  /**
   * The core shared by every ring build: the ring, its heatmap (configured by the
   * Renderer), the mip chain, the extent arrays, the piecewise slot table and the
   * scroll-back loader. Returns the new ring.
   */
  private installRing(rows: number, layers: number): TileRing {
    const ring = new TileRing(this.ctx.gl, rows, layers);
    this.ring = ring;
    const heatmap = new Heatmap(this.ctx, ring, this.lut);
    this.heatmap = heatmap;
    this.host.configureHeatmap(heatmap);
    this.mips?.dispose();
    this.mips = this.createMips(rows, layers);
    heatmap.mips = this.mips;
    const cap = ring.capacityCols;
    this.extents.allocate(cap);
    this.axis.slots.allocate(cap);

    this.history = this.createHistoryLoader();
    return ring;
  }

  /**
   * Rebuild the ring at a DIFFERENT row count — a grid-geometry change (crypto's
   * 2048-row grid → equity's 4096, or the `deep` band's 4096 on the same symbol).
   *
   * This exists because the alternative is worse than losing the resident
   * columns: the previous code warned and skipped every mismatched column, and
   * since nothing else ever recreates the ring, the heatmap stayed blank for the
   * rest of the session. Row INDICES are meaningless across the change too, so
   * the row-addressed CPU caches and the price-follow cursors go with the ring;
   * everything here is re-derived from the next few columns.
   *
   * Narrower than the session reset: overlays, the col_seq cursors and the
   * user's follow/zoom intent are untouched, because this may be a mid-session
   * epoch change rather than a new instrument.
   */
  recreateRingForRows(rows: number): void {
    this.resetOverview();
    this.teardownRing();

    // Row-addressed CPU state from the old geometry cannot be reinterpreted.
    this.host.normalizer().reset();
    this.host.columnCache().reset();
    const follow = this.host.follow();
    follow.trackedRowN = null;
    follow.trackedEpoch = null;
    follow.priceEpoch = null;
    follow.priceTarget = null;
    follow.priceFitMemo = null;

    this.createRing(rows);
    // preserveDrawingBuffer keeps the OLD heatmap image on screen until
    // the next column draws — and with a re-framed camera that reads as a band
    // mismatch. Wipe it explicitly after the rebuild.
    this.clearBackground();
  }

  /**
   * Drop the ring objects: cancel the splice batch, dispose the GL objects and
   * null their handles. The preloads and both teardown paths share this core.
   */
  releaseRingObjects(): void {
    this.spliceMips.cancel();
    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.mips = null;
    this.heatmap = null;
    this.ring = null;
    this.history = null;
  }

  /** Tear the ring down completely, including its extent and slot companions. */
  teardownRing(): void {
    this.releaseRingObjects();
    this.extents.clear();
    this.axis.slots.clear();
    this.ringRows = 0;
    this.ringLayers = 0;
  }

  /**
   * Build the SUM-mip chain when float FBOs are available and the row count
   * supports a 4× downsample. Returns null (single-level, level-0 draw path)
   * otherwise — the heatmap then renders from the level-0 draw path alone.
   */
  createMips(rows: number, layers: number): MipChain | null {
    if (!this.ctx.caps.colorBufferFloat || rows % 4 !== 0) return null;
    return new MipChain(this.ctx, COLS_PER_TILE, rows, layers);
  }

  /** Wire a {@link HistoryLoader} to the store transport + this ring/mips. */
  private createHistoryLoader(): HistoryLoader {
    const ring = this.ring;
    return new HistoryLoader({
      isActive: () => this.ring === ring && !this.contextLost && !this.host.awaitingSession(),
      yieldToFrame: () => new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      }),
      requestHistory: (before_t, n) => this.store.getState().requestHistory(before_t, n),
      requestSequence: (start, end, n) => this.store.getState().requestHistory(0x7fff_ffff_ffff_ffffn, n, { start_col: start, end_col: end, stride: 1 }),
      spliceColumn: col => this.host.spliceColumn(col),
      residentRange: () => this.ring?.residentRange() ?? null,
      validFromSeq: () => this.ring?.validFromSeq() ?? -1,
      latestColumn: () => this.frameState.newestSeq < 0 ? null : { colSeq: this.frameState.newestSeq, t0Ns: this.frameState.newestT0Ns },
      budgetCols: () => this.ring?.budgetCols ?? 0,
      dtNs: () => this.axis.currentDtNs(),
      // Page size rides the grid height AND the transport: one HistoryResponse
      // frame is n_cols × rows × 8 bytes, and the vite dev ws proxy silently
      // drops multi-MB messages under live traffic — see net/history
      // pageColsForRows. Direct transports (injected Tauri origin) keep the
      // full wire page; same-origin dev rides small, latency-bound pages.
      rows: () => this.ring?.rows ?? 0,
      maxPageCols: () =>
      // DIRECT transport (injected origin: Tauri, and dev since the vite
      // config injects it): the pipe verified clean at multi-MB frames, so
      // ride the full 2 MB budget — 64-column pages at 4096 rows fill a
      // scrolled-back window in a few sweeps instead of window-shaped chunks.
      // Same-origin fallback (no injection) keeps the small-page ceiling.
        serverOrigin() !== null
          ? pageColsForRows(this.ring?.rows ?? 0, HISTORY_FRAME_BUDGET_BYTES)
          : pageColsForRows(this.ring?.rows ?? 0, HISTORY_DEV_FRAME_BUDGET_BYTES),
      onSpliced: (resp) => {
        // Backfilled bars carry the CLOSE (price line) and cumulative CVD for the
        // scrolled-back region. Without routing them through the same sink as live
        // bars, the price line and CVD pane go BLANK over backfilled history while
        // the heatmap shows liquidity — the exact left-truncation the price line
        // was added to cure. The depth-splice loop already ran (so overlays.prune
        // to [oldest, newest] has happened); these bars fall inside that window and
        // survive. Markers likewise, for parity with the live stream.
        const overlays = this.host.overlays();
        for (const bar of resp.bar_cols) overlays.onBar(bar);
        for (const marker of resp.markers) overlays.onMarker(displayHistoryGap(marker));
        // Page end: regenerate the deferred SUM-mip range in batched passes.
        this.spliceMips.flush(this.mips, this.ring);
        this.frameState.dirty = true;
        // Re-arm the per-frame guard: if the visible range still isn't fully
        // resident (a wide pan needs several pages), the next frame fetches the
        // next page. Self-terminates once the left edge is covered — still O(1).
        this.frameState.viewMoved = true;
      },
    });
  }

  /** Forwards a history-loader prefetch of up to `targetCols` columns. */
  prefetchHistory(targetCols: number): void {
    void this.history?.prefetch(targetCols);
  }

  // --- coarse overview layer -------------------------------------------------

  /** The overview surface when the view is zoomed out past the ring, else null. */
  activeOverview(): OverviewSurface | null {
    return this.ring !== null && this.frameState.view.colScale > this.ring.capacityCols ? this.overview : null;
  }

  /** The overview surface, whatever the view (diagnostics and the normaliser). */
  get overviewSurface(): OverviewSurface | null {
    return this.overview;
  }

  /** Whether the overview history has loaded its whole span. */
  overviewComplete(): boolean {
    return this.overviewHistory?.complete ?? false;
  }

  /** Drop the overview history and surface (a new grid epoch or ring rebuild). */
  resetOverview(): void {
    this.host.follow().pendingOverviewFit = false;
    this.overviewHistory?.dispose();
    this.overview?.dispose();
    this.overviewHistory = null;
    this.overview = null;
    this.overviewEpoch = null;
  }

  /** Coarse history is independent of close-up GPU storage and reloads by pixel detail. */
  ensureOverview(ts: number): void {
    const ring = this.ring;
    const epoch = this.store.getState().gridEpoch;
    if (!ring || epoch === null || this.host.perfRunning() || this.frameState.view.colScale <= ring.capacityCols) return;
    if (this.overviewEpoch !== epoch) {
      const pending = this.overviewEpoch === null && this.host.follow().pendingOverviewFit;
      this.resetOverview();
      this.host.follow().pendingOverviewFit = pending;
    }
    if (this.overviewHistory === null) {
      this.overviewEpoch = epoch;
      this.overviewHistory = new OverviewHistory({
        active: () => this.ring === ring && this.overviewEpoch === epoch && !this.glLost() && !this.host.awaitingSession() && this.frameState.view.colScale > ring.capacityCols,
        resident: () => this.overview?.ring.residentRange() ?? null,
        // The signal is forwarded so a superseded overview page cancels its
        // in-flight request instead of holding the connection (state-08).
        request: (before, n, overview, signal) => this.store.getState().requestHistory(before, n, overview, signal),
        before: () => this.frameState.newestT0Ns + BigInt(this.axis.currentDtNs()),
        pageCols: () => pageColsForRows(ring.rows, serverOrigin() === null ? HISTORY_DEV_FRAME_BUDGET_BYTES : HISTORY_FRAME_BUDGET_BYTES),
        reset: (stride) => {
          this.overview?.dispose();
          this.overview = new OverviewSurface(this.ctx, ring.rows, this.lut, stride, this.axis.overlayPriceMap()?.scale ?? null, epoch,
            sourceEpoch => { const params = this.store.getState().epochs.get(sourceEpoch); return params ? this.axis.priceMapFor(params).scale ?? null : null; },
            () => { this.frameState.dirty = true; });
          this.frameState.dirty = true;
        },
        column: (column, stride) => {
          if (this.overview?.stride !== stride) return;
          this.overview.column(column);
          this.host.countUpload();
          this.frameState.dirty = true;
        },
        page: (response, stride) => {
          if (this.overview?.stride !== stride) return;
          this.overview.page(response);
          const overlays = this.host.overlays();
          for (const marker of response.markers) overlays.onMarker(displayHistoryGap(marker));
          const follow = this.host.follow();
          follow.priceFitMemo = null;
          if (this.camera.followPrice === 'fit') follow.fitPriceOverview();
        },
        changed: () => {
          const follow = this.host.follow();
          if (follow.pendingOverviewFit && this.overviewHistory?.complete) {
            follow.pendingOverviewFit = false;
            follow.fitPriceOverview();
          }
          this.frameState.dirty = true; this.host.notifyViewChanged();
        },
        yieldToFrame: () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))),
      });
    }
    this.overviewHistory.ensure(this.frameState.view, this.frameState.newestSeq, ts);
  }

  overviewStats(): { stride: number; capacity: number; buckets: number; inFlight: boolean; requests: number; error: string | null; revision: number; progress: { loaded: number; total: number }; resident: ResidentRange | null; timeBounds: { startNs: string; endNs: string } | null } | null {
    const history = this.overviewHistory;
    if (!history || !this.activeOverview()) return null;
    const slots = this.overview?.timeMap(this.axis.currentDtNs())?.slots;
    const timeBounds = slots && slots.t0.length > 0 ? {
      startNs: BigInt(Math.round(slots.t0[0])).toString(),
      endNs: (BigInt(Math.round(slots.t0[slots.t0.length - 1])) + BigInt(this.axis.currentDtNs() * history.stride)).toString(),
    } : null;
    return { stride: history.stride, capacity: this.overview?.ring.capacityCols ?? 0, buckets: history.cachedBuckets,
      inFlight: history.inFlight, requests: history.requests, error: history.error, revision: this.overview?.revision ?? 0,
      progress: history.progress, resident: this.overview?.ring.residentRange() ?? null, timeBounds };
  }

  // --- background and context loss -------------------------------------------

  /**
   * Paint the terminal near-black. The color is the ACTIVE ramp's LUT entry 0
   * (see clearColorForRamp) — the exact value the fragment shader's background()
   * samples — so a cleared canvas and a zero-density pixel are the same color
   * and a session reset cannot flash a different black.
   */
  clearBackground(): void {
    const gl = this.ctx.gl;
    const [r, g, b, a] = clearColorForRamp(this.host.activeRamp());
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** GL context lost: preventDefault so the browser will restore it, then stop
   *  touching the (now invalid) GL objects until `restored` rebuilds them. */
  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.resetOverview();
    this.host.onFrameLost();
    this.contextLost = true;
    this.contextLostCountN += 1;
    // The chart cannot draw until `restored`: report it through the same
    // failure surface as a shader error instead of a silent blank.
    this.host.setRenderFailure(CONTEXT_LOST_MESSAGE);
  };

  /** GL context restored: rebuild every GL object and re-fetch the visible range
   *  (the ring came back empty). Live appends also resume repopulating. A
   *  rebuild that throws is recorded as the render failure (the fallback shows
   *  it) and re-thrown asynchronously, the same way a frame error is, so the
   *  listener itself never throws and devtools still see the cause. */
  onContextRestored = (): void => {
    this.contextRestoredCountN += 1;
    this.host.onFrameRestored();
    try {
      this.host.rebuildGL();
      this.host.setRenderFailure(null);
    } catch (err) {
      this.host.setRenderFailure(err instanceof Error ? err.message : String(err));
      setTimeout(() => {
        throw err;
      }, 0);
    }
    this.contextLost = false;
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
  };

  /** Rebuild ctx + LUT + ring + heatmap + mips after a restore, preserving the
   *  camera view, then re-fetch the columns the viewport needs. */
  recreateGL(): void {
    // Context loss already freed the old program; deleting a stale handle on
    // the restored context would poison the next allocation error check.
    releaseHeatmapProgram(this.ctx.gl, false);
    // getContext on the restored canvas returns the same (now-revived) context;
    // re-obtain extension handles + caps and rebuild all GPU resources.
    this.ctx = initGL(this.canvas, {
      requireColorBufferFloat: this.requireColorBufferFloat,
      preserveDrawingBuffer: true,
    });
    this.lut = createLUTTexture(this.ctx.gl);
    // Overlay GL batches were invalidated by the loss — rebuild them (the 2D
    // text layer + overlay data survive).
    this.host.overlays().recreateGL(this.ctx.gl);

    this.host.resize();
    this.clearBackground();

    if (this.ringRows > 0) {
      // Rebuild the ring/heatmap/mips at the same geometry; the ring is empty.
      this.spliceMips.cancel();
      this.mips = null;
      this.heatmap = null;
      const ring = this.installRing(this.ringRows, this.ringLayers);
      // Geometry and camera policy survived the GPU loss. Resetting against
      // the empty cache would shrink All/history views and re-arm tracking
      // after a manual pan. Restore resources without changing either axis.
      this.camera.setLimits({ ...this.camera.limits, ...limitsFor(this.ringRows, ring.capacityCols), timeWindow: this.camera.limits.timeWindow });
      this.frameState.view = this.camera.toView();
    }
  }
}
