/**
 * Repeat gate for the forming bar column (stream ingest, renderer.ts).
 *
 * The server re-sends the forming bar on every flush tick, whether or not a
 * trade moved it. Forwarding an identical bar again would re-run the overlay
 * ingest, the price-fit request and a full heatmap and overlay redraw at up to
 * 60 Hz on a quiet market. This check says whether a bar carries exactly the
 * fields the last forwarded bar carried, so the caller can drop it.
 */

import type { BarColumn } from '../proto/types';

/**
 * True when `next` has the same identity and values as `prev`, so forwarding it
 * again would change no overlay state. `null` (nothing forwarded yet) is never a
 * repeat. Numbers compare with `Object.is`, so a NaN field repeats as NaN.
 */
export function isRepeatBar(prev: BarColumn | null, next: BarColumn): boolean {
  if (prev === null) return false;
  return (
    prev.epoch === next.epoch &&
    prev.col_seq === next.col_seq &&
    prev.t0_ns === next.t0_ns &&
    Object.is(prev.o, next.o) &&
    Object.is(prev.h, next.h) &&
    Object.is(prev.l, next.l) &&
    Object.is(prev.c, next.c) &&
    Object.is(prev.vol_buy, next.vol_buy) &&
    Object.is(prev.vol_sell, next.vol_sell) &&
    Object.is(prev.cvd_cum, next.cvd_cum) &&
    Object.is(prev.vwap_num_cum, next.vwap_num_cum) &&
    Object.is(prev.vwap_den_cum, next.vwap_den_cum)
  );
}
