/**
 * The coarse overview layer of the GPU lifecycle: the pixel-detail history that
 * replaces the ring when the view is zoomed out past its capacity. It owns the
 * overview surface, its history loader and the grid epoch it was built for;
 * {@link GpuLifecycle} delegates to it. The overview is rebuilt, never
 * re-uploaded, when the grid epoch changes.
 */

import type { ResidentRange, TileRing } from '../tileRing';
import type { GLContext } from '../context';
import type { Camera } from '../camera';
import { OverviewSurface } from '../overviewSurface';
import { displayHistoryGap } from '../historyGap';
import { OverviewHistory, type OverviewPlan } from '../../net/overviewHistory';
import {
  HISTORY_DEV_FRAME_BUDGET_BYTES,
  HISTORY_FRAME_BUDGET_BYTES,
  pageColsForRows,
} from '../../net/history';
import { serverOrigin } from '../../net/serverBase';
import type { AxisMap } from './axisMap';
import type { FrameState, StateSource } from './frameState';
import type { GpuHost, GpuLifecycle } from './gpuLifecycle';

/** The coarse overview's diagnostics (see {@link CoarseOverview.stats}). */
export interface OverviewStats {
  stride: number;
  capacity: number;
  buckets: number;
  inFlight: boolean;
  requests: number;
  error: string | null;
  revision: number;
  progress: { loaded: number; total: number };
  /** The stride and bucket span the loader is filling; null before the first plan. */
  plan: OverviewPlan | null;
  resident: ResidentRange | null;
  timeBounds: { startNs: string; endNs: string } | null;
}

export class CoarseOverview {
  private overviewHistory: OverviewHistory | null = null;
  private overview: OverviewSurface | null = null;
  private overviewEpoch: number | null = null;

  constructor(
    private readonly gpu: GpuLifecycle,
    private readonly host: GpuHost,
  ) {}

  private get ring(): TileRing | null { return this.gpu.ring; }
  private get ctx(): GLContext { return this.gpu.ctx; }
  private get lut(): WebGLTexture { return this.gpu.lut; }
  private get store(): StateSource { return this.host.store; }
  private get frameState(): FrameState { return this.host.frameState; }
  private get camera(): Camera { return this.host.camera; }
  private get axis(): AxisMap { return this.host.axis; }
  private glLost(): boolean { return this.gpu.glLost(); }

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
  reset(): void {
    this.host.follow().pendingOverviewFit = false;
    this.overviewHistory?.dispose();
    this.overview?.dispose();
    this.overviewHistory = null;
    this.overview = null;
    this.overviewEpoch = null;
  }

  /** Coarse history is independent of close-up GPU storage and reloads by pixel detail. */
  ensure(ts: number): void {
    const ring = this.ring;
    const epoch = this.store.getState().gridEpoch;
    if (!ring || epoch === null || this.host.perfRunning() || this.frameState.view.colScale <= ring.capacityCols) return;
    if (this.overviewEpoch !== epoch) {
      const pending = this.overviewEpoch === null && this.host.follow().pendingOverviewFit;
      this.reset();
      this.host.follow().pendingOverviewFit = pending;
    }
    if (this.overviewHistory === null) {
      this.overviewEpoch = epoch;
      this.overviewHistory = new OverviewHistory({
        active: () => this.ring === ring && this.overviewEpoch === epoch && !this.glLost() && !this.host.awaitingSession() && this.frameState.view.colScale > ring.capacityCols,
        resident: () => this.overview?.ring.residentRange() ?? null,
        // The signal is forwarded so a superseded overview page cancels its
        // in-flight request instead of holding the connection.
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

  stats(): OverviewStats | null {
    const history = this.overviewHistory;
    if (!history || !this.activeOverview()) return null;
    const slots = this.overview?.timeMap(this.axis.currentDtNs())?.slots;
    const timeBounds = slots && slots.t0.length > 0 ? {
      startNs: BigInt(Math.round(slots.t0[0])).toString(),
      endNs: (BigInt(Math.round(slots.t0[slots.t0.length - 1])) + BigInt(this.axis.currentDtNs() * history.stride)).toString(),
    } : null;
    return { stride: history.stride, capacity: this.overview?.ring.capacityCols ?? 0, buckets: history.cachedBuckets,
      inFlight: history.inFlight, requests: history.requests, error: history.error, revision: this.overview?.revision ?? 0,
      progress: history.progress, plan: history.range, resident: this.overview?.ring.residentRange() ?? null, timeBounds };
  }
}
