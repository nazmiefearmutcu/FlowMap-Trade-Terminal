/**
 * Stream dispatch and depth-column ingest.
 *
 * The renderer's store subscription lands in {@link DepthIngest.onMessage}:
 * depth columns pass the session gate and the forward-gap repair, then reach
 * {@link DepthIngest.writeColumn}, the one shared column write (ring, extents,
 * mips, exact CPU cache, histogram fold, overlay anchor). Bar, trade, BBO,
 * marker and GEX messages feed the overlay layer. The session resets rewind the
 * cursors when the subscription changes: the GL teardown runs through the GPU
 * lifecycle, the ramp and normaliser resets through the shading and the overlay
 * resets through the overlay layer.
 */

import { limitsFor, type Camera } from '../camera';
import type { ColumnCache } from '../columnCache';
import type { BenchmarkMetrics } from '../benchmarkMetrics';
import { densityForScale } from '../columnGeometry';
import type { GLContext } from '../context';
import type { HistoryLoader } from '../../net/history';
import type { StreamMsg } from '../../net/connection';
import { renderProgramsReady } from '../heatmapProgram';
import { isRepeatBar } from '../barGate';
import type { MipChain } from '../mips';
import type { PriceMap } from '../overlays/coords';
import type { OverlayManager } from '../overlays/manager';
import { PartialDepthGate } from '../partialGate';
import { MIP_BATCH_MIN_COLS } from '../spliceMips';
import { planDepthColumn, sessionGateOpen } from '../sessionGate';
import type { TileRing } from '../tileRing';
import type { ViewportNormalizer } from '../normalize';
import { MsgType, type BarColumn, type DepthColumn } from '../../proto/types';
import type { AxisMap } from './axisMap';
import type { FollowPolicy } from './followPolicy';
import type { FrameState, StateSource } from './frameState';
import type { GpuLifecycle } from './gpuLifecycle';
import type { OverlayLayer } from './overlayLayer';
import type { Shading } from './shading';

/**
 * What the depth ingest needs from its owner. The collaborators are the live
 * module instances, each built before {@link DepthIngest}; the three members at
 * the end reach Renderer-owned state that is not in a module yet.
 */
export interface IngestHost {
  readonly store: StateSource;
  readonly frameState: FrameState;
  readonly gpu: GpuLifecycle;
  readonly axis: AxisMap;
  readonly follow: FollowPolicy;
  readonly shading: Shading;
  readonly overlayLayer: OverlayLayer;
  readonly camera: Camera;
  readonly columnCache: ColumnCache;
  readonly benchmark: BenchmarkMetrics | null;
  /** The configured ring capacity target; the session reset re-derives the camera limits from it. */
  readonly capacityColsTarget: number;
  /** Re-derives the view uniforms through the Renderer (a spy target in the replay price test). */
  updateView(): void;
  /** The frame loop forgets the session it presented. */
  forgetPresentedSession(): void;
  /** Counts one texel-column upload for the stats readout. */
  countUpload(): void;
}

/** Floor on the normalization divisor so a tiny norm_seed can't blow out intensity. */
const NORM_FLOOR = 6;

/**
 * Largest forward col_seq skip (in columns) the renderer repairs by ZEROING the
 * skipped band instead of letting {@link Residency} gate every older column to
 * background (the "heatmap bir anda yok oluyor" blackout: ONE server tx_lag
 * drop — LAG_DROP_NS=2 s of backlog — would blank up to the full 16 k ring for
 * minutes). At 4–20 cols/s a 512-column band is ~30–120 s of dropped stream —
 * past that the conservative gate is both cheaper and more honest. The band
 * costs one `texSubImage3D` + a mip re-bake per column, a rare one-off.
 */
const GAP_ZERO_MAX_COLS = 512;

function sameNativePrice(a: PriceMap, b: PriceMap): boolean {
  return a === b || (a.p0 === b.p0 && a.step === b.step && a.tick === b.tick
    && JSON.stringify(a.scale) === JSON.stringify(b.scale));
}

export class DepthIngest {
  private readonly host: IngestHost;
  private readonly store: StateSource;
  private readonly frameState: FrameState;
  private readonly gpu: GpuLifecycle;
  private readonly axis: AxisMap;
  private readonly follow: FollowPolicy;
  private readonly shading: Shading;
  private readonly overlayLayer: OverlayLayer;
  private readonly camera: Camera;
  private readonly columnCache: ColumnCache;
  private readonly benchmark: BenchmarkMetrics | null;
  private readonly capacityColsTarget: number;

