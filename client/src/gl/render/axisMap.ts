/**
 * Price/time coordinate maps of the live renderer: the epoch price maps, the
 * column⇄time anchor, the per-slot time table (piecewise column start times) and
 * the timeline() read model. Renderer keeps one-line delegates with the same names.
 */
import type { DepthColumn, EpochParams } from '../../proto/types';
import { scaleFromEpoch } from '../priceScale';
import {
  mapScale,
  slotColToTsNs,
  slotTsToCol,
  type PriceMap,
  type TimeMap,
  type TimeSlots,
} from '../overlays/coords';
import type { ColumnCache } from '../columnCache';
import type { OverviewSurface } from '../overviewSurface';
import type { ResidentRange, TileRing } from '../tileRing';
import type { FrameState, StateSource } from './frameState';

/** What the axis maps read from the renderer: the live ring, overview surface and column cache. */
export interface AxisMapHost {
  readonly store: StateSource;
  readonly frameState: FrameState;
  columnCache(): ColumnCache;
  ring(): TileRing | null;
  activeOverview(): OverviewSurface | null;
}

/**
 * Per-resident-ring-slot column start times: the piecewise column⇄time table the
 * overlays read. Written with the extent arrays and cleared with them on ring
 * rebuild/reset.
 */
export class SlotTimeTable {
  /**
   * per-resident-ring-slot column start time (float64 ns), written with
   * the extent arrays and cleared with them on ring rebuild/reset. NaN = the
   * slot has not been written for this ring. Needed because reconstructed
   * history columns are 60 s apart while the epoch says 250 ms, so the affine
   * TimeMap lies about time.
   */
  private t0: Float64Array | null = null;
  /**
   * the contiguous seq run currently covered by `t0` (inclusive),
   * tracked from the FIRST written column's seq — a warm attach starts
   * mid-sequence, so a slot-0 prefix would never reach the anchor and the whole
   * table stayed inert. Forward gaps restart the run at the newer column; a
   * splice landing exactly one below the start extends it downward; older
   * non-contiguous pages leave the run alone (they cannot affect anchor
   * coverage). Every knot handed to coords.ts's helpers is finite; the slot
   * table is only served when the run covers the anchor; wrapped runs use a
   * memoized dense table, refreshed once after column changes.
   */
  private runStart = -1;
  private runEnd = -2;
  private revision = 0;
  private memo: { source: Float64Array; from: number; to: number; revision: number; slots: TimeSlots } | null = null;

  /** Allocate an empty table for a ring of `cap` slots. */
  allocate(cap: number): void {
    this.t0 = new Float64Array(cap).fill(Number.NaN);
    this.dropRun();
  }

  /** Drop the table with its ring; the next allocate() re-creates it. */
  clear(): void {
    this.t0 = null;
  }

  /** Forget the contiguous run (a new session restarts seqs). */
  dropRun(): void {
    this.runStart = -1;
    this.runEnd = -2;
  }

  /** Record the start time of a written slot (no-op until allocated). */
  write(slot: number, t0Ns: bigint): void {
    if (this.t0 === null) return;
    this.t0[slot] = Number(t0Ns);
    this.revision++;
  }

  /**
   * Extend or restart the contiguous run with a written col_seq (no-op until
   * allocated). Track the contiguous run from its FIRST WRITTEN column,
   * not a slot-0 prefix — a warm attach starts mid-sequence and the table must
   * still serve the reconstructed tail. Forward gaps restart the run at the
   * newer column; an exactly-contiguous older page (splice backfill) extends it
   * downward; older non-contiguous pages leave it alone.
   */
  extendRun(s: number): void {
    if (this.t0 === null) return;
    if (this.runStart < 0) {
      this.runStart = s;
      this.runEnd = s;
    } else if (s === this.runEnd + 1) {
      this.runEnd = s;
    } else if (s === this.runStart - 1) {
      this.runStart = s;
    } else if (s > this.runEnd) {
      this.runStart = s;
      this.runEnd = s;
    }
  }

