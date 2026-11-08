/**
 * Volume (liquidity) profile overlay. Toggleable; OFF by
 * default (settings drawer).
 *
 * A volume-by-price histogram drawn as horizontal bars on the RIGHT side,
 * accumulated over the VISIBLE column window from the exact per-column density
 * (bid+ask resting size) in the CPU column cache — the same exact values the
 * crosshair reads, never GPU/mip texels. The point-of-control (POC, the max row)
 * is highlighted and labeled. Because it sums only the visible columns × visible
 * rows, cost is O(visible), never O(history).
 *
 * This is a resting-liquidity-by-price profile (from the L2 density grid), which
 * allows as the profile source ("from BarColumn vol OR from column density");
 * it is the exact, row-aligned choice and reads honestly as book volume-at-price.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import { visibleColRange } from './coords';
import { quoteDecimals } from './axisTicks';
import { priceToRow, rowToPrice, type PriceScale } from '../priceScale';
import { ViewWorker } from '../viewWorker';
import { systemClock, type GlClock } from '../clock';
import { t } from '../../i18n';

/** A moving view keeps its last profile; a new window is requested after this quiet period. */
const PROFILE_SETTLE_MS = 150;
/** Worker failures retried for one window before the profile stays failed until the view changes. */
const PROFILE_MAX_RETRIES = 3;
/** First retry delay after a worker failure; doubles per failure up to the cap. */
const PROFILE_RETRY_BASE_MS = 2000;
const PROFILE_RETRY_MAX_MS = 30_000;

/** The window a worker run covers, captured when the run starts. */
interface ProfileRun {
  colLo: number;
  colHi: number;
  rowLo: number;
  rowHi: number;
  scale: PriceScale;
  key: string;
  version: number;
}

function sameGeometry(a: PriceScale, b: PriceScale): boolean {
  if (a.kind !== b.kind || a.rows !== b.rows) return false;
  if (a.kind === 'linear' && b.kind === 'linear') return a.p0 === b.p0 && a.step === b.step;
  if (a.kind === 'hybrid' && b.kind === 'hybrid') return a.dnRows === b.dnRows && a.coreRows === b.coreRows &&
    a.coreP0 === b.coreP0 && a.coreStep === b.coreStep && a.loPrice === b.loPrice && a.hiPrice === b.hiPrice;
  return false;
}

export interface ProfileResult {
  /** Summed density per row over `[rowLo, rowHi]` (index 0 = rowLo). */
  bins: Float64Array;
  rowLo: number;
  /** Max bin value (the POC height). */
  max: number;
  /** Absolute row of the POC (max), or -1 when empty. */
  pocRow: number;
  /**
   * True when columns/rows were sampled or source geometry was redistributed;
   * the POC must then disclose its approximate resolution. `rowStride > 1` is a
   * one-sample-per-mip-block SUBSAMPLE of the visible volume rather than the
   * exact per-row sums. The POC readout must be marked approximate in that
   * case (the block-sum winner can differ from the sampled winner — see the
   * `accumulateProfile` doc). `stride === 1` is always exact and `sampled`
   * is false.
   */
  sampled: boolean;
}

