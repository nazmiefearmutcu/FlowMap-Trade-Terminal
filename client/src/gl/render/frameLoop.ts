/**
 * Frame loop of the live renderer: the rAF scheduling and the dirty-only
 * presentation, the render-health surface (the render failure, the bounded
 * program-readiness retry and its hold), the scripted perf run and the per-frame
 * stats EMA. Renderer keeps the public stubs and the constructor wiring.
 */
import type { BenchmarkMetrics } from '../benchmarkMetrics';
import type { Camera } from '../camera';
import type { ColumnCache } from '../columnCache';
import { renderProgramsReady } from '../heatmapProgram';
import type { PerfResult, RendererStats } from '../rendererTypes';
import type { AxisMap } from './axisMap';
import type { DepthIngest } from './depthIngest';
import type { FollowPolicy } from './followPolicy';
import type { FrameState } from './frameState';
import { CONTEXT_LOST_MESSAGE, type GpuLifecycle } from './gpuLifecycle';
import type { OverlayLayer } from './overlayLayer';
import type { Shading } from './shading';

/**
 * Consecutive failing program-readiness checks before the frame loop stops
 * recompiling until {@link FrameLoop.retryRender}. The constructor's
 * attempt is the first; the first frame is the one automatic retry.
 */
const PROGRAM_RETRY_LIMIT = 2;
/** EMA weight for the per-frame stats ({@link FrameLoop.stats}). */
const STATS_EMA_ALPHA = 0.1;

export interface PerfRun {
  kind: 'pan' | 'zoom';
  deadline: number;
  deltas: number[];
  drawMs: number[];
  lastTs: number;
  panStep: number;
  zoomAnchor: number;
  zoomDir: number;
  zoomMax: number;
  resolve: (r: PerfResult) => void;
}

/**
 * What the frame loop reads from its owner. The modules are live references, so
 * a later reassignment (a rebuilt ring, a restored context) is seen at use time.
 */
export interface FrameHost {
  readonly benchmark: BenchmarkMetrics | null;
  readonly frameState: FrameState;
  readonly camera: Camera;
  readonly gpu: GpuLifecycle;
  readonly ingest: DepthIngest;
  readonly follow: FollowPolicy;
  readonly shading: Shading;
  readonly axis: AxisMap;
  readonly overlayLayer: OverlayLayer;
  readonly columnCache: ColumnCache;
  /**
   * The Renderer-level price-fit entry. Internal calls go through it so a spy
   * on the Renderer instance still sees every fit.
   */
  applyPriceFitFrame(): boolean;
}

export class FrameLoop {
  /** A scripted perf run in flight; the Renderer's perf hooks set it, the frame steps it. */
  perf: PerfRun | null = null;
  /** The session the last presented frame belonged to; read by marketFrameReady. */
  presentedSessionId: string | null = null;
  /** The message of the latest failing frame, or null while frames render. */
  renderFailure: string | null = null;
  /** Consecutive failing program-readiness checks. */
  programFailures = 0;
  /** Set once the program keeps failing: the loop holds until retryRender(). */
  programHold = false;

  private running = true;
  private rafId = 0;
  private drawCountN = 0;
  private lastDrawEndTsN = 0;
  /** A frame threw and the failure is already surfaced (report-once guard). */
  private frameErrored = false;

  // Live stats — updated in-place inside frame(); no allocations.
  private statsFpsEma = 0;
  private statsFrameMsEma = 0;
  private statsLastRafTs = 0;
  private statsUploadsN = 0;

  private readonly host: FrameHost;
  private readonly gpu: GpuLifecycle;
  private readonly ingest: DepthIngest;
  private readonly follow: FollowPolicy;
  private readonly frameState: FrameState;
  private readonly camera: Camera;
  private readonly shading: Shading;
  private readonly axis: AxisMap;
  private readonly overlayLayer: OverlayLayer;

  constructor(host: FrameHost) {
    this.host = host;
    this.gpu = host.gpu;
    this.ingest = host.ingest;
    this.follow = host.follow;
    this.frameState = host.frameState;
    this.camera = host.camera;
    this.shading = host.shading;
    this.axis = host.axis;
    this.overlayLayer = host.overlayLayer;
  }