  // Created lazily on the first column, once the row count is known.
  private densityBid = new Float32Array(0);
  private densityAsk = new Float32Array(0);
  /** Columns staged while the GL side is not ready; the frame loop drains them. */
  readonly pendingDepth: DepthColumn[] = [];
  /** True while the frame loop drains {@link pendingDepth}. */
  drainingDepth = false;

  private streamIngestWarned = false;
  /** norm_seed applied once, the first time the server sends it. */
  normSeeded = false;
  /**
   * Per-session column gate (gl/sessionGate.ts). True from `resetForSession()`
   * until the NEW session identifies itself — the window in which the OLD
   * session's still-in-flight columns would otherwise size the ring to the
   * previous symbol's row count. See sessionGate.ts for why this cannot latch.
   */
  awaitingSession = false;
  /** `sessionId` as of the last `resetForSession()`; the gate opens off this. */
  private gateSessionId: string | null = null;
  /** One-shot guard so a burst of gated columns warns at most once per switch. */
  private gateWarned = false;

  /**
   * `sessionId` of the last accepted column. A server-side session
   * replacement for the same subscription restarts col_seq from a lower value;
   * the first column of the new session names a different id. Null until the
   * first column.
   */
  lastSessionId: string | null = null;
  /** Prior timeline survives the cursor reset until the new run identifies
   * whether its first column continues history or reuses an incompatible id. */
  private pendingSessionTimeline: { newestSeq: number; newestT0Ns: bigint } | null = null;

  /** Skips byte-identical re-sends of the forming column (see partialGate.ts). */
  readonly partialGate = new PartialDepthGate();
  /** The last bar column forwarded to the overlays; an identical repeat is dropped (see barGate.ts). */
  private lastBar: BarColumn | null = null;

  constructor(host: IngestHost) {
    this.host = host;
    this.store = host.store;
    this.frameState = host.frameState;
    this.gpu = host.gpu;
    this.axis = host.axis;
    this.follow = host.follow;
    this.shading = host.shading;
    this.overlayLayer = host.overlayLayer;
    this.camera = host.camera;
    this.columnCache = host.columnCache;
    this.benchmark = host.benchmark;
    this.capacityColsTarget = host.capacityColsTarget;
  }

  /** The live GL context; a restore replaces it, so it is read at use time. */
  private get ctx(): GLContext {
    return this.gpu.ctx;
  }

  /** The depth ring, or null before the first column. */
  private get ring(): TileRing | null {
    return this.gpu.ring;
  }

  /** The SUM-mip chain, or null when float FBOs are absent. */
  private get mips(): MipChain | null {
    return this.gpu.mips;
  }

  /** The deep scroll-back loader, or null before the ring exists. */
  private get history(): HistoryLoader | null {
    return this.gpu.history;
  }

  /** The viewport normalizer, owned by the shading (the GL objects share it). */
  private get normalizer(): ViewportNormalizer {
    return this.shading.normalizer;
  }

  /** The overlay manager; read at call time so tests can swap its methods. */
  private get overlays(): OverlayManager {
    return this.overlayLayer.overlays;
  }

  /** True while the GL context is lost, including the window before `webglcontextlost` fires. */
  private glLost(): boolean {
    return this.gpu.glLost();
  }

  private benchmarkDiscard(col: DepthColumn, reason: string): void {
    this.benchmark?.count(`${col.final ? 'finalizedDiscarded' : 'partialDiscarded'}:${reason}`);
  }

