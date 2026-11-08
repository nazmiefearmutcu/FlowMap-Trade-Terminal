/**
 * Follow policy and camera glide: the time-follow frame, the price auto-fit,
 * the price track glide, the eased live-edge lag, the follow setters, GO LIVE
 * and the time-window presets, plus the remap of user-owned price frames across
 * epoch changes. Extracted from renderer.ts; the Renderer keeps one-line
 * delegates for every name a test or a sibling module reaches.
 *
 * The cursors are public fields on purpose: the renderer's tests read and
 * write them through `follow`, so the Renderer carries no shadow copies.
 */

import { priceFrame, type Camera, type PriceFollow } from '../camera';
import {
  advanceLiveEdgeLag,
  approach,
  glideTauMs,
  isColVisible,
  PRICE_GLIDE_TAU_MS,
  PRICE_SNAP_ROWS,
  priceFollowTarget,
  reducedMotionQuery,
  TIME_GLIDE_MAX_LAG,
  TIME_GLIDE_SETTLE_EPS,
  TIME_GLIDE_STEADY_LAG,
  trackedRow,
} from '../follow';
import { mapScale, remapRow, remapRowSpan, type PriceMap } from '../overlays/coords';
import type { OverlayManager } from '../overlays/manager';
import type { OverviewSurface } from '../overviewSurface';
import { priceOverviewBounds } from '../priceOverview';
import { priceToPlotRow, priceToRow as scalePriceToRow, rowToPrice as scaleRowToPrice } from '../priceScale';
import { clamp } from '../numeric';
import type { TileRing } from '../tileRing';
import type { FlowMapState } from '../../state/store';
import type { AxisMap } from './axisMap';
import type { FrameState } from './frameState';

const MIN_VISIBLE_COLS = 32;
const ROW_PAD_FRACTION = 0.08;
const MIN_ROW_PAD = 3;

/**
 * What the follow policy reads from its owner. Getters are called at use time,
 * so the owner's later reassignments (ring, overlays, overview) are seen.
 */
export interface FollowHost {
  readonly camera: Camera;
  readonly frameState: FrameState;
  readonly axis: AxisMap;
  readonly store: { getState(): FlowMapState };
  /** Pixels per column and the visible-column ceiling, for the default time window. */
  readonly columnPx: number;
  readonly maxVisibleCols: number;
  ring(): TileRing | null;
  overlays(): OverlayManager;
  activeOverview(): OverviewSurface | null;
  /** Whether the overview history has loaded its whole span. */
  overviewComplete(): boolean;
  extentLo(): Int32Array;
  extentHi(): Int32Array;
  extentSeq(): Int32Array;
  cssWidth(): number;
  cssHeight(): number;
  /** A scripted perf run owns the camera while this holds. */
  perfRunning(): boolean;
  /** Drops the scroll-back loader's probe state (GO LIVE leaves scroll-back). */
  resetHistory(): void;
  notifyViewChanged(): void;
  /**
   * The Renderer-level price-fit entry. Internal calls go through it so a spy
   * on the Renderer instance still sees every fit.
   */
  applyPriceFitFrame(): boolean;
}

export class FollowPolicy {
  private readonly host: FollowHost;
  private readonly camera: Camera;
  private readonly frameState: FrameState;
  private readonly axis: AxisMap;
  private readonly store: { getState(): FlowMapState };
  /** OS reduced-motion preference (WCAG 2.3.3); glides snap while it matches. */
  private readonly motionQuery: MediaQueryList | null;

  // --- price auto-follow (gl/follow.ts) ---------------------------------------
  /** Row the live book is currently centred on, or null before any column. */
  trackedRowN: number | null = null;
  /**
   * Epoch the ROW was derived from. The incident: a new epoch's column
   * arrived before the store held its params, `trackedRowN` was recorded from
   * its book anyway, and the later remap read it through the OLD affine — a
   * silent park in the deep wing. Tracked state is epoch-scoped; a mismatched
   * or missing epoch drops the row instead of remapping it.
   */
  trackedEpoch: number | null = null;
  /** Epoch `trackedRowN` / the camera's price frame are expressed in. */
  priceEpoch: number | null = null;
  /** Armed by resetOverlaysForNewSession; consumed by the next remap. */
  forcedRemapFrom: PriceMap | null = null;
  /** Armed recentre target (rows); null while price sits inside the deadband. */
  priceTarget: number | null = null;
  /** Timestamp of the last price-follow step, for the frame-rate-independent ease. */
  priceStepTs = 0;
  /** Memoized price auto-fit: the extent union is only re-scanned when the
   *  visible window or the live edge actually moves. */
  priceFitMemo: { lo: number; hi: number; newest: number; rowBottom: number; rowSpan: number } | null =
    null;
  initialPriceFramed = false;
  /** Late bars can change hybrid FIT after the last paused snapshot depth. */
  barPriceFitPending = false;
  pendingOverviewFit = false;
  /**
   * The follow policy the USER/settings asked for, re-asserted after every
   * `camera.reset()`. Without it the first depth column's `createRing()` reset
   * silently discards persisted follow state (the ring is created lazily, always
   * after App's mount effect has run).
   */
  wantFollowTime = true;
  wantPriceFollow: PriceFollow = 'fit';

