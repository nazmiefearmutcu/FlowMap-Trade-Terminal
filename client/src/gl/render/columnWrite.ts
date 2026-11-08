/**
 * The shared column write of the depth ingest: upload the texel column into the
 * ring, regenerate (or defer) its SUM-mip group, refresh the per-slot extent and
 * the time slots, feed the exact CPU cache, the histogram fold and the overlay
 * anchor, and re-bake the mips over a repaired gap. {@link DepthIngest} decides
 * WHAT to write (session gate, forward-gap repair, partial dedupe); this module
 * owns HOW a column lands in every GPU and CPU structure.
 */

import type { ColumnCache } from '../columnCache';
import { densityForScale } from '../columnGeometry';
import type { HistoryLoader } from '../../net/history';
import type { MipChain } from '../mips';
import type { PriceMap } from '../overlays/coords';
import { PartialDepthGate } from '../partialGate';
import { MIP_BATCH_MIN_COLS } from '../spliceMips';
import type { TileRing } from '../tileRing';
import type { ViewportNormalizer } from '../normalize';
import type { DepthColumn } from '../../proto/types';
import type { AxisMap } from './axisMap';
import type { FollowPolicy } from './followPolicy';
import type { FrameState, StateSource } from './frameState';
import type { GpuLifecycle } from './gpuLifecycle';
import type { OverlayLayer } from './overlayLayer';
import type { Shading } from './shading';

/** What the column write reads from its owner (the same host the depth ingest takes). */
export interface ColumnWriteHost {
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly gpu: GpuLifecycle;
  readonly axis: AxisMap;
  readonly follow: FollowPolicy;
  readonly shading: Shading;
  readonly overlayLayer: OverlayLayer;
  readonly columnCache: ColumnCache;
  /** Counts one texel-column upload for the stats readout. */
  countUpload(): void;
}

/** Whether two native price maps describe the same grid (the same affine and scale). */
export function sameNativePrice(a: PriceMap, b: PriceMap): boolean {
  return a === b || (a.p0 === b.p0 && a.step === b.step && a.tick === b.tick
    && JSON.stringify(a.scale) === JSON.stringify(b.scale));
}

export class ColumnWriter {
  // Created lazily on the first column, once the row count is known.
  private densityBid = new Float32Array(0);
  private densityAsk = new Float32Array(0);

  constructor(
    private readonly host: ColumnWriteHost,
    private readonly partialGate: PartialDepthGate,
  ) {}

  private get store(): StateSource { return this.host.store; }
  private get frameState(): FrameState { return this.host.frameState; }
  private get gpu(): GpuLifecycle { return this.host.gpu; }
  private get axis(): AxisMap { return this.host.axis; }
  private get follow(): FollowPolicy { return this.host.follow; }
  private get overlayLayer(): OverlayLayer { return this.host.overlayLayer; }
  private get columnCache(): ColumnCache { return this.host.columnCache; }
  private get normalizer(): ViewportNormalizer { return this.host.shading.normalizer; }
  private get mips(): MipChain | null { return this.host.gpu.mips; }
  private get ring(): TileRing | null { return this.host.gpu.ring; }
  private get history(): HistoryLoader | null { return this.host.gpu.history; }