  /**
   * Expose actual timestamp knots for a contiguous fully-written resident run
   * covering the anchor. Wrapped runs are linearized once after column changes
   * and reused across animation frames. Warm-restart seams can remain anywhere
   * in the ring, so wrapping never licenses a nominal-dt fallback.
   *  - the run is the contiguous seq run tracked by extendRun, so a warm attach
   *    works; every knot handed to coords.ts's helpers is finite (slots outside
   *    the run are never included);
   *  - the anchor must lie inside, so the table and the affine fallback agree
   *    at the seed column.
   * Returns null for absent or incomplete tables; callers use the affine there.
   */
  overlaySlots(cap: number, range: ResidentRange, anchor: number): TimeSlots | null {
    const t0 = this.t0;
    if (t0 === null) return null;
    const from = Math.max(this.runStart, range.oldest);
    const to = Math.min(this.runEnd, range.newest);
    if (from < 0 || to < from) return null;
    if (anchor < from || anchor > to) return null;
    const fromSlot = ((from % cap) + cap) % cap;
    const len = to - from + 1;
    if (len < 2) return null; // coords.ts needs two knots
    if (fromSlot + len > cap) {
      // A warm-restart seam can exist anywhere in the ring. Linearize only
      // after columns change; every animation frame reuses the same table.
      const memo = this.memo;
      if (memo && memo.source === t0 && memo.from === from && memo.to === to && memo.revision === this.revision) return memo.slots;
      const dense = new Float64Array(len);
      const first = cap - fromSlot;
      dense.set(t0.subarray(fromSlot), 0);
      dense.set(t0.subarray(0, len - first), first);
      const slots = { t0: dense, startSeq: from };
      this.memo = { source: t0, from, to, revision: this.revision, slots };
      return slots;
    }
    return { t0: t0.subarray(fromSlot, fromSlot + len), startSeq: from };
  }
}

export class AxisMap {
  private readonly host: AxisMapHost;
  private readonly store: StateSource;
  private readonly frameState: FrameState;
  /** Per-resident-slot column start times (the piecewise table). */
  readonly slots = new SlotTimeTable();
  private readonly epochPriceMaps = new WeakMap<EpochParams, PriceMap>();
  /** The CPU column cache's exact arrays for one column (overlay profile input). */
  readonly rawColumnArrays = (col: number) => this.columnCache.arrays(col);
  /**
   * Native price scale of one column: its own cached geometry when it has one,
   * else the scale of the epoch it was written under.
   */
  readonly rawColumnScale = (col: number) => {
    const native = this.columnCache.priceAt(col);
    if (native) return mapScale(native);
    const epoch = this.columnCache.epochAt(col);
    const params = epoch === null ? undefined : this.store.getState().epochs.get(epoch);
    return params ? scaleFromEpoch(params) : null;
  };
  /** Column⇄time anchor for overlays: newest written column (any is valid). */
  overlayAnchorSeq = -1;
  overlayAnchorT0Ns = 0n;
  overlayAnchorEpoch = 0;
  /** Last PriceMap the camera was interpreted through (see overlayPriceMap). */
  lastPriceMapCache: PriceMap | null = null;

  constructor(host: AxisMapHost) {
    this.host = host;
    this.store = host.store;
    this.frameState = host.frameState;
  }

  private get columnCache(): ColumnCache { return this.host.columnCache(); }
  private activeOverview(): OverviewSurface | null { return this.host.activeOverview(); }
  private residentRange(): ResidentRange | null {
    const ring = this.host.ring();
    return ring ? ring.residentRange() : null;
  }

  /** Clear the column⇄time anchor (session reset). */
  clearAnchor(): void {
    this.overlayAnchorSeq = -1;
    this.overlayAnchorT0Ns = 0n;
    this.overlayAnchorEpoch = 0;
  }

  /** Anchor the overlays on a column that was just written. */
  noteWritten(col: DepthColumn): void {
    this.overlayAnchorSeq = col.col_seq;
    this.overlayAnchorT0Ns = col.t0_ns;
    this.overlayAnchorEpoch = col.epoch;
  }

  /**
   * Expose actual timestamp knots for the resident run covering the overlay
   * anchor, or null (see SlotTimeTable.overlaySlots).
   */
  overlaySlotsFor(): TimeSlots | null {
    const ring = this.host.ring();
    if (ring === null || this.overlayAnchorSeq < 0) return null;
    const range = ring.residentRange();
    if (range === null) return null;
    return this.slots.overlaySlots(ring.capacityCols, range, this.overlayAnchorSeq);
  }

