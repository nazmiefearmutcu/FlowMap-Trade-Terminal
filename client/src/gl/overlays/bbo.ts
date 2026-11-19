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

/** Minimum vertical distance (CSS px) between the ask and bid badges (a size-10 badge with 3 px pad is 16 px tall). */
const BADGE_PITCH_PX = 16;

interface BboLayout {
  ask: { y: number; cy: number } | null;
  bid: { y: number; cy: number } | null;
  askCy: number;
  bidCy: number;
}

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

  private layout(frame: OverlayFrame): BboLayout | null {
    const bbo = this.current;
    const { gm } = frame;
    if (bbo === null || gm.price === null) return null;
    const cssH = gm.dims.cssH;
    const place = (price: number): { y: number; cy: number } | null => {
      if (!Number.isFinite(price)) return null;
      const rowf = gm.priceEventToRow(price);
      const y = gm.clipY(rowf);
      if (y < -1.02 || y > 1.02) return null;
      return { y, cy: gm.cssY(rowf) };
    };
    const ask = place(bbo.askPx);
    const bid = place(bbo.bidPx);
    const topBound = 9;
    const botBound = Math.max(topBound, cssH - 9);
    const clampY = (v: number): number => Math.min(botBound, Math.max(topBound, v));
    let askCy = ask ? clampY(ask.cy) : 0;
    let bidCy = bid ? clampY(bid.cy) : 0;
    if (ask !== null && bid !== null && Math.abs(askCy - bidCy) < BADGE_PITCH_PX) {
      const mid = clampY((ask.cy + bid.cy) / 2);
      const half = BADGE_PITCH_PX / 2;
      if (ask.cy <= bid.cy) {
        askCy = Math.max(topBound, Math.min(botBound - BADGE_PITCH_PX, mid - half));
        bidCy = Math.min(botBound, askCy + BADGE_PITCH_PX);
      } else {
        bidCy = Math.max(topBound, Math.min(botBound - BADGE_PITCH_PX, mid - half));
        askCy = Math.min(botBound, bidCy + BADGE_PITCH_PX);
      }
    }
    return { ask, bid, askCy, bidCy };
  }

  /** Draw only the horizontal GL touch lines (placed under the price line). */
  drawLines(frame: OverlayFrame): void {
    const lay = this.layout(frame);
    if (lay === null || (lay.ask === null && lay.bid === null)) return;
    const { gm, solid } = frame;
    solid.begin();
    if (lay.ask !== null) solid.addThickLine(-1, lay.ask.y, 1, lay.ask.y, 2.1, OVERLAY.ask.gl, gm.dims.cssW, gm.dims.cssH);
    if (lay.bid !== null) solid.addThickLine(-1, lay.bid.y, 1, lay.bid.y, 2.1, OVERLAY.bid.gl, gm.dims.cssW, gm.dims.cssH);
    solid.flush();
  }

  /** Draw only the right-edge 2D text badges (placed above the price line so it never slices text). */
  drawBadges(frame: OverlayFrame): void {
    const bbo = this.current;
    const lay = this.layout(frame);
    const { gm, text } = frame;
    if (bbo === null || lay === null || gm.price === null) return;
    const cssW = gm.dims.cssW;
    const decimals = quoteDecimals(gm.price.tick ?? gm.price.step);
    const tag = bbo.source === 'l2' ? ' ·L2' : '';
    const emit = (side: { y: number } | null, price: number, sz: number, colorCss: string, key: string, cy: number): void => {
      if (side === null) return;
      const sizeText = formatSizeReadout(sz);
      const label = `${key} ${formatPrice(price, decimals)}${sizeText !== '' ? ` ×${sizeText}` : ''}${tag}`;
      text.badge(cssW - 3, cy, label, { align: 'right', color: colorCss, size: 10 }); // size-budget: dense price tag
    };
    emit(lay.ask, bbo.askPx, bbo.askSz, OVERLAY.ask.css, t('overlay.bbo.askSide'), lay.askCy);
    emit(lay.bid, bbo.bidPx, bbo.bidSz, OVERLAY.bid.css, t('overlay.bbo.bidSide'), lay.bidCy);
  }

  draw(frame: OverlayFrame): void {
    this.drawLines(frame);
    this.drawBadges(frame);
  }
}