  /**
   * The shared column write: upload the texel column, regenerate the affected
   * SUM-mip group (append-time, O(1) in history; a history splice DEFERS it to
   * a batched range pass — see {@link SpliceMipBatch.flush}), refresh the per-slot
   * non-zero extent, and record (col_seq → t0_ns) for the loader's before_t
   * mapping.
   */
  writeColumn(col: DepthColumn, rows: number, deferMips = false, gapZeroed = false): void {
    const ring = this.ring!;
    ring.append(col.col_seq, col.epoch, col.bid, col.ask, rows, gapZeroed);
    this.partialGate.note(col, ring);
    const nativeEpoch = this.store.getState().epochs.get(col.epoch);
    const cachedPrice = this.columnCache.timeAt(col.col_seq) === col.t0_ns
      && this.columnCache.epochAt(col.col_seq) === col.epoch ? this.columnCache.priceAt(col.col_seq) : null;
    const nativePrice = cachedPrice ?? (nativeEpoch ? this.axis.priceMapFor(nativeEpoch) : null);
    const nativeScale = nativePrice?.scale ?? null;
    if (nativeScale) ring.geometry.set(col.col_seq, nativeScale, col.epoch);
    this.host.countUpload();
    if (deferMips) this.gpu.spliceMips.defer(col.col_seq);
    else this.mips?.updateFrom(ring, col.col_seq);

    const cap = ring.capacityCols;
    const slot = ((col.col_seq % cap) + cap) % cap;
    const [lo, hi, bidTop, askBot] = columnExtent(col.bid, col.ask, rows);
    this.gpu.extents.write(slot, lo, hi, col.col_seq);
    // the true start time of this resident column, for the piecewise time
    // map (reconstructed history columns are 60 s apart despite a 250 ms epoch).
    this.axis.slots.write(slot, col.t0_ns);
    this.axis.slots.extendRun(col.col_seq);
    // Price auto-follow tracks the LIVE edge only: a backfilled history column
    // must never move the tracked row (renderer.ts spliceColumn shares this path).
    if (col.col_seq >= this.frameState.newestSeq) this.follow.noteLiveRow(bidTop, askBot, lo, hi, col.epoch);
    // The fit memo is keyed on the visible window; a new column inside it
    // invalidates the cached extent union.
    this.follow.priceFitMemo = null;

    // Feed the exact CPU cache (crosshair readout) and the per-tile
    // histogram (viewport normalization). The DepthColumn arrays are fresh,
    // immutable copies (decode.ts), so the cache holds references directly.
    this.columnCache.put(col.col_seq, col.bid, col.ask, col.t0_ns, col.epoch, nativePrice);
    // Only FINAL columns fold into the histogram: a forming edge column is
    // re-sent every flush and history pages overlap, so folding every write
    // inflated the histogram ~2×+ and biased the white point. foldColumnFinal
    // additionally dedupes by column id so an overlapping history re-splice
    // folds exactly once.
    if (col.final) {
      if (nativeScale?.kind === 'hybrid') {
        if (this.densityBid.length !== rows) { this.densityBid = new Float32Array(rows); this.densityAsk = new Float32Array(rows); }
        this.normalizer.foldColumnFinal(col.col_seq, densityForScale(nativeScale, col.bid, this.densityBid),
          col.ask ? densityForScale(nativeScale, col.ask, this.densityAsk) : null, nativeScale);
      } else this.normalizer.foldColumnFinal(col.col_seq, col.bid, col.ask, nativeScale);
    }

    this.history?.noteColumn(col.col_seq, col.t0_ns);

    // Overlays: remember an absolute (col_seq → t0_ns) anchor for the
    // ts_ns→column mapping (any resident column is a valid anchor within an
    // epoch), and keep the per-window VWAP map bounded to the resident range.
    this.axis.noteWritten(col);
    const r = ring.residentRange();
    if (r !== null) this.overlayLayer.pruneOverlayWindows(r.oldest, r.newest);
  }

  /**
   * Re-bake the SUM-mips over a zeroed gap band + the post-gap column. Without
   * this the coarse levels keep summing pre-zero stale group members (the
   * append's own `updateFrom` only covers the new column's group). Range pass
   * for a full band, per-column for a small one — same split as
   * {@link SpliceMipBatch.flush}.
   */
  bakeGapMips(from: number, to: number): void {
    const mips = this.mips;
    const ring = this.ring;
    if (mips === null || ring === null || from < 0) return;
    if (to - from + 1 >= MIP_BATCH_MIN_COLS) mips.updateRange(ring, from, to);
    else for (let s = from; s <= to; s++) mips.updateFrom(ring, s);
  }
}

/**
 * First and last row index carrying non-zero density (bid or ask). Returns
 * `[-1, -1]` when the column is entirely empty. Cheap linear scan — runs once
 * per appended column (≤ a few per second live).
 */
export function columnExtent(
  bid: Float32Array,
  ask: Float32Array | null,
  rows: number,
): [number, number, number, number] {
  let lo = -1;
  let hi = -1;
  let bidTop = -1;
  let askBot = -1;
  for (let r = 0; r < rows; r++) {
    const b = bid[r] > 0;
    const a = ask !== null && ask[r] > 0;
    if (b) bidTop = r; // last one wins → the highest bid row
    if (a && askBot < 0) askBot = r; // first one wins → the lowest ask row
    if (b || a) {
      if (lo < 0) lo = r;
      hi = r;
    }
  }
  return [lo, hi, bidTop, askBot];
}