  onMessage = (msg: StreamMsg): void => {
    this.benchmark?.count(`received:${msg.type}`);
    if (msg.type === MsgType.DEPTH_COL) {
      this.benchmark?.arrived(msg);
      this.benchmark?.count(msg.final ? 'finalizedReceived' : 'partialReceived');
    }
    // The store's fanout invokes every listener with no isolation, so a throw
    // here would break WS dispatch for the whole app. Everything below is
    // guarded: a single malformed message is warned once and dropped while the
    // renderer (and the stream) continue (lifecycle).
    try {
      if (msg.type === MsgType.DEPTH_COL) {
        this.onDepthColumn(msg);
        return;
      }
      // Overlays: feed the overlay manager; a redraw is scheduled so the
      // sprites/lines/glyphs update in lock-step with the heatmap. Cheap — the
      // manager only stores into bounded rings/maps here (O(1)); drawing is
      // O(visible) on the next dirty frame.
      switch (msg.type) {
        case MsgType.BOOK_UPDATE:
          if (this.store.getState().capability?.depth_provenance !== 'recorded-density') return;
          this.overlays.onRecordedBook(msg);
          break;
        case MsgType.TRADE:
          this.overlays.onTrade(msg);
          break;
        case MsgType.BBO:
          this.overlays.onBbo(msg, this.store.getState().capability?.depth_provenance === 'recorded-density');
          break;
        case MsgType.BAR_COL:
          // The forming bar is re-sent on every flush tick. An identical repeat
          // changes no overlay state, so it is dropped before any redraw.
          if (isRepeatBar(this.lastBar, msg)) return;
          this.lastBar = msg;
          this.overlays.onBar(msg);
          // Snapshot pairs are depth→bar. Coalesce their price input changes
          // for the next presentation, including a paused final/only column.
          if (Number.isFinite(msg.c) && msg.c > 0) this.follow.barPriceFitPending = true;
          break;
        case MsgType.MARKER:
          this.overlays.onMarker(msg);
          break;
        case MsgType.GEX_UPDATE:
          this.overlays.onGex(msg);
          break;
        default:
          return;
      }
      this.frameState.dirty = true;
    } catch (err) {
      this.benchmark?.count('streamIngestErrors');
      if (!this.streamIngestWarned) {
        this.streamIngestWarned = true;
        console.warn('[flowmap] stream ingest error (suppressed; stream continues):', err);
      }
    }
  };