  /**
   * A manual TIME zoom (wheel / keyboard) marks
   * the span user-owned, and every later follow re-arm (GO LIVE, Space, the
   * tracking chip) re-pins ONLY the right edge at that exact span. Without
   * this flag the follow frame re-derived the default `cssW / columnPx`
   * window and snapped a zoomed-out (or zoomed-in) view back to it — the
   * reported "GO LIVE → very close view" bug. Cleared on session reset, where
   * the default window is the correct initial frame.
   */
  userTimeZoomed = false;
  /** undefined = manual zoom, null = all resident history, number = duration. */
  requestedTimeWindow: number | null | undefined = undefined;

  // --- eased live-edge scroll (time-follow smoothness) ---------------------------
  // The logical follow frame (applyTimeFollowFrame) still pins the right edge a
  // whole column past newestSeq the moment a column lands; the DRAWN view trails
  // it by `liveLag` columns, decayed every frame (gl/follow.ts stepLiveEdgeLag),
  // so the chart scrolls continuously instead of jumping once per column. This
  // is uniforms-only — no column is re-uploaded, and every consumer that draws
  // from `frameState.view` (heatmap, overlays, axes, timeline minimap) glides in sync.
  /** Current drawn lag behind the logical follow frame, in columns (0 = exact). */
  liveLag = 0;
  /** newestSeq the arrival count was last stepped against (per-frame delta). */
  lagBaseSeq = -1;
  /** rAF timestamp of the previous glide step (0 = first frame). */
  glideLastTs = 0;
  /** followTime state at the previous glide step — a false→true re-arm (GO
   *  LIVE / Space / chip) snaps today and must not ALSO carry a stale lag. */
  glideWasFollowing = false;

  constructor(host: FollowHost) {
    this.host = host;
    this.camera = host.camera;
    this.frameState = host.frameState;
    this.axis = host.axis;
    this.store = host.store;
    this.motionQuery = reducedMotionQuery(typeof window === 'undefined' ? null : window);
  }

  /** Whether the newest resident column is inside the logical follow frame. Read by the Renderer's liveEdgeVisible stub. */
  get liveEdgeVisible(): boolean {
    if (this.frameState.newestSeq < 0) return false;
    return isColVisible(this.camera.toView(), this.frameState.newestSeq);
  }

