/**
 * Repopulates a freshly rebuilt TileRing and its companion GPU/CPU structures
 * from the surviving CPU ColumnCache after a WebGL context restore.
 */

import type { ColumnCache } from '../columnCache';
import type { MipChain } from '../mips';
import type { TileRing } from '../tileRing';
import type { AxisMap } from './axisMap';
import { columnExtent } from './columnWrite';
import type { RingExtents } from './gpuLifecycle';

export function repopulateRingFromCache(
  ring: TileRing,
  mips: MipChain | null,
  extents: RingExtents,
  cache: ColumnCache,
  axis: AxisMap,
  countUpload: () => void,
): number {
  const seqs = cache.cachedSeqs();
  if (seqs.length === 0) return 0;

  const rows = ring.rows;
  const cap = ring.capacityCols;
  let uploaded = 0;
  let minSeq = Infinity;
  let maxSeq = -Infinity;

  for (const seq of seqs) {
    const arrays = cache.arrays(seq);
    if (arrays === null || arrays.bid.length !== rows) continue;
    const epoch = cache.epochAt(seq) ?? 0;
    const t0 = cache.timeAt(seq);
    const nativePrice = cache.priceAt(seq);

    ring.append(seq, epoch, arrays.bid, arrays.ask, rows, false);
    if (nativePrice?.scale) ring.geometry.set(seq, nativePrice.scale, epoch);

    const slot = ((seq % cap) + cap) % cap;
    const [lo, hi] = columnExtent(arrays.bid, arrays.ask, rows);
    extents.write(slot, lo, hi, seq);
    if (t0 !== null) {
      axis.slots.write(slot, t0);
      axis.slots.extendRun(seq);
    }

    countUpload();
    uploaded++;
    if (seq < minSeq) minSeq = seq;
    if (seq > maxSeq) maxSeq = seq;
  }

  if (uploaded > 0 && mips !== null && Number.isFinite(minSeq) && Number.isFinite(maxSeq)) {
    mips.updateRange(ring, minSeq, maxSeq);
  }
  return uploaded;
}
