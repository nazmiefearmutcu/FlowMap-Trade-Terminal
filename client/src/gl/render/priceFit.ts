/**
 * Price frame policy of the follow module: the price auto-fit (the hybrid
 * visible-bar fit and the row-extent union over the visible window), the
 * zoomed-out overview bounds, and the remap of a user-owned price frame across
 * grid epochs. FollowPolicy keeps a delegate for every name the renderer and the
 * ingest reach; the cursors these methods read and write (priceFitMemo,
 * trackedRowN, priceEpoch, ...) stay public fields on the policy.
 */

import { priceFrame, type Camera } from '../camera';
import { isColVisible } from '../follow';
import { remapRow, remapRowSpan } from '../overlays/coords';
import { priceOverviewBounds } from '../priceOverview';
import { priceToRow as scalePriceToRow, rowToPrice as scaleRowToPrice } from '../priceScale';
import type { AxisMap } from './axisMap';
import type { FollowHost, FollowPolicy } from './followPolicy';
import type { FrameState } from './frameState';

const ROW_PAD_FRACTION = 0.08;
const MIN_ROW_PAD = 3;

export class PriceFit {
  private readonly policy: FollowPolicy;
  private readonly host: FollowHost;
  private readonly camera: Camera;
  private readonly frameState: FrameState;
  private readonly axis: AxisMap;
  private readonly store: FollowHost['store'];

  constructor(policy: FollowPolicy, host: FollowHost) {
    this.policy = policy;
    this.host = host;
    this.camera = host.camera;
    this.frameState = host.frameState;
    this.axis = host.axis;
    this.store = host.store;
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
  apply(): boolean {
    const ring = this.host.ring();
    if (ring === null) return false;
    if (this.frameState.view.colScale > ring.capacityCols) {
      this.prepareOverview();
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

    const memo = this.policy.priceFitMemo;
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
      const mid = this.policy.trackedRowN !== null && isColVisible(this.camera.toView(), this.frameState.newestSeq)
        ? scaleRowToPrice(scale, this.policy.trackedRowN) : null;
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
    this.policy.priceFitMemo = { lo, hi, newest: range.newest, ...frame };
    this.camera.setPriceFrame(frame.rowBottom, frame.rowSpan);
    return true;
  }

  /** Zoom-out reaches a useful overview of the visible market, while the
   *  far depth remains accessible by panning. No price values are filtered. */
  prepareOverview(): void {
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
    const mid = this.policy.trackedRowN !== null && isColVisible(view, this.frameState.newestSeq)
      ? scaleRowToPrice(scale, this.policy.trackedRowN) : null;
    const prices = historyPrices ?? (mid === null ? null : { low: mid, high: mid });
    if (prices === null) return;
    this.camera.priceZoomBounds = priceOverviewBounds(scale, prices);
  }

  fitOverview(): void {
    const ring = this.host.ring();
    if (ring !== null && this.frameState.view.colScale > ring.capacityCols && !this.host.overviewComplete()) this.policy.pendingOverviewFit = true;
    this.prepareOverview();
    const bounds = this.camera.priceZoomBounds;
    const scale = this.camera.priceScale;
    if (bounds === null || scale === null) return;
    const low = scalePriceToRow(scale, bounds.low);
    const high = scalePriceToRow(scale, bounds.high);
    this.camera.setPriceFrame(low, high - low);
    this.policy.onCameraChanged();
  }

  /**
   * Move the price axis into `epoch`'s row coordinates. No-op (and no epoch
   * advance) when either affine is unknown or the remap is not finite, so a
   * missing EpochParams can never write NaN into the camera.
   */
  remapEpoch(epoch: number): void {
    const epochs = this.store.getState().epochs;
    const to = epochs.get(epoch);
    if (to === undefined) return;
    const toMap = this.axis.priceMapFor(to);

    const prev = this.policy.priceEpoch;
    if (prev === null) {
      // Same-numbered session replacement — remap from the last map the
      // camera was actually painted under instead of silently reinterpreting.
      const forced = this.policy.forcedRemapFrom;
      if (forced !== null) {
        const st = this.camera.state;
        const rowCenter = (remapRow(st.rowCenter - st.rowSpan / 2, forced, toMap) + remapRow(st.rowCenter + st.rowSpan / 2, forced, toMap)) / 2;
        const rowSpan = remapRowSpan(st.rowSpan, forced, toMap, st.rowCenter);
        if (Number.isFinite(rowCenter) && Number.isFinite(rowSpan) && rowSpan > 0) {
          this.camera.remapPrice(rowCenter, rowSpan);
        }
        this.policy.forcedRemapFrom = null;
        this.policy.priceTarget = null;
        this.policy.priceFitMemo = null;
      }
      this.policy.priceEpoch = epoch; // first epoch: nothing to remap from
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

    if (this.policy.trackedRowN !== null) {
      // Only remap a row we know was derived in the epoch we are coming
      // from. A row with no recorded epoch (or one from an older transition)
      // cannot be reinterpreted — drop it and let the next live column
      // re-derive it, rather than silently writing a wrong row into the glide.
      if (this.policy.trackedEpoch === null || this.policy.trackedEpoch !== prev) {
        this.policy.trackedRowN = null;
        this.policy.trackedEpoch = null;
      } else {
        const tracked = remapRow(this.policy.trackedRowN, fromMap, toMap);
        const rows = this.host.ring()?.rows ?? 0;
        // A remap that leaves the grid (e.g. a nominal-linear 102 price read
        // through a deep-band hybrid affine → row 2052 of 64) must be DROPPED,
        // not clamped: clamping parks the camera in a wing — the exact
        // reported incident (price axis 791-802 while the book was at 79,165).
        if (!Number.isFinite(tracked) || tracked < 0 || tracked > rows) {
          this.policy.trackedRowN = null;
          this.policy.trackedEpoch = null;
        } else {
          this.policy.trackedRowN = tracked;
          this.policy.trackedEpoch = epoch;
        }
      }
    } else {
      this.policy.trackedEpoch = null;
    }
    this.policy.priceTarget = null;
    this.policy.priceFitMemo = null;
    this.policy.priceEpoch = epoch;
  }
}