  onDepthColumn(col: DepthColumn): void {
    // A lost context has no valid textures; drop until restore re-fetches.
    if (this.glLost()) {
      this.benchmarkDiscard(col, 'contextLost');
      return;
    }


    const state = this.store.getState();
    const epochRows = state.epochs.get(col.epoch)?.rows;

    // Session gate (gl/sessionGate.ts): after resetForSession() the OLD session's
    // columns are still arriving, and the store's epoch table is empty, so their
    // bid.length would size the new ring to the PREVIOUS symbol's geometry. Hold
    // them until the new session identifies itself — by its Hello, or by simply
    // being able to size this column's epoch authoritatively.
    if (this.awaitingSession && sessionGateOpen(this.gateSessionId, state.sessionId, epochRows)) {
      this.awaitingSession = false;
    }

    const plan = planDepthColumn({
      awaitingSession: this.awaitingSession,
      epochRows,
      colRows: col.bid.length,
      ringRows: this.ring?.rows ?? null,
    });

    if (plan.action === 'drop') {
      this.benchmarkDiscard(col, plan.reason);
      if (plan.reason === 'row-mismatch') {
        console.warn(
          `[flowmap] depth column bid ${col.bid.length} ≠ its epoch's rows ${epochRows}; skipping`,
        );
      } else if (!this.gateWarned) {
        this.gateWarned = true;
        console.warn(
          '[flowmap] dropping pre-Hello depth column(s) from the previous session (suppressed after the first)',
        );
      }
      return;
    }
    if (!this.drainingDepth && (!renderProgramsReady(this.ctx.gl, this.ctx.caps.colorBufferFloat) || this.pendingDepth.length > 0)) {
      const last = this.pendingDepth.at(-1);
      if (last && !last.final && last.epoch === col.epoch && last.col_seq === col.col_seq) {
        this.benchmark?.count('partialReplaced');
        this.pendingDepth[this.pendingDepth.length - 1] = col;
      } else {
        this.pendingDepth.push(col);
        // Bound cold-start staging to the same resident history budget.
        if (this.pendingDepth.length > this.capacityColsTarget) {
          this.benchmarkDiscard(this.pendingDepth.shift()!, 'queueOverflow');
        }
      }
      return;
    }

    if (plan.action === 'create') this.gpu.createRing(plan.rows);
    // A genuine grid-geometry change (crypto 2048 → equity 4096, or the `deep`
    // band's 4096). REBUILD rather than skip: the old code warned and returned,
    // leaving a ring nothing would ever resize — a blank heatmap for good.
    else if (plan.action === 'rebuild') this.gpu.recreateRingForRows(plan.rows);

    const rows = plan.rows;

    // The store's session identity changed under this subscription — a
    // server-side session replacement (parked-session grace expiry / restart).
    // Its columns reuse col_seq values the OLD session already consumed, so the
    // overlay data, anchors and follow cursors must be rewound before they are
    // accepted; the ring itself survives.
    if (this.lastSessionId !== null && state.sessionId !== this.lastSessionId) {
      this.resetOverlaysForNewSession();
    }
    this.lastSessionId = state.sessionId;

    const previousTimeline = this.pendingSessionTimeline;
    if (previousTimeline !== null) {
      this.pendingSessionTimeline = null;
      const cachedTime = this.columnCache.timeAt(col.col_seq);
      const cachedPrice = this.columnCache.priceAt(col.col_seq);
      const params = state.epochs.get(col.epoch);
      const incomingPrice = params ? this.axis.priceMapFor(params) : null;
      const range = this.ring!.residentRange();
      const reusedSequence = col.col_seq <= previousTimeline.newestSeq;
      const changedIdentity = cachedTime !== null
        ? cachedTime !== col.t0_ns || (cachedPrice !== null && incomingPrice !== null
          && !sameNativePrice(cachedPrice, incomingPrice))
        : range !== null && col.col_seq < range.oldest;
      if (reusedSequence && changedIdentity) {
        // A fresh run owns these sequence ids. Keep disk recordings intact,
        // but clear active membership before its first finalized column folds.
        this.gpu.recreateRingForRows(rows);
        this.normSeeded = false;
        this.follow.initialPriceFramed = false;
      }
    }
    let ring = this.ring!;

    // col_seq regression — a column more than a whole ring behind the
    // high-water mark cannot be a re-send or a history splice (neither comes
    // through this path); it is a restarted sequence. `newestSeq` is max-only,
    // so without this the live edge stays un-visible forever and TRACK is dead.
    if (this.frameState.newestSeq >= 0 && col.col_seq + ring.capacityCols < this.frameState.newestSeq) {
      this.resetOverlaysForNewSession();
      this.pendingSessionTimeline = null;
      this.gpu.recreateRingForRows(rows);
      this.normSeeded = false;
      this.follow.initialPriceFramed = false;
      ring = this.ring!;
    }

    if (col.col_seq >= this.frameState.newestSeq) {
      this.frameState.newestSeq = col.col_seq;
      this.frameState.newestT0Ns = col.t0_ns;
    }
    const range = ring.residentRange();
    // Omitted live columns still extend navigable history. Refresh this before
    // an epoch remap clamps the camera, so a price change cannot pull a manual
    // time window back to the last column uploaded into the resident ring.
    this.camera.setTimeWindow({ floor: 0, newest: this.frameState.newestSeq, resident: range });

    // Epoch change: the server moved p0, so a USER-OWNED price window (track /
    // off) is now pointing at different prices. Remap the camera + tracked row
    // through the two affines. `priceEpoch` only advances when the remap
    // actually succeeded — the store may not hold the new epoch's params yet
    // (onDepthColumn already tolerates that ordering above), and advancing
    // regardless would strand a locked window on the old p0 forever.
    if (this.follow.priceEpoch !== col.epoch) {
      this.follow.remapPriceEpoch(col.epoch);
    }

    // Deep scroll-back gate: when the user has panned back into history
    // (follow off) and this live column sits past the resident window's right
    // edge, DON'T write it — it would wrap-evict the region being viewed. The
    // column stays on the server and is recoverable on go-live; the resident
    // window keeps tracking the scrolled-back region the loader is filling.
    if (!this.camera.followTime && range !== null && col.col_seq > range.newest + 1) {
      this.benchmark?.count(col.final ? 'finalizedHistoryOmitted' : 'partialHistoryOmitted');
      return;
    }

    // Forward col_seq SKIP repair ("heatmap bir anda yok oluyor"): the server
    // drops queued columns for a lagging client (LAG_DROP_NS = 2 s of backlog),
    // so the next column can sit past `newest + 1`. Residency's conservative
    // fallback gates EVERY older column to background — one dropped column
    // blanks thousands of valid columns for minutes. If the skipped band is
    // small enough to zero, fill it with honest empty texture and tell append
    // the band is repaired, so `validFrom` stays put and the pre-gap region
    // keeps painting; the seam shows exactly the dropped columns (with the
    // GAP marker the stream carries). Larger skips keep the conservative gate.
    let gapZeroed = false;
    let gapFrom = -1;
    if (range !== null && col.col_seq > range.newest + 1) {
      const band = col.col_seq - range.newest - 1;
      if (band <= GAP_ZERO_MAX_COLS) {
        gapFrom = range.newest + 1;
        ring.zeroColumns(gapFrom, col.col_seq - 1);
        gapZeroed = true;
      }
    }

    // The server re-sends the forming column on a timer, even while the book is
    // quiet. A byte-identical repeat of what this ring already holds would only
    // cost an upload, a mip pass and a redraw, so it is dropped here. A gap
    // repair above has just rewritten the ring behind the gate, so it never
    // skips.
    if (!gapZeroed && this.partialGate.isRepeat(col, this.ring)) {
      this.benchmark?.count('partialUnchanged');
      return;
    }
    this.writeColumn(col, rows, false, gapZeroed);
    this.benchmark?.count(col.final ? 'finalizedApplied' : 'partialApplied');
    // The zeroed band's SUM-mip groups must be re-baked or the coarse levels
    // keep summing pre-zero stale members (the append above only baked the
    // post-gap column's own group). Then ask the loader to fetch the dropped
    // band from the session's grid ring: a server tx_lag drop evicts only THIS
    // client's queue, so the columns are usually still servable and can replace
    // the zeroes with real data (the zeroes stay the honest fallback).
    if (gapZeroed) {
      this.bakeGapMips(gapFrom, col.col_seq);
      this.history?.refetchBand(gapFrom, col.col_seq - 1, col.t0_ns);
    }

    // Normalization: seed the viewport normalizer once from the server's
    // per-session norm_seed (p99 of recent nonzero density) — thereafter u_norm
    // is the VIEWPORT percentile, recomputed per frame in updateNormalization().
    if (!this.normSeeded) {
      const seed = this.store.getState().normSeed;
      if (seed && seed > 0) {
        this.normalizer.seed(Math.max(seed, NORM_FLOOR));
        this.normSeeded = true;
      }
    }
    // Colormap follows the HONESTY tier, not the render mode: synthetic equity
    // depth → amber ramp even though it ships two-sided as MODE_L1_BAND.
    // Apply it to the heatmap encoding right away so the ramp is correct even on
    // a frame where the viewport normalizer has no data yet (updateNormalization
    // early-returns then); it re-affirms the same ramp once histograms exist.
    this.shading.noteColumnMode(col.mode);

    this.host.updateView();
    this.frameState.dirty = true;
  }