  /**
   * Recompute the view uniforms. The two axes are INDEPENDENT: time re-derives
   * the follow frame while `followTime` is on, price re-derives the auto-fit
   * frame while `followPrice === 'fit'`. Either can be user-owned without
   * freezing the other — scrolling back through history keeps the price axis
   * auto-scaling, and zooming price keeps the right edge pinned to now. Where
   * the user owns an axis, the camera's pan/zoom state is authoritative and only
   * the uniform cache is refreshed.
   */
  updateView(): void {
    const before = this.frameState.view;
    this.camera.priceScale = this.axis.overlayPriceMap()?.scale ?? null;
    // Refresh the known TIME data window so user pan/zoom
    // ops clamp to it (bounded overscroll past the history ends; zoom-out floor
    // = resident coverage). See gl/camera.ts TimeWindow. No re-clamp here.
    // Floor: the protocol's start of stream (0) while older history may still
    // exist; once the loader reports exhaustion it is the loaded data edge, so
    // the pan stops ON data instead of a region the server can never supply.
    const range = this.host.ring()?.residentRange() ?? null;
    this.camera.setTimeWindow({
      floor: 0,
      newest: this.frameState.newestSeq,
      resident: range,
    });
    if (this.camera.followTime) this.applyTimeFollowFrame();
    if (this.camera.followPrice === 'fit' || !this.initialPriceFramed) {
      // A saved lock has no meaningful frame for a new instrument. Fit its
      // first nonempty book once, then respect the user's existing follow mode.
      if (this.host.applyPriceFitFrame()) this.initialPriceFramed = true;
    }
    this.frameState.view = this.camera.toView();
    // Re-apply the CURRENT eased lag (without stepping the dynamics — frame()
    // owns the step) so the change-notify never carries the un-eased logical
    // frame: this.frameState.view is otherwise jumped +1 column at this arrival, and
    // consumers riding the seam (the timeline minimap) read forward-then-
    // backward stepping at the column cadence.
    // Absorb THIS arrival into the lag at zero-dt (the frame's glide step
    // still owns consumption): the notify view is then display-continuous —
    // the +1 column of logical advance is exactly cancelled by the longer trail.
    if (
      this.camera.followTime &&
      this.liveGlideActive() &&
      this.frameState.newestSeq > this.lagBaseSeq
    ) {
      const a = Math.min(this.frameState.newestSeq - this.lagBaseSeq, 8);
      this.lagBaseSeq = this.frameState.newestSeq;
      this.liveLag = Math.min(this.liveLag + a, TIME_GLIDE_MAX_LAG);
    }
    if (this.liveLag > 0) {
      this.frameState.view = { ...this.frameState.view, colOffset: this.frameState.view.colOffset - this.liveLag };
    }
    // Fire the view-changed seam only when a uniform actually moved: updateView
    // runs per appended column while following, and most appends reframe a
    // sub-pixel delta that must not spam listeners.
    if (
      this.frameState.view.colOffset !== before.colOffset ||
      this.frameState.view.colScale !== before.colScale ||
      this.frameState.view.rowOffset !== before.rowOffset ||
      this.frameState.view.rowScale !== before.rowScale
    ) {
      this.host.notifyViewChanged();
    }
  }

  /** Time half of the follow frame: right edge pinned to the newest column. */
  private applyTimeFollowFrame(): void {
    const ring = this.host.ring();
    if (ring === null) return;
    const range = ring.residentRange();
    if (range === null) return;

    const cap = ring.capacityCols;
    const cssW = Math.max(1, this.host.cssWidth());
    let visible: number;
    if (this.requestedTimeWindow !== undefined) {
      let start = 0;
      if (this.requestedTimeWindow !== null) {
        const endNs = this.axis.timestampAtColumn(this.frameState.newestSeq + 1);
        if (endNs !== null) {
          const mapped = this.axis.columnAtTimestamp(endNs - BigInt(Math.round(this.requestedTimeWindow * 1e6)));
          if (mapped !== null) start = Math.max(0, mapped);
        }
      }
      visible = Math.max(1, this.frameState.newestSeq + 1 - start);
      this.camera.state = { ...this.camera.state, colCenter: this.frameState.newestSeq + 1 - visible / 2, colSpan: visible };
      return;
    }
    if (this.userTimeZoomed) {
      // The user's time zoom is sacred — GO LIVE /
      // any follow re-arm keeps EXACTLY their span (float, un-rounded) and only
      // slides the right edge. NO default-window clamp and NO data clamp here:
      // the SAME camera limits the wheel zoom already respected (minColSpan /
      // the residency-scaled zoom-out cap) are re-applied by setTimeFrame,
      // so a span the user could reach passes through unchanged. (The data
      // min() below stays on the default path only — clamping a preserved
      // zoom to ring capacity snapped 17136 → 8634 in live verification.)
      visible = this.camera.state.colSpan;
      if (!Number.isFinite(visible) || visible < 1) visible = MIN_VISIBLE_COLS;
      this.camera.setTimeFrame(this.frameState.newestSeq - visible + 1, visible);
      return;
    } else {
      visible = Math.round(cssW / this.host.columnPx);
      visible = clamp(visible, MIN_VISIBLE_COLS, this.host.maxVisibleCols);
    }
    // Fill the width with what we have, then lock and scroll once it's full.
    visible = Math.min(visible, cap, range.count);

    this.camera.setTimeFrame(range.newest - visible + 1, visible);
  }