/**
 * Sum exact column density into per-row bins over a column × row window. Pure —
 * `getArrays(col)` returns the column's `{bid, ask}` (or null for uncached).
 *
 * `out`, when supplied, receives the bins (zeroed first) instead of allocating a
 * fresh Float64Array per call — the per-frame profile pass reuses one scratch
 * buffer across dirty frames. It is RETURNED, so `Profile.last.bins` aliases the
 * live scratch by design: consumers read the result synchronously after the
 * draw that produced it (see {@link Profile.debug} consumers).
 *
 * `rowWidth`, when supplied, gives each row's PRICE width and switches the bins
 * to density-per-unit-price. That is not cosmetic: this is a histogram, and on a
 * non-uniform price grid the bins have unequal widths — a log-wing row can cover
 * hundreds of times the price range of a core row, so on raw sums the wings win
 * the point-of-control contest on bucket width alone. The POC is rendered as
 * both a highlight and a printed price, so that would be a confidently wrong
 * quantitative claim. Omit it (the linear grid) and the raw sums are kept
 * bit-for-bit, so uniform-grid bar lengths and the POC row are unchanged.
 *
 * `rowStride` (the row bound), when > 1, scans only every `stride`-th
 * row — aligned to absolute grid rows (the first multiple of `stride` at or
 * above `rowLo`). Callers pass the ACTIVE MIP BLOCK (4^level): at that level the
 * heatmap already sums each block into one displayed cell, so the sub-block
 * resolution is below what the display can show. The scanned work is then
 * bounded by the mip level's own footprint (level 0 can only be selected while
 * fewer than ~4 rows per device pixel are on screen), collapsing the old
 * O(cols × grid-rows) pass to O(cols × 4 × viewport-pixels). `rowStride = 1`
 * (the default) reproduces the legacy full scan bit-for-bit.
 *
 * **Honesty contract for stride > 1.** The bins are a SUBSAMPLE, not
 * block sums: each sampled row contributes only its own density, while the
 * heatmap cell behind it is the SUM of its 4^L-row block. Consequently the
 * sampled `pocRow`/`max` can disagree with the true block-sum POC (e.g. four
 * quiet rows summing above one sampled loud row). The result therefore carries
 * `sampled: true` and the overlay labels the POC readout "≈POC"; a precise POC
 * claim is only made in the exact `stride === 1` pass. Bars keep the sampled
 * relative shape (they are never presented as exact totals).
 */
export function accumulateProfile(
  colLo: number,
  colHi: number,
  rowLo: number,
  rowHi: number,
  getArrays: (col: number) => { bid: Float32Array; ask: Float32Array | null } | null,
  rowWidth?: (row: number) => number,
  out?: Float64Array,
  rowStride = 1,
  projection?: { target: PriceScale; source: (col: number) => PriceScale | null },
): ProfileResult {
  const nRows = Math.max(0, rowHi - rowLo + 1);
  const bins = out !== undefined && out.length >= nRows ? out.fill(0, 0, nRows) : new Float64Array(nRows);
  const stride = Math.max(1, Math.floor(rowStride));
  let reprojected = false;
  for (let c = colLo; c <= colHi; c++) {
    const a = getArrays(c);
    if (a === null) continue;
    const { bid, ask } = a;
    if (projection) {
      const source = projection.source(c);
      if (source === null) continue; // Unknown geometry cannot be assigned a price.
      const target = projection.target;
      if (!sameGeometry(source, target)) {
        reprojected = true;
        // Native depth is binned at the nearest row in every epoch.
        const sourceShift = 0.5;
        const targetShift = 0.5;
        const priceLo = rowToPrice(target, rowLo - targetShift);
        const priceHi = rowToPrice(target, rowHi + 1 - targetShift);
        const sourceLo = Math.max(0, Math.floor(priceToRow(source, priceLo) + sourceShift));
        const sourceHi = Math.min(bid.length - 1, Math.floor(priceToRow(source, priceHi) + sourceShift));
        for (let r = sourceLo; r <= sourceHi; r++) {
          const quantity = bid[r] + (ask !== null ? ask[r] : 0);
          if (!(quantity > 0)) continue;
          const low = rowToPrice(source, r - sourceShift);
          const high = rowToPrice(source, r + 1 - sourceShift);
          const width = high - low;
          if (!(width > 0) || !Number.isFinite(width)) continue;
          const first = Math.max(rowLo, Math.floor(priceToRow(target, low) + targetShift));
          const last = Math.min(rowHi, Math.floor(priceToRow(target, high) + targetShift));
          for (let t = first; t <= last; t++) {
            const overlap = Math.min(high, rowToPrice(target, t + 1 - targetShift)) - Math.max(low, rowToPrice(target, t - targetShift));
            if (overlap > 0) bins[t - rowLo] += quantity * overlap / width;
          }
        }
        continue;
      }
    }
    const hi = Math.min(rowHi, bid.length - 1);
    const lo = Math.max(rowLo, 0);
    // Absolute-row alignment: absolute rows that are multiples of `stride` are
    // exactly the mip block starts (block L covers [k·4^L, (k+1)·4^L)).
    const first = lo + ((stride - (lo % stride)) % stride);
    for (let r = first; r <= hi; r += stride) {
      bins[r - rowLo] += bid[r] + (ask !== null ? ask[r] : 0);
    }
  }
  if (rowWidth !== undefined) {
    for (let i = 0; i < nRows; i++) {
      const w = rowWidth(rowLo + i);
      bins[i] = w > 0 && Number.isFinite(w) ? bins[i] / w : 0;
    }
  }
  let max = 0;
  let pocRow = -1;
  for (let i = 0; i < nRows; i++) {
    if (bins[i] > max) {
      max = bins[i];
      pocRow = rowLo + i;
    }
  }
  // A view of EXACTLY nRows entries: a reused scratch may be longer than this
  // frame's window (the previous frame was taller), and callers iterate
  // `bins.length` when drawing.
  return { bins: bins.subarray(0, nRows), rowLo, max, pocRow, sampled: stride > 1 || reprojected };
}

