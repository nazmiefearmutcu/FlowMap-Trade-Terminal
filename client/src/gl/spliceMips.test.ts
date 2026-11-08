import { describe, expect, it, vi } from 'vitest';
import type { TileRing } from './tileRing';
import { MIP_BATCH_MIN_COLS, SpliceMipBatch, type MipBaker } from './spliceMips';

const RING = {} as unknown as TileRing;

function mips(): MipBaker & { updateFrom: ReturnType<typeof vi.fn>; updateRange: ReturnType<typeof vi.fn> } {
  return { updateFrom: vi.fn(), updateRange: vi.fn() };
}

describe('SpliceMipBatch', () => {
  it('bakes a lone deferred column through the per-append path', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(42);
    batch.flush(m, RING);
    expect(m.updateFrom).toHaveBeenCalledTimes(1);
    expect(m.updateFrom).toHaveBeenCalledWith(RING, 42);
    expect(m.updateRange).not.toHaveBeenCalled();
  });

  it('tracks the min and max of out-of-order splices', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(5);
    batch.defer(20);
    batch.defer(3);
    batch.flush(m, RING);
    expect(m.updateRange).toHaveBeenCalledWith(RING, 3, 20);
    expect(m.updateFrom).not.toHaveBeenCalled();
  });

  it('a span below the batch threshold re-bakes column by column', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    for (let s = 0; s <= MIP_BATCH_MIN_COLS - 2; s++) batch.defer(s);
    batch.flush(m, RING);
    expect(m.updateRange).not.toHaveBeenCalled();
    expect(m.updateFrom).toHaveBeenCalledTimes(MIP_BATCH_MIN_COLS - 1);
  });

  it('a span at the batch threshold is one range pass', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(0);
    batch.defer(MIP_BATCH_MIN_COLS);
    batch.flush(m, RING);
    expect(m.updateRange).toHaveBeenCalledTimes(1);
    expect(m.updateRange).toHaveBeenCalledWith(RING, 0, MIP_BATCH_MIN_COLS);
    expect(m.updateFrom).not.toHaveBeenCalled();
  });

  it('flush empties the batch, so a second flush bakes nothing', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(1);
    batch.flush(m, RING);
    batch.flush(m, RING);
    expect(m.updateFrom).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending range without baking it', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(1);
    batch.defer(20);
    batch.cancel();
    batch.flush(m, RING);
    expect(m.updateFrom).not.toHaveBeenCalled();
    expect(m.updateRange).not.toHaveBeenCalled();
  });

  it('with no mips or no ring the range is dropped, not carried over', () => {
    const batch = new SpliceMipBatch();
    const m = mips();
    batch.defer(7);
    batch.flush(null, RING);
    batch.flush(m, null);
    batch.flush(m, RING);
    expect(m.updateFrom).not.toHaveBeenCalled();
    expect(m.updateRange).not.toHaveBeenCalled();
  });
});