  /**
   * Read-only timeline geometry for the minimap + replay seek: the
   * resident column extent, the current visible window in absolute columns, and
   * the column⇄time base (anchor + dt) so a scrubber fraction maps to a real ns.
   * Null before the first column. Cheap — the Timeline polls it at ≤4 Hz.
   */
  timeline(): {
    oldestSeq: number;
    newestSeq: number;
    viewStartCol: number;
    viewEndCol: number;
    /** The column⇄time map the chart draws with (slots included when present). */
    timeBase: TimeMap | null;
  } | null {
    const range = this.residentRange();
    if (range === null) return null;
    return {
      // The resident window's oldest column. A hard 0 pinned the Timeline
      // scrubber to the session origin, so the slider and minimap mapped the run wrongly.
      oldestSeq: range.oldest,
      newestSeq: Math.max(range.newest, this.frameState.newestSeq),
      viewStartCol: this.frameState.view.colOffset,
      viewEndCol: this.frameState.view.colOffset + this.frameState.view.colScale,
      timeBase: this.activeTimeMap(),
    };
  }

  activeTimeMap(): TimeMap | null {
    return this.activeOverview()?.originalTimeMap(this.currentDtNs()) ?? this.overlayTimeMap();
  }

  /** Current epoch's column interval (ns) for the loader's before_t fallback. */
  currentDtNs(): number {
    const st = this.store.getState();
    const ep = st.gridEpoch !== null ? st.epochs.get(st.gridEpoch) : undefined;
    return ep?.dt_ns ?? 250_000_000;
  }

  /** Row→price affine for the current grid epoch, or null before any epoch. */
  overlayPriceMap(): PriceMap | null {
    const st = this.store.getState();
    const ep = st.gridEpoch !== null ? st.epochs.get(st.gridEpoch) : undefined;
    if (ep === undefined) return null;
    const map = this.priceMapFor(ep);
    // Remember the map the camera is actually expressed in, so a
    // same-numbered session replacement can force a price-preserving remap.
    this.lastPriceMapCache = map;
    return map;
  }

  /**
   * The price map an epoch denotes. `p0`/`step` stay populated as the epoch's
   * representative (core) values so anything that only wants a nominal tick
   * size keeps working, but `scale` is the authority — every actual row/price
   * mapping goes through it, which is what makes a non-uniform grid correct.
   */
  priceMapFor(ep: EpochParams): PriceMap {
    const known = this.epochPriceMaps.get(ep);
    if (known) return known;
    const scale = Object.freeze(scaleFromEpoch(ep));
    const price = Object.freeze({
      p0: scale.kind === 'hybrid' ? scale.coreP0 : scale.p0,
      step: scale.kind === 'hybrid' ? scale.coreStep : scale.step,
      tick: ep.tick,
      scale,
    });
    this.epochPriceMaps.set(ep, price);
    return price;
  }

  /**
   * Column⇄time affine anchored on the newest written column, or null. When the
   * per-resident-slot t0 table densely covers the anchor it is attached as
   * `slots`: reconstructed history columns are 60 s apart while the epoch
   * claims 250 ms, so the piecewise table — not this affine — is the truth
   * there.
   */
  overlayTimeMap(): TimeMap | null {
    if (this.overlayAnchorSeq < 0) return null;
    const ep = this.store.getState().epochs.get(this.overlayAnchorEpoch);
    const dtNs = ep?.dt_ns ?? this.currentDtNs();
    const base: TimeMap = {
      anchorSeq: this.overlayAnchorSeq,
      anchorT0Ns: this.overlayAnchorT0Ns,
      dtNs,
    };
    const slots = this.overlaySlotsFor();
    return slots === null ? base : { ...base, slots: slots };
  }

  /**
   * test hook: the true start time (ns) of a (fractional) column, using the
   * piecewise slot table when it covers the column, else the affine map. e2e
   * verification of the reconstructed-history time warp.
   */
  timestampAtColumn(col: number): bigint | null {
    const time = this.activeTimeMap();
    if (time === null) return null;
    if (time.slots !== undefined) {
      const ts = slotColToTsNs(time.slots, col);
      if (ts !== null) return ts;
    }
    return time.anchorT0Ns + BigInt(Math.round((col - time.anchorSeq) * time.dtNs));
  }

  /**
   * test hook: the (fractional) column containing `tsNs`, piecewise when the
   * slot table covers it, else the affine inverse. e2e verification hook.
   */
  columnAtTimestamp(tsNs: bigint): number | null {
    const time = this.activeTimeMap();
    if (time === null) return null;
    if (time.slots !== undefined) {
      const col = slotTsToCol(time.slots, tsNs);
      if (col !== null) return col;
    }
    return time.anchorSeq + Number(tsNs - time.anchorT0Ns) / time.dtNs;
  }
}