export interface ProfileOptions {
  /** Max bar length as a fraction of viewport width (default 0.22). */
  widthFrac?: number;
  /** Column threshold for moving the full calculation off the render thread. */
  maxCols?: number;
}

const DEFAULTS: Required<ProfileOptions> = { widthFrac: 0.22, maxCols: 1024 };

export class Profile {
  private opts: Required<ProfileOptions>;
  /** Last computed result (for tests / readouts). Its `bins` is the live
   *  scratch when the draw supplied one — read synchronously after a draw. */
  last: ProfileResult | null = null;
  /** Per-frame bin accumulator, reused across dirty frames (no per-frame alloc). */
  private scratch: Float64Array = new Float64Array(0);
  private worker: ViewWorker | null = null;
  /** The window the screen should show (the latest view). */
  private viewKey = '';
  /** The window and frame version the shown worker result was computed for. */
  private completedKey = '';
  private completedVersion = -1;
  private workerResult: ProfileResult | null = null;
  private generation = 0;
  /** Worker failures since the last success or view change (bounded retry). */
  private failures = 0;
  /** Earliest clock time at which a run may start (settle period or retry backoff). */
  private notBefore = 0;
  /** Pending re-draw that starts a deferred run without new input. */
  private wakeAt = Infinity;
  private wakeTimer: unknown = null;
  /** Key and result of the last synchronous (within-budget) accumulation. */
  private syncKey = '';
  private syncResult: ProfileResult | null = null;
  calculationState: 'idle' | 'pending' | 'ready' | 'failed' = 'idle';
  private readonly clock: GlClock;

  constructor(opts: ProfileOptions = {}, clock: GlClock = systemClock) {
    this.opts = { ...DEFAULTS, ...opts };
    this.clock = clock;
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid, text } = frame;
    if (gm.price === null) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;
    // Bound the column sweep (wide zoom-out) so the sum stays O(visible).
    const colLo = range.lo;
    const colHi = range.hi;
    // Visible absolute row band from the view, clamped to the GRID on both ends.
    // The price camera can overscroll a full viewport past either edge (see
    // gl/camera.ts rowCenterBounds), and rows outside [0, rows) hold nothing —
    // without the upper clamp the per-frame `new Float64Array(rowHi-rowLo+1)`
    // would be sized by how far the user has scrolled into empty background
    // rather than by what is actually on the grid.
    const scale = gm.price?.scale;
    const gridRows = scale?.rows ?? frame.columnArrays(colHi)?.bid.length ?? 0;
    if (gridRows <= 0) return;
    const centered = scale?.kind === 'hybrid';
    const shift = centered ? 0.5 : 0;
    const rowLo = Math.max(0, Math.floor(gm.view.rowOffset + shift));
    const rowHi = Math.min(gridRows - 1, Math.floor(gm.view.rowOffset + gm.view.rowScale + shift));
    if (rowHi < rowLo) return;

