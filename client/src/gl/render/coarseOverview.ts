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

const PRICE_WARMUP_MS = 2_000;
const PRICE_GAP_MIN_NS = 90_000_000_000n;

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
  presented: boolean;
  /** The stride and bucket span the loader is filling; null before the first plan. */
  plan: OverviewPlan | null;
  resident: ResidentRange | null;
  timeBounds: { startNs: string; endNs: string } | null;
}

export class CoarseOverview {
  private overviewHistory: OverviewHistory | null = null;
  private overview: OverviewSurface | null = null;
  private previousOverview: OverviewSurface | null = null;
  private presented = false;
  private priceWarmUntil = 0;
  /**
   * The ring the overview was built for. A grid re-anchor (a new epoch on the
   * same ring) keeps the overview: every overview column carries its own epoch
   * geometry, exactly as the close-up ring does. Only a different ring (a row
   * count change or a session reset rebuilds it) starts the overview over.
   * Resetting on every epoch used to blank a zoomed-out chart (no time map, so
   * no price line, trades or axes either) each time the price moved far enough
   * to roll the grid, and reload every page.
   */
  private overviewRing: TileRing | null = null;

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

  /**
   * Keep the live ring on screen until the requested span is coherent. A
   * partially loaded overview stretches its isolated buckets across missing
   * clock time and temporarily displaces the live price and liquidity.
   */
  activeOverview(withTime = true): OverviewSurface | null {
    const ring = this.ring;
    if (!ring || this.host.perfRunning()) return null;
    const view = this.frameState.view;
    const end = view.colOffset + view.colScale;
    if (this.camera.state.colSpan <= ring.capacityCols) {
      const resident = ring.residentRange();
      if (!resident || Math.floor(view.colOffset) >= resident.oldest) return null;
    }
    const overview = this.presented ? this.overview : this.previousOverview;
    const resident = overview?.ring.residentRange();
    if (!overview || !resident || end <= resident.oldest * overview.stride
      || view.colOffset >= (resident.newest + 1) * overview.stride) return null;
    return !withTime || overview.timeMap(this.axis.currentDtNs()) ? overview : null;
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
    this.previousOverview?.dispose();
    this.overviewHistory = null;
    this.overview = null;
    this.previousOverview = null;
    this.overviewRing = null;
    this.presented = false;
    this.priceWarmUntil = 0;
  }