  /**
   * Price half: fit to the union of non-zero row extents over the CURRENT
   * visible column window (not the follow window), so auto-fit keeps working
   * after the user has scrolled back through history.
   *
   * Three properties worth stating, each of which is a bug if dropped:
   *  - Slots whose `extentSeq` does not match the column being read are SKIPPED.
   *    `Residency` over-claims during backfill (see the extentSeq stamp in
   *    renderer.ts), so the unfiltered scan would union a foreign price band into the fit.
   *  - When the scan finds nothing the price frame is LEFT ALONE. Snapping to
   *    the whole grid here would detonate rowScale ~17× the moment the user pans
   *    into a sparse region — the genuinely-empty case is the `range === null`
   *    early return above it.
   *  - The result is memoized on {lo, hi, newest}, so the common case (a frozen
   *    window while columns stream in) costs one comparison per column, not a
   *    rescan. `writeColumn` invalidates the memo.
   */
  applyPriceFit(): boolean {
    const ring = this.host.ring();
    if (ring === null) return false;
    if (this.frameState.view.colScale > ring.capacityCols) {
      this.preparePriceOverview();
      const bounds = this.camera.priceZoomBounds;
      const scale = this.camera.priceScale;
      if (!bounds || !scale) return false;
      const low = scalePriceToRow(scale, bounds.low), high = scalePriceToRow(scale, bounds.high);
      this.camera.setPriceFrame(low, high - low);
      return true;
    }
    const range = ring.residentRange();
    if (range === null) return false;

    const cap = ring.capacityCols;
    const st = this.camera.state;
    const lo = Math.max(range.oldest, Math.floor(st.colCenter - st.colSpan / 2));
    const hi = Math.min(range.newest, Math.ceil(st.colCenter + st.colSpan / 2));
    if (hi < lo) return false;

    const memo = this.priceFitMemo;
    if (memo !== null && memo.lo === lo && memo.hi === hi && memo.newest === range.newest) {
      this.camera.setPriceFrame(memo.rowBottom, memo.rowSpan);
      return true;
    }

    let rowLo = Infinity;
    let rowHi = -Infinity;
    const scale = this.axis.overlayPriceMap()?.scale;
    // Hybrid FIT is driven by actual visible bars, with a density-mid fallback.
    // It does not need a whole density-extent scan, or occupied depth when a
    // recorded bar already supplies the real price.
    if (scale !== undefined && scale.kind === 'hybrid') {
      const prices = this.host.overlays().priceRange(lo, hi);
      const mid = this.trackedRowN !== null && isColVisible(this.camera.toView(), this.frameState.newestSeq)
        ? scaleRowToPrice(scale, this.trackedRowN) : null;
      const visible = prices ?? (mid === null ? null : { low: mid, high: mid });
      if (visible === null) return false;
      const bounds = priceOverviewBounds(scale, visible);
      const low = scalePriceToRow(scale, bounds.low), high = scalePriceToRow(scale, bounds.high);
      this.camera.setPriceFrame(low, high - low);
      return true;
    }
    const extentLo = this.host.extentLo();
    const extentHi = this.host.extentHi();
    const extentSeq = this.host.extentSeq();
    for (let c = lo; c <= hi; c++) {
      const slot = ((c % cap) + cap) % cap;
      if (extentSeq[slot] !== c) continue; // stale slot (see extentSeq)
      let elo = extentLo[slot];
      if (elo < 0) continue;
      let ehi = extentHi[slot];
      // Resident history retains its native row IDs when the grid rolls.
      // Union the physical intervals in the camera's current geometry.
      if (scale && this.axis.rawColumnScale(c) !== scale) {
        const source = this.axis.rawColumnScale(c);
        if (!source) continue;
        const shift = source.kind === 'hybrid' ? .5 : 0;
        const low = scalePriceToRow(scale, scaleRowToPrice(source, elo - shift));
        const end = scalePriceToRow(scale, scaleRowToPrice(source, ehi + 1 - shift));
        if (!Number.isFinite(low) || !Number.isFinite(end)) continue;
        elo = low;
        ehi = Math.max(low, end - 1);
      }
      if (elo < rowLo) rowLo = elo;
      if (ehi > rowHi) rowHi = ehi;
    }
    if (rowHi < rowLo) return false; // wait for the first real book

    const frame = priceFrame(rowLo, rowHi, ring.rows, ROW_PAD_FRACTION, MIN_ROW_PAD, scale);
    this.priceFitMemo = { lo, hi, newest: range.newest, ...frame };
    this.camera.setPriceFrame(frame.rowBottom, frame.rowSpan);
    return true;
  }

