/**
 * BBO overlay.
 *
 * The current best bid / best ask as two thin horizontal lines at their prices,
 * plus right-edge price-axis badges (size on the touch) via the text layer.
 *
 * Source (chosen by the renderer; the badge says which one it is):
 *   - `'bbo'`  — a real BBO print from the feed (crypto BookTicker,
 *     equity L1). Preferred when the feed carries the channel.
 *   - `'l2'` — inside quote DERIVED from the newest L2 depth column's book
 *     (highest bid row / lowest ask row). Used when the feed has a
 *     full L2 book but no separate BBO channel (e.g. the sim). The
 *     badge is tagged `·L2` so it's clear it's book-derived, not a
 *     distinct print. It is never fabricated.
 * A feed with neither (equity keyless / L1_BAND with no BBO) shows nothing.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import { quoteDecimals } from './axisTicks';
import { formatPrice, formatSizeReadout } from '../../i18n/format';
import { t } from '../../i18n';

export type BboSource = 'bbo' | 'l2';

export interface BboState {
  bidPx: number;
  bidSz: number;
  askPx: number;
  askSz: number;
  source: BboSource;
}

/** Minimum vertical distance (CSS px) between the ask and bid badges. */
const BADGE_PITCH_PX = 12;

export class Bbo {
  private current: BboState | null = null;

  set(state: BboState | null): void {
    this.current = state;
  }

  get(): BboState | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }

  draw(frame: OverlayFrame): void {
    const bbo = this.current;
    const { gm, solid, text } = frame;
    if (bbo === null || gm.price === null) return;

    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    const decimals = quoteDecimals(gm.price.tick ?? gm.price.step);
    const tag = bbo.source === 'l2' ? ' ·L2' : '';

    /** Clip-space line height and badge centre for one side; null when unquoted or off-screen. */
    const place = (price: number): { y: number; cy: number } | null => {
      if (!Number.isFinite(price)) return null; // one-sided book / unknown quote
      // Uniform cell centres; exact price coordinates on hybrid grids.
      const rowf = gm.priceEventToRow(price);
      const y = gm.clipY(rowf);
      if (y < -1.02 || y > 1.02) return null; // off-screen vertically
      return { y, cy: gm.cssY(rowf) };
    };
    const ask = place(bbo.askPx);
    const bid = place(bbo.bidPx);
    // A one-tick spread puts the two quotes on adjacent rows. Their badges would
    // overprint, so a pair closer than the badge pitch is pushed apart around its
    // midpoint, keeping ask above bid.
    let askCy = ask?.cy ?? 0;
    let bidCy = bid?.cy ?? 0;
    if (ask !== null && bid !== null && Math.abs(askCy - bidCy) < BADGE_PITCH_PX) {
      const mid = (askCy + bidCy) / 2;
      const half = BADGE_PITCH_PX / 2;
      if (askCy <= bidCy) {
        askCy = mid - half;
        bidCy = mid + half;
      } else {
        askCy = mid + half;
        bidCy = mid - half;
      }
    }

    const drawSide = (
      side: { y: number } | null,
      price: number,
      sz: number,
      color: (typeof OVERLAY)['bid'],
      key: string,
      cy: number,
    ): void => {
      if (side === null) return;
      solid.begin();
      solid.addThickLine(-1, side.y, 1, side.y, 2.1, color.gl, cssW, cssH);
      solid.flush();
      // Right-edge badge: e.g. "A 100.75 ×8·L2".
      const sizeText = formatSizeReadout(sz);
      const label = `${key} ${formatPrice(price, decimals)}${sizeText !== '' ? ` ×${sizeText}` : ''}${tag}`;
      text.badge(cssW - 3, cy, label, { align: 'right', color: color.css, size: 10 });
    };

    drawSide(ask, bbo.askPx, bbo.askSz, OVERLAY.ask, t('overlay.bbo.askSide'), askCy);
    drawSide(bid, bbo.bidPx, bbo.bidSz, OVERLAY.bid, t('overlay.bbo.bidSide'), bidCy);
  }
}