  /**
   * Splice a backfilled history column (loader sink). Same physical write as
   * a live append — the ring addresses by absolute col_seq, so an older column
   * lands in its true slot and slides the resident window backward.
   */
  spliceColumn = (col: DepthColumn): void => {
    this.benchmark?.count('historyReceived');
    if (this.glLost()) { this.benchmark?.count('historyDiscarded:contextLost'); return; }
    // Same session gate as the live path: `resetForSession()` nulls the
    // HistoryLoader, but a request the OLD loader already had in flight still
    // resolves through this bound sink. Never create or rebuild here — a stale
    // history response must not touch the live ring's geometry.
    if (this.awaitingSession) { this.benchmark?.count('historyOmitted:staleSession'); return; }
    const ring = this.ring;
    if (ring === null) { this.benchmark?.count('historyDiscarded:noRing'); return; }
    const params = this.store.getState().epochs.get(col.epoch);
    const rows = params?.rows ?? col.bid.length;
    if (rows !== ring.rows || col.bid.length !== rows) {
      this.benchmark?.count('historyDiscarded:rowMismatch');
      console.warn(`[flowmap] history column rows ${rows} ≠ ring rows ${ring.rows}; skipping`);
      return;
    }
    // Defer the SUM-mip regen: the loader splices a whole page through this sink
    // synchronously, and one range pass per level per tile layer at page end is
    // ~80× fewer FBO passes than per-column regeneration.
    try {
      this.writeColumn(col, rows, true);
      this.benchmark?.count('historyApplied');
    } catch (error) {
      this.benchmark?.count('historyDiscarded:writeError');
      throw error;
    }
    this.frameState.dirty = true;
  };

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