  /** Zoom-out reaches a useful overview of the visible market, while the
   *  far depth remains accessible by panning. No price values are filtered. */
  preparePriceOverview(): void {
    const scale = this.axis.overlayPriceMap()?.scale;
    this.camera.priceScale = scale ?? null;
    this.camera.priceZoomBounds = null;
    if (scale?.kind !== 'hybrid') return;
    const view = this.camera.toView();
    const overview = this.host.activeOverview();
    const historyPrices = overview
      ? overview.bars.price.priceRange(Math.floor(view.colOffset / overview.stride), Math.ceil((view.colOffset + view.colScale) / overview.stride))
      : this.host.overlays().priceRange(Math.floor(view.colOffset), Math.ceil(view.colOffset + view.colScale));
    // Only use the current inside market when the live edge is on screen.
    // A historical empty window must not jump to today's price.
    const mid = this.trackedRowN !== null && isColVisible(view, this.frameState.newestSeq)
      ? scaleRowToPrice(scale, this.trackedRowN) : null;
    const prices = historyPrices ?? (mid === null ? null : { low: mid, high: mid });
    if (prices === null) return;
    this.camera.priceZoomBounds = priceOverviewBounds(scale, prices);
  }

  fitPriceOverview(): void {
    const ring = this.host.ring();
    if (ring !== null && this.frameState.view.colScale > ring.capacityCols && !this.host.overviewComplete()) this.pendingOverviewFit = true;
    this.preparePriceOverview();
    const bounds = this.camera.priceZoomBounds;
    const scale = this.camera.priceScale;
    if (bounds === null || scale === null) return;
    const low = scalePriceToRow(scale, bounds.low);
    const high = scalePriceToRow(scale, bounds.high);
    this.camera.setPriceFrame(low, high - low);
    this.onCameraChanged();
  }

  /**
   * Price auto-follow, `'track'` mode: keep the user's `rowSpan` and ease
   * `rowCenter` just enough to recover the price when it leaves the viewport
   * (gl/follow.ts). Called once per frame.
   *
   * Gated on the live edge being VISIBLE: when the user has scrolled back into
   * history, "now"'s price has nothing to do with the columns on screen, and
   * tracking it would drag the price window off the region being read and fight
   * the history backfill. Price simply freezes there and resumes on return.
   *
   * The target follows the current price throughout the glide. Price and time
   * changes are composed before one view notification, so observers never see
   * an intermediate horizontal jump while the vertical camera is moving.
   */
  stepPriceFollow(ts: number): void {
    const prevTs = this.priceStepTs;
    this.priceStepTs = ts;
    // A scripted perf run owns the camera; never contend with it.
    if (this.host.perfRunning()) return;
    if (this.camera.followPrice !== 'track') return;
    if (this.frameState.newestSeq < 0) return;
    // LOGICAL frame (camera), not the eased draw view — the glide's sub-column
    // trail must never read as "scrolled back" and freeze the price glide.
    if (!isColVisible(this.camera.toView(), this.frameState.newestSeq)) return;

    const st = this.camera.state;
    const tau = glideTauMs(this.prefersReducedMotion());
    // Track the price line the user sees. The time-weighted book can still
    // contain old touch levels, and its midpoint is not the last traded price.
    const price = this.host.overlays().lastPrice();
    const map = price !== null ? this.axis.overlayPriceMap() : null;
    const liveRow = map !== null && price !== null
      ? priceToPlotRow(mapScale(map), price)
      : this.trackedRowN;
    if (liveRow === null || !Number.isFinite(liveRow)) return;
    if (map?.scale?.kind === 'hybrid') {
      const scale = map.scale;
      const view = this.camera.toView();
      const low = scaleRowToPrice(scale, view.rowOffset);
      const high = scaleRowToPrice(scale, view.rowOffset + view.rowScale);
      const span = high - low;
      const current = (low + high) / 2;
      const live = scaleRowToPrice(scale, liveRow);
      this.priceTarget = priceFollowTarget(current, span, live, this.priceTarget !== null);
      if (this.priceTarget === null) return;
      const next = approach(current, this.priceTarget, prevTs > 0 ? ts - prevTs : PRICE_GLIDE_TAU_MS, tau);
      const center = Math.abs(this.priceTarget - current) < span / Math.max(1, this.host.cssHeight()) ? this.priceTarget : next;
      const bottom = scalePriceToRow(scale, Math.max(2 ** -126, center - span / 2));
      const top = scalePriceToRow(scale, center + span / 2);
      this.camera.remapPrice((bottom + top) / 2, top - bottom);
      if (center === this.priceTarget) this.priceTarget = null;
      this.frameState.dirty = true;
      return;
    }
    this.priceTarget = priceFollowTarget(
      st.rowCenter, st.rowSpan, liveRow, this.priceTarget !== null,
    );
    if (this.priceTarget === null) return;

    const target = this.priceTarget;
    const dt = prevTs > 0 ? ts - prevTs : PRICE_GLIDE_TAU_MS;
    const next = approach(st.rowCenter, target, dt, tau);
    const subPixel = st.rowSpan / Math.max(1, this.host.cssHeight());

    if (tau <= 0 || Math.abs(target - st.rowCenter) <= Math.min(PRICE_SNAP_ROWS, subPixel)) {
      // Settled: land exactly and disarm until price drifts out again.
      this.camera.setRowCenter(target);
      this.priceTarget = null;
      this.frameState.dirty = true;
      return;
    }
    this.camera.setRowCenter(next);
    this.frameState.dirty = true;
    // Time glide composes BOTH axes and notifies once later in this frame.
  }