  /** Coarse history is independent of close-up GPU storage and reloads by pixel detail. */
  ensure(ts: number): void {
    const ring = this.ring;
    const epoch = this.store.getState().gridEpoch;
    if (!ring || epoch === null || this.host.perfRunning() || this.host.awaitingSession()
      || this.camera.state.colSpan <= ring.capacityCols) {
      this.overviewHistory?.suspend();
      return;
    }
    if (this.overviewRing !== ring) {
      const pending = this.overviewRing === null && this.host.follow().pendingOverviewFit;
      this.reset();
      this.host.follow().pendingOverviewFit = pending;
    }
    if (this.overviewHistory === null) {
      this.overviewRing = ring;
      this.overviewHistory = new OverviewHistory({
        active: () => this.ring === ring && this.overviewRing === ring && !this.glLost() && !this.host.awaitingSession() && this.camera.state.colSpan > ring.capacityCols,
        resident: () => this.overview?.ring.residentRange() ?? null,
        // The signal is forwarded so a superseded overview page cancels its
        // in-flight request instead of holding the connection.
        request: (before, n, overview, signal) => this.store.getState().requestHistory(before, n, overview, signal),
        before: () => this.frameState.newestT0Ns + BigInt(this.axis.currentDtNs()),
        pageCols: () => pageColsForRows(ring.rows, serverOrigin() === null ? HISTORY_DEV_FRAME_BUDGET_BYTES : HISTORY_FRAME_BUDGET_BYTES),
        reset: (stride) => {
          if (this.presented) {
            this.previousOverview?.dispose();
            this.previousOverview = this.overview;
          } else {
            this.overview?.dispose();
          }
          this.presented = false;
          this.priceWarmUntil = 0;
          // Native epoch: the grid's frame when this surface is built (a stride
          // change). Columns map through their own epoch's scale either way.
          this.overview = new OverviewSurface(this.ctx, ring.rows, this.lut, stride, this.axis.overlayPriceMap()?.scale ?? null,
            this.store.getState().gridEpoch ?? epoch,
            sourceEpoch => { const params = this.store.getState().epochs.get(sourceEpoch); return params ? this.axis.priceMapFor(params).scale ?? null : null; },
            () => { this.frameState.dirty = true; }, this.store.getState().subscription?.market === 'binance-spot');
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
          if (this.presented && this.camera.followPrice === 'fit') follow.fitPriceOverview();
        },
        changed: () => {
          this.tryPresent(performance.now());
          this.frameState.dirty = true; this.host.notifyViewChanged();
        },
        yieldToFrame: () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))),
      });
    }
    this.overviewHistory.ensure(this.frameState.view, this.frameState.newestSeq, ts);
    if (!this.presented || this.host.follow().pendingOverviewFit) this.tryPresent(ts);
  }

  private tryPresent(now: number): void {
    const surface = this.overview;
    if (!surface?.ready || this.overviewHistory?.complete !== true) return;
    const first = !this.presented;
    if (first) {
      if (!this.priceHistoryReady(surface, now)) return;
      this.presented = true;
      this.previousOverview?.dispose();
      this.previousOverview = null;
      this.frameState.dirty = true;
      this.host.notifyViewChanged();
    }
    const follow = this.host.follow();
    if (follow.pendingOverviewFit || (first && this.camera.followPrice === 'fit')) {
      follow.pendingOverviewFit = false;
      follow.fitPriceOverview();
    }
  }

  private priceHistoryReady(surface: OverviewSurface, now: number): boolean {
    const sub = this.store.getState().subscription;
    if (sub?.mode !== 'live' || sub.market !== 'binance-spot') return true;
    if (this.priceWarmUntil && now >= this.priceWarmUntil) return true;
    const { colOffset, colScale } = this.frameState.view;
    const left = colOffset / surface.stride;
    const right = (colOffset + colScale) / surface.stride;
    const gaps = surface.timeMap(this.axis.currentDtNs())?.priceGaps
      ?.filter(gap => gap.left < right && gap.right > left && gap.rightNs - gap.leftNs >= PRICE_GAP_MIN_NS)
      .sort((a, b) => Number((b.rightNs - b.leftNs) - (a.rightNs - a.leftNs)))
      .slice(0, 3);
    if (!gaps?.length) return true;
    if (!this.priceWarmUntil) this.priceWarmUntil = now + PRICE_WARMUP_MS;
    return this.host.overlays().warmPriceGaps(sub.symbol, gaps, () => {
      this.frameState.dirty = true;
      if (this.overview === surface && this.presented && this.camera.followPrice === 'fit') this.host.follow().fitPriceOverview();
    });
  }

  stats(): OverviewStats | null {
    const history = this.overviewHistory;
    // Diagnostics include the staged surface so the progress stays visible.
    if (!history || this.ring === null || this.camera.state.colSpan <= this.ring.capacityCols) return null;
    const slots = this.overview?.timeMap(this.axis.currentDtNs())?.slots;
    const timeBounds = slots && slots.t0.length > 0 ? {
      startNs: BigInt(Math.round(slots.t0[0])).toString(),
      endNs: (BigInt(Math.round(slots.t0[slots.t0.length - 1])) + BigInt(this.axis.currentDtNs() * history.stride)).toString(),
    } : null;
    return { stride: history.stride, capacity: this.overview?.ring.capacityCols ?? 0, buckets: history.cachedBuckets,
      inFlight: history.inFlight, requests: history.requests, error: history.error, revision: this.overview?.revision ?? 0,
      progress: history.progress, presented: this.presented, plan: history.range, resident: this.overview?.ring.residentRange() ?? null, timeBounds };
  }
}