  // --- gap-repair mip re-bake (see spliceMips.ts for the splice batch) ----------

  /**
   * Re-bake the SUM-mips over a zeroed gap band + the post-gap column. Without
   * this the coarse levels keep summing pre-zero stale group members (the
   * append's own `updateFrom` only covers the new column's group). Range pass
   * for a full band, per-column for a small one — same split as
   * {@link SpliceMipBatch.flush}.
   */
  private bakeGapMips(from: number, to: number): void {
    const mips = this.mips;
    const ring = this.ring;
    if (mips === null || ring === null || from < 0) return;
    if (to - from + 1 >= MIP_BATCH_MIN_COLS) mips.updateRange(ring, from, to);
    else for (let s = from; s <= to; s++) mips.updateFrom(ring, s);
  }

  /**
   * Reset the heatmap renderer to a clean, empty slate for a NEW subscription
   * (a symbol / market switch). The DOM ladder + tape read the live book directly
   * and switch on their own; the GL heatmap, by contrast, holds a {@link TileRing}
   * of the OLD symbol's columns and a camera fit to the OLD price frame — so
   * WITHOUT this the new session's columns (a fresh epoch with a wildly different
   * `p0`) append onto the stale ring while the camera stays framed on the old
   * price range, and the old tiles keep showing. This is the integration-gate
   * bug: switch sim→binance and the heatmap keeps painting sim's 88–128 band.
   *
   * The teardown mirrors the pre-first-column state (`ring === null`): the NEXT
   * {@link onDepthColumn} of the new session lazily rebuilds the ring at the new
   * symbol's row count via {@link createRing} — the LIVE path, so the ring/mips
   * sizing is correct even when the grid height changes — re-fits the camera, and
   * rebuilds the {@link HistoryLoader}. The CPU-side normalizer / column cache /
   * overlays are cleared, the (epoch, col_seq) auto-follow + overlay-anchor
   * cursors are rewound (so the new session's first, lower col_seq is accepted as
   * the newest), and the norm re-seeds from the new session's `norm_seed` on its
   * first column ({@link normSeeded} back to false).
   *
   * Distinct from the context-loss {@link recreateGL} (same symbol → same
   * geometry, GL objects revived in place, camera view preserved) and from the
   * perf / normalize / overlay preloads (which install a FIXED test geometry). A
   * bare reconnect that keeps the symbol must NOT call this — it would wipe
   * scrolled-back history — so App.tsx keys the trigger on market:symbol, not
   * sessionId. Safe to call before the first column too (a no-op teardown).
   */
  resetForSession(): void {
    this.gpu.resetOverview();
    this.host.forgetPresentedSession();
    for (const col of this.pendingDepth) this.benchmarkDiscard(col, 'sessionReset');
    this.pendingDepth.length = 0;
    // Close the per-session column gate FIRST, ahead of the lost-context bail:
    // the old session's columns keep arriving whether or not the GL context is
    // healthy, and the restore path rebuilds at the remembered `ringRows`, which
    // is the OLD geometry. See gl/sessionGate.ts.
    this.awaitingSession = true;
    this.gateSessionId = this.store.getState().sessionId;
    this.gateWarned = false;
    this.lastSessionId = this.gateSessionId;
    this.pendingSessionTimeline = null;

    // the 2D ink (text layer + both gutters) is NOT GL — clear it
    // and run the whole CPU-side teardown BEFORE the lost-context bail. The old
    // code returned first, so a symbol switch during a context loss left the
    // previous symbol's price line / axis labels / pill floating over the new
    // heatmap until bars overwrote them. 2D ops are safe
    // while the GL context is lost; only the GL teardown waits.
    this.overlayLayer.clearOverlayInk();
    this.normalizer.reset();
    this.columnCache.reset();
    this.overlays.reset();
    this.overlayLayer.forgetPrune();
    this.lastBar = null;
    this.normSeeded = false;
    this.shading.resetSession();
    this.streamIngestWarned = false;

    // Rewind the per-session cursors used for auto-follow + overlay anchoring so
    // the new session's first (typically lower) col_seq becomes the newest again.
    this.frameState.newestSeq = -1;
    this.frameState.newestT0Ns = 0n;
    this.follow.trackedRowN = null;
    this.follow.trackedEpoch = null;
    this.follow.priceEpoch = null;
    this.follow.priceTarget = null;
    this.follow.priceFitMemo = null;
    this.follow.initialPriceFramed = false;
    this.follow.barPriceFitPending = false;
    this.camera.priceZoomBounds = null;
    this.camera.priceScale = null;
    // The eased live-edge scroll restarts clean: a new session's first follow
    // frame is the default window, and a stale lag from the old session's
    // arrival cadence would just slide the fresh view for no reason.
    this.follow.liveLag = 0;
    this.follow.lagBaseSeq = -1;
    this.follow.glideLastTs = 0;
    this.follow.glideWasFollowing = false;
    this.axis.clearAnchor();

    // Camera back to the provisional live default (follow ON, like the ctor);
    // createRing re-fits to the new grid on the first column, then the per-column
    // follow frame fits the price axis to the new book.
    this.camera.setLimits(limitsFor(1, this.capacityColsTarget));
    this.camera.reset(null);
    this.follow.userTimeZoomed = false; // new session: the default window is the frame
    this.follow.requestedTimeWindow = undefined;
    this.follow.applyWantedFollow();
    this.frameState.view = this.camera.toView();

    // A lost context is mid-rebuild; its own `restored` path re-empties the ring
    // at the remembered geometry. The CPU state above is already re-armed.
    if (this.glLost()) return;

    // Tear down the GL heatmap objects; the next new-session column recreates
    // them at the new row count via createRing (matching the live-path sizing).
    this.gpu.teardownRing();

    // Wipe the old image now — preserveDrawingBuffer would otherwise keep the
    // stale frame on screen until the first new-session column draws.
    this.gpu.clearBackground();

    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
  }

