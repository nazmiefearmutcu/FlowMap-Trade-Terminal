/** The inside quote read from an L2 book column (split out of the overlay manager). */

import type { BboState } from './bbo';
import { mapScale, type PriceMap } from './coords';
import { rowToPrice as scaleRowToPrice } from '../priceScale';

/**
 * Inside quote from an L2 book column: best bid = highest row carrying bid
 * density (closest to the spread), best ask = lowest row carrying ask density.
 * Row→price goes through the SCALE accessor (gl/priceScale.ts), never the raw
 * `p0 + row·step` scalars — on a hybrid (non-uniform) grid a wing row's price
 * depends on where it sits, which is exactly the coords.ts contract. Pure —
 * exact reading of the book the server sent, not a fabricated quote.
 */
export function deriveL2Bbo(
  bid: Float32Array,
  ask: Float32Array | null,
  price: PriceMap,
): BboState | null {
  const scale = mapScale(price);
  let bidRow = -1;
  for (let r = bid.length - 1; r >= 0; r--) {
    if (bid[r] > 0) {
      bidRow = r;
      break;
    }
  }
  let askRow = -1;
  if (ask !== null) {
    for (let r = 0; r < ask.length; r++) {
      if (ask[r] > 0) {
        askRow = r;
        break;
      }
    }
  }
  if (bidRow < 0 && askRow < 0) return null;
  return {
    bidPx: bidRow >= 0 ? scaleRowToPrice(scale, bidRow) : Number.NaN,
    bidSz: bidRow >= 0 ? bid[bidRow] : 0,
    askPx: askRow >= 0 ? scaleRowToPrice(scale, askRow) : Number.NaN,
    askSz: askRow >= 0 && ask !== null ? ask[askRow] : 0,
    source: 'l2',
  };
}
