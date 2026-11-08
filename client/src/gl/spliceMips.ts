/**
 * Deferred SUM-mip batch for spliced history columns (renderer.ts).
 *
 * A history page splices many columns in a row. Re-baking the mips after each
 * one costs a pass per column, so the batch remembers the contiguous col_seq
 * range the splices touched and the page end flushes it once: one batched range
 * pass per mip level per tile-layer segment (a 256-column page is about two
 * passes instead of about eighty). A lone column keeps the per-append path, so
 * it behaves exactly as an unbatched splice.
 */

import type { TileRing } from './tileRing';

/** Above this many deferred splice columns, batch mip regen into range passes. */
export const MIP_BATCH_MIN_COLS = 8;

/** The mip operations the batch drives; `MipChain` satisfies it. */
export interface MipBaker {
  updateFrom(ring: TileRing, appendedColSeq: number): void;
  updateRange(ring: TileRing, fromSeq: number, toSeq: number): void;
}

export class SpliceMipBatch {
  /** Lowest and highest deferred col_seq; `from < 0` means nothing is pending. */
  private from = -1;
  private to = -1;

  /** Extend the pending splice range with one spliced column. */
  defer(colSeq: number): void {
    if (this.from < 0) {
      this.from = colSeq;
      this.to = colSeq;
    } else {
      if (colSeq < this.from) this.from = colSeq;
      if (colSeq > this.to) this.to = colSeq;
    }
  }

  /** Forget any pending range (the ring it referenced is going away). */
  cancel(): void {
    this.from = -1;
    this.to = -1;
  }

  /**
   * Bake the pending range into `mips` over `ring`, then forget it. With no mips
   * or no ring the range is dropped unbaked, as the ring it named is gone.
   */
  flush(mips: MipBaker | null, ring: TileRing | null): void {
    const from = this.from;
    if (from < 0 || mips === null || ring === null) {
      this.cancel();
      return;
    }
    const to = this.to;
    this.cancel();
    if (to === from) mips.updateFrom(ring, from);
    else if (to - from >= MIP_BATCH_MIN_COLS) mips.updateRange(ring, from, to);
    else for (let s = from; s <= to; s++) mips.updateFrom(ring, s);
  }
}
