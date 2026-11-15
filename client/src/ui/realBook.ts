/**
 * The real order book a synthetic instrument points at: the `real_book` entry of the session's
 * capability, read defensively. The server names it only for an instrument drawn as a
 * synthetic profile whose underlying has a real public book on another venue it streams
 * (server data/real_books.py). It is that venue's own instrument, and the link says so.
 */

export interface RealBook {
  market: string;
  symbol: string;
  /** What the venue's instrument is: its spot market, or a perpetual contract. */
  kind: 'spot' | 'perpetual';
}

const MARKET = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._\-/:=^+!]{0,63}$/;

/** The capability's real book, or null when it names none or names it malformed. */
export function realBookOf(capability: Record<string, unknown> | null | undefined): RealBook | null {
  const raw = capability?.real_book;
  if (typeof raw !== 'object' || raw === null) return null;
  const { market, symbol, kind } = raw as { market?: unknown; symbol?: unknown; kind?: unknown };
  if (typeof market !== 'string' || typeof symbol !== 'string') return null;
  if (!MARKET.test(market) || !SYMBOL.test(symbol)) return null;
  if (kind !== 'spot' && kind !== 'perpetual') return null;
  return { market, symbol, kind };
}