  /** Request the first frame. The Renderer calls this last in its constructor. */
  start(): void {
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Stop the loop: the next scheduled callback is not re-armed. */
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Counts one texture upload for the stats (called by the GPU lifecycle and the ingest). */
  countUpload(): void {
    this.statsUploadsN++;
  }

  /** A session switch forgets the presented session (the ingest reset path). */
  forgetPresentedSession(): void {
    this.presentedSessionId = null;
  }

  /** The GL context was lost: the presented session and any scripted run are void. */
  onFrameLost(): void {
    this.presentedSessionId = null;
    this.perf = null; // any in-flight perf run is void
  }

  /** The GL context was restored: re-arm the program-readiness retry. */
  onFrameRestored(): void {
    this.programFailures = 0;
    this.programHold = false;
  }

  /** Frames drawn so far (monotonic). */
  get drawCount(): number {
    return this.drawCountN;
  }

  /** performance.now() at the end of the last draw (input→frame latency proxy). */
  get lastDrawEndTs(): number {
    return this.lastDrawEndTsN;
  }

  /**
   * Render-health snapshot: `{fps, frameMs, uploads, draws,
   * cacheBytes}`. O(1); the counters are maintained inside the existing rAF
   * frame (fps/frameMs EMA-smoothed with alpha ≈ 0.1); this call only copies
   * five numbers into the returned object — safe to poll at a few Hz.
   */
  stats(): RendererStats {
    return {
      fps: this.statsFpsEma,
      frameMs: this.statsFrameMsEma,
      uploads: this.statsUploadsN,
      draws: this.drawCountN,
      cacheBytes: this.host.columnCache.byteLength + (this.gpu.overviewSurface?.cache.byteLength ?? 0),
    };
  }

  /** Why the last frame failed, or null while frames render (see the Renderer stub). */
  getRenderFailure(): string | null {
    return this.renderFailure;
  }

  /**
   * Re-arm after a render failure: clears the recorded cause so the
   * startup gate and fallback stop reporting it, lifts the program hold and
   * marks the next frame dirty so the heatmap program recompiles (a failed link
   * drops the cached program). A context that is still broken records the same
   * failure again on that frame. While the GL context is lost the failure stays
   * reported; the restore event clears it.
   */
  retryRender(): void {
    this.programHold = false;
    this.programFailures = 0;
    this.frameErrored = false;
    this.frameState.dirty = true;
    if (this.gpu.contextLostFlag) {
      this.gpu.restoreLostContext();
      this.renderFailure = CONTEXT_LOST_MESSAGE;
      return;
    }
    this.renderFailure = null;
  }

  /**
   * Program readiness with a bounded retry. A link failure is rethrown
   * so the caller records it. After {@link PROGRAM_RETRY_LIMIT} consecutive
   * failures the frame loop holds: a shader that never links is not recompiled
   * every frame, and {@link retryRender} lifts the hold.
   */
  programsReady(): boolean {
    try {
      const ready = renderProgramsReady(this.gpu.ctx.gl, this.gpu.ctx.caps.colorBufferFloat);
      this.programFailures = 0;
      return ready;
    } catch (err) {
      this.programFailures += 1;
      if (this.programFailures >= PROGRAM_RETRY_LIMIT) this.programHold = true;
      throw err;
    }
  }

  /**
   * Program readiness for the depth ingest. While the hold is set it answers
   * "not ready" without touching GL, so a shader that never links is not
   * recompiled once per arriving column; the frame loop owns the retry and
   * {@link retryRender} lifts the hold. A link failure throws, as in programsReady.
   */
  programsReadyForIngest(): boolean {
    if (this.programHold) return false;
    return this.programsReady();
  }

  /** Apply this frame's scripted camera op during a perf run. */
  private stepPerf(perf: PerfRun): void {
    if (perf.kind === 'pan') {
      // Scroll the view steadily back through history (real pan op, follow off).
      this.camera.pan(perf.panStep, 0);
    } else {
      const span = this.camera.state.colSpan;
      if (span <= this.camera.limits.minColSpan * 1.5) perf.zoomDir = 1;
      else if (span >= perf.zoomMax) perf.zoomDir = -1;
      const f = perf.zoomDir < 0 ? 0.97 : 1 / 0.97;
      this.camera.zoomTime(f, perf.zoomAnchor);
    }
    this.frameState.view = this.camera.toView();
  }

  /**
   * One rAF tick. Returns false when the tick is skipped (a lost context, a held
   * or unready program): the caller then keeps the failure record as it is.
   */
  private renderFrame(ts: number): boolean {
    // A lost context can't draw; wait for `restored` to rebuild GL.
    if (this.gpu.glLost()) return false;
    if (this.programHold) return false;
    if (!this.programsReady()) return false;
    this.drainDepthBatch();
    this.sampleCadence(ts);

    const perf = this.perf;
    if (perf) this.stepPerfFrame(perf, ts);
    this.followAndHistory(ts, perf);
    this.drawIfDirty(perf);

    if (perf && ts >= perf.deadline) {
      this.perf = null;
      perf.resolve({ deltas: perf.deltas, drawMs: perf.drawMs, frames: perf.drawMs.length });
    }
    return true;
  }

  /** Ingests a bounded batch of staged depth columns, time-boxed to about 4 ms. */
  private drainDepthBatch(): void {
    if (this.ingest.pendingDepth.length === 0) return;
    const ingestStart = performance.now();
    this.ingest.drainingDepth = true;
    try {
      for (let n = 0; n < 8 && this.ingest.pendingDepth.length > 0; n++) {
        this.ingest.onDepthColumn(this.ingest.pendingDepth.shift()!);
        if (performance.now() - ingestStart >= 4) break;
      }
    } finally {
      this.ingest.drainingDepth = false;
    }
  }

  /**
   * Live stats: EMA the rAF cadence in place — no allocations, no GL calls.
   * Deltas >1 s (a suspended tab) are skipped rather than folded in as a fake 1 fps.
   */
  private sampleCadence(ts: number): void {
    if (this.statsLastRafTs > 0) {
      const dt = ts - this.statsLastRafTs;
      if (dt > 0 && dt < 1000) {
        const sample = 1000 / dt;
        this.statsFpsEma =
          this.statsFpsEma > 0
            ? this.statsFpsEma + STATS_EMA_ALPHA * (sample - this.statsFpsEma)
            : sample;
      }
    }
    this.statsLastRafTs = ts;
  }

  /** One scripted perf-run frame: the cadence sample, the camera op, and a forced redraw. */
  private stepPerfFrame(perf: PerfRun, ts: number): void {
    if (perf.lastTs > 0) perf.deltas.push(ts - perf.lastTs);
    perf.lastTs = ts;
    this.stepPerf(perf);
    this.frameState.dirty = true; // force a redraw every frame while measuring
  }

  /**
   * The per-frame camera work that runs before the draw: the price fit of bar
   * ranges, the price and time follow glides, the overview and the scroll-back
   * request for the visible range.
   */
  private followAndHistory(ts: number, perf: PerfRun | null): void {
    // Consume changed bar prices once, before presenting the frame. Check
    // the current camera policy here: a lock/pan after arrival owns its frame.
    // Only the hybrid FIT policy depends on these bar ranges; linear depth
    // fitting and the time-follow frame stay on their existing paths.
    if (this.follow.barPriceFitPending && this.gpu.ring !== null && !this.ingest.awaitingSession) {
      this.follow.barPriceFitPending = false;
      if (perf === null && this.camera.followPrice === 'fit'
        && this.axis.overlayPriceMap()?.scale?.kind === 'hybrid') {
        this.follow.priceFitMemo = null;
        if (this.host.applyPriceFitFrame()) this.follow.initialPriceFramed = true;
      }
    }

    // Price auto-follow glide (O(1): a handful of scalars). No-op unless the
    // camera is in 'track' mode with the live edge on screen.
    this.follow.stepPriceFollow(ts);

    // Eased live-edge scroll (O(1) scalars): the drawn view trails the logical
    // follow frame by a decaying sub-column lag, so time-follow glides instead
    // of jumping once per column. Re-dirties while the glide is in flight.
    this.follow.stepLiveEdgeGlide(ts);

    this.gpu.ensureOverview(ts);

    // On frames where the view moved, ask the loader to ensure the visible
    // range is populated. This guard is O(1) (visible-left vs resident-oldest) —
    // never O(history) — so the perf gate stays green.
    if (this.frameState.viewMoved && this.gpu.history !== null && this.gpu.ring !== null && this.frameState.view.colScale <= this.gpu.ring.capacityCols) {
      this.frameState.viewMoved = false;
      this.gpu.history.ensureVisible({
        leftCol: Math.floor(this.frameState.view.colOffset),
        span: this.frameState.view.colScale,
        following: this.camera.followTime,
        // Display LOD does not suppress history: every mip is generated from
        // the same resident columns, including when the price axis is wide.
        level: this.shading.currentLevel(false),
      });
    }
  }

  /** The heatmap pass, the overlays and the settle frames, when the frame is dirty. */
  private drawIfDirty(perf: PerfRun | null): void {
    if (!this.frameState.dirty || this.gpu.heatmap === null) return;
    // Safety net: a splice batch whose page-end callback hasn't run yet
    // (should not happen — onSpliced always fires) flushes before drawing.
    this.gpu.spliceMips.flush(this.gpu.mips, this.gpu.ring);
    // Refresh u_norm from the visible window before drawing (O(tiles),
    // outside the measured draw cost; a no-op during the perf preload run).
    this.shading.updateNormalization();
    const t0 = performance.now();
    this.gpu.heatmap.priceScale = this.axis.overlayPriceMap()?.scale ?? null;
    const overview = this.gpu.activeOverview();
    if (overview) overview.draw(this.frameState.view, this.gpu.heatmap);
    else this.gpu.heatmap.draw(this.frameState.view);
    // Overlays draw OVER the heatmap, O(visible). They are part of the
    // frame the HUD reports: the PerfHud chip is the project's own
    // regression sensor, and overlays are on by default — measuring only
    // the heatmap pass understates the real draw cost. Skipped during a perf
    // run (the gate measures the flushed heatmap pass alone) and when
    // there is no epoch to map events/prices onto (perf preload). A throw
    // here is surfaced once by the frame loop, like any other frame error.
    if (perf === null) this.overlayLayer.drawOverlays();
    // Live stats: EMA the FULL frame draw cost (no gl.finish — the cheap
    // sample; the perf-run path below still measures the true flushed cost).
    const drawCost = performance.now() - t0;
    this.statsFrameMsEma =
      this.statsFrameMsEma > 0
        ? this.statsFrameMsEma + STATS_EMA_ALPHA * (drawCost - this.statsFrameMsEma)
        : drawCost;
    if (perf) {
      // Flush the (software) GL pipeline so the sample is the true frame cost.
      this.gpu.ctx.gl.finish();
      perf.drawMs.push(performance.now() - t0);
    }
    this.frameState.dirty = false;
    this.drawCountN++;
    if ((this.gpu.ring?.residentRange()?.count ?? 0) > 0 && !this.ingest.awaitingSession) {
      this.presentedSessionId = this.ingest.lastSessionId;
    }
    this.lastDrawEndTsN = performance.now();

    // Keep redrawing until the viewport norm reaches its target so the
    // contrast glides into a new regime (~0.3 s) instead of snapping.
    // O(tiles)/frame for the handful of settle frames; a no-op once
    // converged and in the perf preload path (no histogram data).
    if (this.shading.normSettling()) this.frameState.dirty = true;
  }

  private readonly frame = (ts: number): void => {
    if (!this.running) return;
    const benchmarkStart = this.host.benchmark ? performance.now() : 0;
    const benchmarkDraws = this.drawCountN;
    try {
      if (!this.renderFrame(ts)) return;
      // A clean frame re-arms the error surface: a NEW failure episode is
      // reported, a persistently broken context is not spammed every frame.
      this.frameErrored = false;
      this.renderFailure = null;
    } catch (err) {
      // One GL error must never kill the render loop: the finally below
      // reschedules no matter what, and the failure is surfaced ONCE per episode
      // (re-thrown async so devtools and the e2e "no GL errors" gate still see
      // it) instead of silently disabling the heatmap forever.
      // Every failing frame records its cause. A shader that never links keeps
      // failing, so the state persists for the UI (gl-fallback / startup gate).
      this.renderFailure = err instanceof Error ? err.message : String(err);
      if (!this.frameErrored) {
        this.host.benchmark?.count('frameErrors');
        this.frameErrored = true;
        setTimeout(() => {
          throw err;
        }, 0);
      }
    } finally {
      this.host.benchmark?.frame(ts, benchmarkStart, performance.now(), this.drawCountN !== benchmarkDraws);
      if (this.running) this.rafId = requestAnimationFrame(this.frame);
    }
  };
}
