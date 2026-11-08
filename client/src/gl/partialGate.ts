/**
 * Repeat-partial gate for the forming depth column (ingest, renderer.ts).
 *
 * While a column is still forming the server re-sends its `final: false`
 * partial on a fixed cadence, whether or not the book moved. Re-writing an
 * identical partial costs a texture upload, a SUM-mip pass and a full redraw
 * for nothing. This gate remembers the partial the ring LAST received (its
 * identity and a copy of its texels) so the ingest can skip a byte-identical
 * repeat.
 *
 * Correctness rests on one invariant: the gate only ever describes the most
 * recent write into the ring. {@link note} is called from every ring write
 * (a final column, a history splice or a different sequence clears it), and a
 * ring replacement is detected by identity, so a skipped write always matches
 * what the ring already holds.
 */

export interface PartialColumn {
  readonly epoch: number;
  readonly col_seq: number;
  readonly t0_ns: bigint;
  readonly final: boolean;
  readonly bid: Float32Array;
  readonly ask: Float32Array | null;
}

/**
 * Bitwise-style texel equality. `Object.is` (not `===`) so that -0 and +0, which
 * upload as different bytes, never count as a repeat; NaN matches NaN.
 */
function sameTexels(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function copyInto(dst: Float32Array | null, src: Float32Array | null): Float32Array | null {
  if (src === null) return null;
  if (dst === null || dst.length !== src.length) return src.slice();
  dst.set(src);
  return dst;
}

export class PartialDepthGate {
  private ring: object | null = null;
  private epoch = -1;
  private colSeq = -1;
  private t0 = -1n;
  private bid: Float32Array | null = null;
  private ask: Float32Array | null = null;
  private armed = false;

  /**
   * True when `col` is a forming partial byte-identical to the last partial the
   * given ring received, so re-writing it would change nothing on the GPU.
   */
  isRepeat(col: PartialColumn, ring: object | null): boolean {
    if (!this.armed || col.final || ring === null || ring !== this.ring) return false;
    if (col.epoch !== this.epoch || col.col_seq !== this.colSeq || col.t0_ns !== this.t0) return false;
    if (this.bid === null || !sameTexels(col.bid, this.bid)) return false;
    if (col.ask === null || this.ask === null) return col.ask === this.ask;
    return sameTexels(col.ask, this.ask);
  }

  /**
   * Record a write the ring just accepted. A final column (or any `null`
   * ring) disarms the gate, because the next partial must be applied.
   */
  note(col: PartialColumn, ring: object): void {
    if (col.final) {
      this.clear();
      return;
    }
    this.ring = ring;
    this.epoch = col.epoch;
    this.colSeq = col.col_seq;
    this.t0 = col.t0_ns;
    this.bid = copyInto(this.bid, col.bid);
    this.ask = copyInto(this.ask, col.ask);
    this.armed = true;
  }

  /** Forget the last write (ring replaced, session reset, history splice). */
  clear(): void {
    this.armed = false;
    this.ring = null;
  }
}