  /**
   * cursor-only reset for a NEW session on the SAME subscription (a
   * server-side session replacement whose col_seq restarts below the old
   * high-water, or an explicit App call on a `sessionId` change). Rewinds the
   * follow/anchor cursors, drops the overlay data and clears the 2D ink, but
   * does NOT touch the ring — scrolled-back history survives. The next live
   * column re-derives everything (tracked row, price fit, anchors).
   */
  resetOverlaysForNewSession(sessionId?: string): void {
    // The renderer also detects session replacement internally; when the
    // App effect calls this with the SAME id that detection already handled,
    // skip so the new session's first trades are not wiped twice.
    if (sessionId !== undefined && sessionId === this.lastSessionId) return;
    if (this.pendingSessionTimeline === null && this.frameState.newestSeq >= 0) {
      this.pendingSessionTimeline = { newestSeq: this.frameState.newestSeq, newestT0Ns: this.frameState.newestT0Ns };
    }
    this.host.forgetPresentedSession();
    this.frameState.newestSeq = -1;
    this.frameState.newestT0Ns = 0n;
    this.follow.trackedRowN = null;
    this.follow.trackedEpoch = null;
    // Same rationale as resetForSession: the eased live-edge scroll restarts
    // clean with the session's cursors (col_seq restarts below the old
    // high-water, so lagBaseSeq must follow or arrivals would mis-count).
    this.follow.liveLag = 0;
    this.follow.lagBaseSeq = -1;
    this.follow.glideLastTs = 0;
    this.follow.glideWasFollowing = false;
    // A same-numbered epoch replacement (the server grid always starts
    // at epoch 0 and Hello overwrites the params) skips the numeric remap, so
    // the camera would be silently reinterpreted through the new affine. Cache
    // the last map we painted with and force one price-preserving remap on the
    // next column.
    this.follow.forcedRemapFrom = this.axis.lastPriceMapCache;
    this.follow.priceEpoch = null;
    this.follow.priceTarget = null;
    this.follow.priceFitMemo = null;
    this.axis.clearAnchor();
    this.follow.barPriceFitPending = false;
    this.overlayLayer.forgetPrune();
    this.lastBar = null;
    // The t0 run table is seq-scoped; a new session re-starts seqs, so
    // drop the run (slots are overwritten as the new columns arrive).
    this.axis.slots.dropRun();
    this.overlayLayer.clearOverlayInk();
    this.overlays.reset();
    this.frameState.dirty = true;
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