  /** The OS asks for reduced motion (WCAG 2.3.3): glides snap instead of easing. */
  prefersReducedMotion(): boolean {
    return this.motionQuery?.matches === true;
  }

  /**
   * The eased live-edge scroll (gl/follow.ts `stepLiveEdgeLag`). Called once per
   * frame, before the draw: the drawn `frameState.view` trails the logical follow
   * frame by `liveLag` columns, which grows by the number of columns that
   * arrived since the previous frame and is consumed at the epoch's
   * column rate — so the chart scrolls at a constant one column per
   * interval instead of jumping once per column.
   */
  stepLiveEdgeGlide(ts: number): void {
    const before = this.frameState.view;
    this.applyLiveEdgeGlide(ts);
    if (
      before.colOffset !== this.frameState.view.colOffset ||
      before.colScale !== this.frameState.view.colScale ||
      before.rowOffset !== this.frameState.view.rowOffset ||
      before.rowScale !== this.frameState.view.rowScale
    ) {
      // The seam DOM consumers (the timeline minimap) ride so they track the
      // glide per frame instead of polling in visible steps.
      this.host.notifyViewChanged();
    }
  }

  /**
   * Whether the follow frame is in SCROLL mode: the visible span is fully
   * covered by resident columns, so the frame is right-edge-pinned and every
   * arrival must be absorbed into the eased lag. During the fill phase
   * (resident count < visible span) the frame is LEFT-anchored — it stretches
   * instead of scrolling — and a lag offset there would shift the whole map
   * against an anchored left edge, jumping when the scroll mode engages.
   */
  liveGlideActive(): boolean {
    const range = this.host.ring()?.residentRange() ?? null;
    if (range === null) return false;
    return this.camera.state.colSpan < this.frameState.newestSeq + 1 - 0.05;
  }

  private applyLiveEdgeGlide(ts: number): void {
    const dtMs =
      this.glideLastTs > 0 ? Math.min(Math.max(ts - this.glideLastTs, 0), 250) : 0;
    this.glideLastTs = ts;

    const following = this.camera.followTime && this.liveGlideActive();
    // Start with a spare interval: consuming the only available column leaves
    // the camera motionless whenever the next packet is slightly late.
    if (following && !this.glideWasFollowing) this.liveLag = TIME_GLIDE_STEADY_LAG;
    this.glideWasFollowing = following;

    const arrivals =
      this.lagBaseSeq >= 0 && this.frameState.newestSeq > this.lagBaseSeq
        ? Math.min(this.frameState.newestSeq - this.lagBaseSeq, 8)
        : 0;
    this.lagBaseSeq = this.frameState.newestSeq;
    if (this.host.perfRunning()) return; // after lagBaseSeq sync: keeps arrivals honest

    // The time axis advances at the grid's duration, not network delivery
    // speed. A late packet followed by catch-up must not accelerate the
    // camera and empty its reserve on a repeating delivery-jitter cycle.
    const reduced = this.prefersReducedMotion();
    const wasLag = this.liveLag;
    this.liveLag = advanceLiveEdgeLag(this.liveLag, {
      following,
      arrivals,
      dtMs,
      intervalMs: following ? this.axis.currentDtNs() / 1e6 : 0,
      reduced,
    });
    // Reduced motion: no eased lag; the view lands on the live edge at once.
    if (reduced && wasLag !== 0) this.frameState.dirty = true;

    if (this.liveLag <= TIME_GLIDE_SETTLE_EPS) {
      if (this.liveLag !== 0) {
        // Converged: land exactly on the logical frame and stop re-dirtying.
        this.liveLag = 0;
        this.frameState.dirty = true;
      }
      this.frameState.view = this.camera.toView();
      return;
    }
    const logical = this.camera.toView();
    this.frameState.view = { ...logical, colOffset: logical.colOffset - this.liveLag };
    this.frameState.dirty = true;
  }