    // Unequal-width bins on a non-uniform grid must be normalized by price
    // width, or the wings win the POC on bucket width alone. Uniform grids pass
    // no width function and keep the raw sums exactly. The scratch buffer makes
    // the per-frame pass allocation-free (rows can only grow so much; the
    // helper regrows internally if the view gets taller).
    //
    // Every native row contributes. Frame-wide mip skipping loses wing buckets
    // whose physical price interval is still plainly visible on screen.
    let result: ProfileResult;
    if (scale && colHi - colLo + 1 > this.opts.maxCols) {
      const key = JSON.stringify([colLo, colHi, rowLo, rowHi, scale]);
      const now = this.clock.now();
      if (key !== this.viewKey) {
        // The view moved. A run in flight keeps its own captured window and is left
        // to finish: disposing it on every pan threw the work away and restarted it
        // each frame, so a moving view never got a profile. The new window is asked
        // for once the view has been still for PROFILE_SETTLE_MS, and the last
        // result stays on screen meanwhile.
        this.viewKey = key;
        this.failures = 0;
        // Nothing is on screen yet: the first window starts at once. Only a
        // profile that is being held waits for the view to settle.
        this.notBefore = this.workerResult === null ? now : now + PROFILE_SETTLE_MS;
        if (this.notBefore > now) this.wake(frame.changed, this.notBefore);
      }
      const version = frame.dataVersion ?? 0;
      const stale = this.completedKey !== key || this.completedVersion !== version;
      if (stale && this.failures <= PROFILE_MAX_RETRIES && !this.worker?.busy) {
        if (now < this.notBefore) this.wake(frame.changed, this.notBefore);
        else this.startRun(frame, { colLo, colHi, rowLo, rowHi, scale, key, version });
      }
      if (!this.workerResult) {
        this.last = null;
        // Localised through the active locale: the badge is redrawn on every frame.
        text.badge(gm.dims.cssW - 3, 18, this.calculationState === 'failed' ? t('gl.profileFailed') : t('gl.profilePending'), { align: 'right', color: OVERLAY.profile.css, size: 10 });
        return;
      }
      result = {
        ...this.workerResult,
        sampled: this.workerResult.sampled || this.completedVersion !== version || this.completedKey !== key,
      };
    } else {
      // Within budget the sum runs on this thread. The result is reused while the
      // window, the frame version and the scale are unchanged: nothing
      // in those inputs moved, so a rescan would return the same bins.
      const syncKey = `${colLo}|${colHi}|${rowLo}|${rowHi}|${frame.dataVersion ?? 0}|${scale ? JSON.stringify(scale) : ''}`;
      if (this.syncResult === null || syncKey !== this.syncKey) {
        this.syncKey = syncKey;
        this.syncResult = accumulateProfile(
          colLo,
          colHi,
          rowLo,
          rowHi,
          frame.columnArrays,
          scale !== undefined && scale.kind !== 'linear' ? (row) => gm.stepAtRow(row) : undefined,
          this.scratch,
          1,
          scale && frame.columnScale ? { target: scale, source: frame.columnScale } : undefined,
        );
      }
      result = this.syncResult;
    }
    this.scratch = result.bins;
    this.last = result;
    if (result.max <= 0) return;

    const cssW = gm.dims.cssW;
    const maxLenClip = gm.pxToClipW(Math.max(24, cssW * this.opts.widthFrac));
    const rightEdge = 1; // clip right

