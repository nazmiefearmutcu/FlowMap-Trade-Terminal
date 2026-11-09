/**
 * Pure quote helpers for the watchlist panel: the live-quote pick from the book,
 * the price and change text, the row direction and the symbol half of a key.
 * No React here, so the honesty rules are unit-tested on their own.
 */

import type { BookSnapshot } from '../state/bookStore';
import { fmtPct, fmtPrice, sparkDirection } from './spark';

/**
 * Structural view of the quote payload from the shared quote feed. Kept locally
 * so this file compiles independently of the quoteFeed module's own type
 * exports; every field is widened so the feed's exact nullability stays
 * assignable.
 */
export interface WatchQuote {
  price?: number | null;
  changePct?: number | null;
  spark?: readonly number[] | null;
  stale?: boolean;
  reachable?: boolean;
}

export const LIVE_QUOTE_INTERVAL_MS = 100;
export const LIVE_QUOTE_STALE_MS = 5_000;

export interface ActiveWatchQuote {
  sessionKey: string;
  price: number;
  source: 'live-mid' | 'live-last';
  receivedAtMs: number;
  stale: boolean;
}

/** Raw BBO midpoint; grouped book rungs are deliberately never a quote source. */
export function activeWatchQuote(snap: BookSnapshot, sessionKey: string): ActiveWatchQuote | null {
  if (snap.sessionKey !== sessionKey) return null;
  const bbo = snap.bbo;
  if (bbo && bbo.bidPx > 0 && bbo.askPx >= bbo.bidPx
    && Number.isFinite(bbo.askPx) && typeof bbo.receivedAtMs === 'number') {
    return { sessionKey, price: bbo.bidPx + (bbo.askPx - bbo.bidPx) / 2,
      source: 'live-mid', receivedAtMs: bbo.receivedAtMs, stale: false };
  }
  const last = snap.trades[0];
  if (!last || last.venue === 'sim' || !(last.price > 0) || !Number.isFinite(last.price)
    || typeof last.receivedAtMs !== 'number') return null;
  return { sessionKey, price: last.price, source: 'live-last', receivedAtMs: last.receivedAtMs, stale: false };
}

/** `crypto:BTCUSDT` → `BTCUSDT` (labels are the symbol half). */
export function symbolOf(key: string): string {
  const i = key.indexOf(':');
  return i >= 0 && i < key.length - 1 ? key.slice(i + 1) : key;
}

/**
 * Row direction for colour: the spark's net direction decides first (spec),
 * then the signed `changePct` when the spark is flat/missing — the colour then
 * still agrees with the number printed next to it.
 */
export function quoteDirection(q: WatchQuote | undefined): 'up' | 'down' | 'flat' {
  if (!q) return 'flat';
  const dir = sparkDirection(q.spark ?? []);
  if (dir > 0) return 'up';
  if (dir < 0) return 'down';
  const chg = q.changePct;
  if (typeof chg === 'number' && Number.isFinite(chg) && chg !== 0) {
    return chg > 0 ? 'up' : 'down';
  }
  return 'flat';
}

/** Price text: em-dash when absent OR unreachable — never a fabricated number. */
export function quotePriceText(q: WatchQuote | undefined): string {
  if (!q || q.reachable === false || typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0) return '—';
  return fmtPrice(q.price);
}

/** Change text, same honesty rule as {@link quotePriceText}. */
export function quoteChangeText(q: WatchQuote | undefined): string {
  if (quotePriceText(q) === '—') return '—';
  if (!q) return '—';
  return fmtPct(q.changePct);
}