  /** Turn TIME follow on/off (`Space` in live mode, `F`, the transport pill). */
  setFollowTime(on: boolean): void {
    this.wantFollowTime = on;
    this.camera.setFollowTime(on);
    if (!on) this.releaseLiveGlide();
    // Releasing time promotes a fitted price axis to 'track' (camera.applyKill),
    // so remember whatever the camera settled on.
    this.wantPriceFollow = this.camera.followPrice;
    if (on) this.updateView();
    this.frameState.view = this.camera.toView();
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
  }

  /** Set the PRICE follow mode (`P`, the axis chip, a gutter double-click). */
  setPriceFollow(mode: PriceFollow): void {
    const ring = this.host.ring();
    this.pendingOverviewFit = mode === 'fit' && ring !== null && this.frameState.view.colScale > ring.capacityCols;
    this.wantPriceFollow = mode;
    this.camera.setPriceFollow(mode);
    this.priceTarget = null;
    this.priceFitMemo = null;
    this.updateView();
    this.frameState.view = this.camera.toView();
    this.frameState.dirty = true;
  }

  /** A user gesture changed the camera: recompute uniforms, request a redraw. */
  onCameraChanged(): void {
    if (!this.camera.followTime) this.releaseLiveGlide();
    this.frameState.view = this.camera.toView();
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
    this.host.notifyViewChanged();
  }

  /** Manual history navigation owns the exact frame; discard the live trail. */
  releaseLiveGlide(): void {
    this.liveLag = 0;
    this.lagBaseSeq = this.frameState.newestSeq;
    this.glideWasFollowing = false;
  }

  /**
   * Re-pin TIME to the live edge; the price axis (zoom + follow mode) is kept
   * exactly as the user left it (the `R` / Go-Live control).
   */
  goLive(): void {
    // TIME axis only: snap the right edge to the newest column and re-arm
    // follow. The user's PRICE zoom (rowSpan) and price-follow mode
    // ('track'/'off'/'fit') are PRESERVED — re-arming Go Live must never
    // re-frame the book out from under the user's chosen scale. (This used
    // to call camera.reset(), which re-fitted rowSpan to the grid; see the
    // reset() docblock — Go Live now routes through follow() instead.)
    this.wantFollowTime = true;
    const range = this.host.ring()?.residentRange() ?? null;
    if (range !== null) this.camera.followEdge(range);
    else this.camera.setFollowTime(true);
    // Leaving scroll-back: allow live appends to re-anchor the ring at the
    // live edge and let the loader probe again on the next pan.
    this.host.resetHistory();
    this.priceTarget = null;
    this.priceFitMemo = null;
    this.updateView();
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
  }