    solid.begin();
    for (let i = 0; i < result.bins.length; i++) {
      const v = result.bins[i];
      if (v <= 0) continue;
      const row = result.rowLo + i;
      const y0 = gm.clipY(row - shift);
      const y1 = gm.clipY(row + 1 - shift);
      const len = (v / result.max) * maxLenClip;
      const isPoc = row === result.pocRow;
      const color = isPoc ? OVERLAY.poc.gl : OVERLAY.profile.gl;
      solid.addRect(rightEdge - len, y0, rightEdge, y1, color);
    }
    solid.flush();

    // Physical redistribution from another epoch is approximate inside its
    // native buckets; disclose that precision with the "≈POC" label.
    if (result.pocRow >= 0) {
      const center = result.pocRow + 0.5 - shift;
      const price = gm.rowToPrice(result.pocRow);
      // The bucket can be much wider than the venue's actual quote increment.
      const decimals = quoteDecimals(gm.price.tick ?? gm.price.step);
      const y = gm.cssY(center);
      const prefix = result.sampled ? '≈POC' : 'POC';
      text.badge(cssW - 3, y, `${prefix} ${price.toFixed(decimals)}`, {
        align: 'right',
        color: OVERLAY.poc.css,
        size: 10,
      });
    }
  }

  /**
   * Start the off-thread sum for one window. A worker that fails is disposed and
   * dropped; the next attempt gets a fresh one after a backoff.
   */
  private startRun(frame: OverlayFrame, run: ProfileRun): void {
    const { colLo, colHi, rowLo, rowHi, scale, key, version } = run;
    this.worker ??= new ViewWorker(this.clock);
    const worker = this.worker;
    const generation = this.generation;
    this.calculationState = 'pending';
    const read = frame.columnArrays, nativeScale = frame.columnScale, changed = frame.changed;
    const columns = function* () {
      for (let c = colLo; c <= colHi; c++) {
        const arrays = read(c);
        yield arrays ? { ...arrays, scale: nativeScale?.(c) ?? scale } : null;
      }
    };
    void worker.run({ kind: 'profile', rowLo, rowHi, target: scale, normalizeWidths: scale.kind !== 'linear' }, columns()).then(value => {
      if (generation !== this.generation) return;
      const bins = value.bins as Float64Array;
      let max = 0, pocRow = -1;
      for (let i = 0; i < bins.length; i++) if (bins[i] > max) { max = bins[i]; pocRow = rowLo + i; }
      this.workerResult = { bins, rowLo, max, pocRow, sampled: value.sampled || value.missing > 0 };
      this.completedKey = key; this.completedVersion = version; this.failures = 0;
      this.calculationState = 'ready'; changed?.();
    }).catch(() => {
      if (generation !== this.generation) return;
      // A failed worker rejects every later run, so it is dropped here.
      if (worker === this.worker) { worker.dispose(); this.worker = null; }
      this.failures += 1;
      this.calculationState = 'failed';
      this.notBefore = this.clock.now() + Math.min(PROFILE_RETRY_MAX_MS, PROFILE_RETRY_BASE_MS * 2 ** (this.failures - 1));
      this.wake(changed, this.notBefore);
      changed?.();
    });
  }

  /** Re-draw at `at` (clock time) so a deferred run starts without new input. */
  private wake(changed: (() => void) | undefined, at: number): void {
    if (changed === undefined || at >= this.wakeAt) return;
    if (this.wakeTimer !== null) this.clock.clearTimer(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = this.clock.setTimer(() => {
      this.wakeTimer = null;
      this.wakeAt = Infinity;
      changed();
    }, Math.max(0, at - this.clock.now()));
  }

  setOptions(opts: Partial<ProfileOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }
  reset(): void {
    this.generation++;
    this.worker?.dispose();
    this.worker = null;
    if (this.wakeTimer !== null) this.clock.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = Infinity;
    this.workerResult = null;
    this.last = null;
    this.viewKey = '';
    this.completedKey = '';
    this.completedVersion = -1;
    this.failures = 0;
    this.notBefore = 0;
    this.syncKey = '';
    this.syncResult = null;
    this.calculationState = 'idle';
    this.scratch = new Float64Array(0);
  }

  dispose(): void { this.reset(); }
}