  /** Choose a real time duration without changing the user's follow policy. */
  setTimeWindowMs(durationMs: number | null): boolean {
    const range = this.host.ring()?.residentRange() ?? null;
    if (!range || (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0))) return false;
    this.pendingOverviewFit = false;
    if (durationMs === null) {
      this.requestedTimeWindow = null;
      this.userTimeZoomed = true;
      this.camera.state = { ...this.camera.state, colCenter: (this.frameState.newestSeq + 1) / 2, colSpan: this.frameState.newestSeq + 1 };
      this.onCameraChanged();
      this.fitPriceOverview();
      return true;
    }
    const end = Math.min(this.frameState.newestSeq + 1, this.frameState.view.colOffset + this.frameState.view.colScale);
    const endNs = this.axis.timestampAtColumn(end);
    const oldestNs = this.axis.timestampAtColumn(0);
    if (endNs === null || oldestNs === null) return false;
    const wantedNs = endNs - BigInt(Math.round(durationMs * 1e6));
    const start = wantedNs <= oldestNs ? 0 : this.axis.columnAtTimestamp(wantedNs);
    if (start === null) return false;
    const wantedSpan = Math.max(1, Math.min(this.frameState.newestSeq + 1, end - start));
    this.requestedTimeWindow = durationMs;
    this.userTimeZoomed = true;
    const following = this.camera.followTime;
    this.camera.zoomTime(wantedSpan / this.camera.state.colSpan, end);
    this.camera.setTimeFrame(end - this.camera.state.colSpan, this.camera.state.colSpan);
    this.camera.state = { ...this.camera.state, followTime: following };
    this.onCameraChanged();
    return true;
  }

  /**
   * Re-assert the follow policy the user/settings asked for after a
   * `camera.reset()`. The ring is created lazily on the FIRST depth column —
   * always after App's mount effect has applied persisted settings — so without
   * this the reset silently reverts the user to {time on, price fit}.
   */
  applyWantedFollow(): void {
    this.camera.setFollowTime(this.wantFollowTime);
    this.camera.setPriceFollow(this.wantPriceFollow);
  }

  /**
   * Move the price axis into `epoch`'s row coordinates. No-op (and no epoch
   * advance) when either affine is unknown or the remap is not finite, so a
   * missing EpochParams can never write NaN into the camera.
   */
  remapPriceEpoch(epoch: number): void {
    const epochs = this.store.getState().epochs;
    const to = epochs.get(epoch);
    if (to === undefined) return;
    const toMap = this.axis.priceMapFor(to);

    const prev = this.priceEpoch;
    if (prev === null) {
      // Same-numbered session replacement — remap from the last map the
      // camera was actually painted under instead of silently reinterpreting.
      const forced = this.forcedRemapFrom;
      if (forced !== null) {
        const st = this.camera.state;
        const rowCenter = (remapRow(st.rowCenter - st.rowSpan / 2, forced, toMap) + remapRow(st.rowCenter + st.rowSpan / 2, forced, toMap)) / 2;
        const rowSpan = remapRowSpan(st.rowSpan, forced, toMap, st.rowCenter);
        if (Number.isFinite(rowCenter) && Number.isFinite(rowSpan) && rowSpan > 0) {
          this.camera.remapPrice(rowCenter, rowSpan);
        }
        this.forcedRemapFrom = null;
        this.priceTarget = null;
        this.priceFitMemo = null;
      }
      this.priceEpoch = epoch; // first epoch: nothing to remap from
      return;
    }
    const from = epochs.get(prev);
    if (from === undefined) return;
    const fromMap = this.axis.priceMapFor(from);

    const st = this.camera.state;
    const rowCenter = (remapRow(st.rowCenter - st.rowSpan / 2, fromMap, toMap) + remapRow(st.rowCenter + st.rowSpan / 2, fromMap, toMap)) / 2;
    // The span is measured AROUND the current centre: on a non-uniform grid the
    // same row count spans a different price distance depending on where it
    // sits, so a position-blind ratio would silently resize the user's zoom.
    const rowSpan = remapRowSpan(st.rowSpan, fromMap, toMap, st.rowCenter);
    if (!Number.isFinite(rowCenter) || !Number.isFinite(rowSpan) || rowSpan <= 0) return;
    this.camera.remapPrice(rowCenter, rowSpan);

    if (this.trackedRowN !== null) {
      // Only remap a row we know was derived in the epoch we are coming
      // from. A row with no recorded epoch (or one from an older transition)
      // cannot be reinterpreted — drop it and let the next live column
      // re-derive it, rather than silently writing a wrong row into the glide.
      if (this.trackedEpoch === null || this.trackedEpoch !== prev) {
        this.trackedRowN = null;
        this.trackedEpoch = null;
      } else {
        const tracked = remapRow(this.trackedRowN, fromMap, toMap);
        const rows = this.host.ring()?.rows ?? 0;
        // A remap that leaves the grid (e.g. a nominal-linear 102 price read
        // through a deep-band hybrid affine → row 2052 of 64) must be DROPPED,
        // not clamped: clamping parks the camera in a wing — the exact
        // reported incident (price axis 791-802 while the book was at 79,165).
        if (!Number.isFinite(tracked) || tracked < 0 || tracked > rows) {
          this.trackedRowN = null;
          this.trackedEpoch = null;
        } else {
          this.trackedRowN = tracked;
          this.trackedEpoch = epoch;
        }
      }
    } else {
      this.trackedEpoch = null;
    }
    this.priceTarget = null;
    this.priceFitMemo = null;
    this.priceEpoch = epoch;
  }

  /**
   * Record the live book's row for the price track. Only the LIVE edge writes
   * (the caller gates on col_seq); the row is kept only when the column's epoch
   * is the one the camera is expressed in.
   */
  noteLiveRow(bidTop: number, askBot: number, lo: number, hi: number, epoch: number): void {
    // The tracked row is only meaningful in the epoch it was derived in.
    // While the store has not delivered the new epoch's params, `priceEpoch`
    // still names the OLD affine; recording this book's row and remapping it
    // later "as old" is exactly the wing-corruption incident. Skip the write.
    if (this.priceEpoch === null || epoch === this.priceEpoch) {
      const tracked = trackedRow(bidTop, askBot, lo, hi);
      if (tracked !== null) {
        this.trackedRowN = tracked;
        this.trackedEpoch = epoch;
      }
    }
  }
}
