import { loadRecents, type RecentPick } from './recents';

export const ACTIVE_SYMBOL_KEY = 'flowmap.active-symbol.v1';
const DEMO: RecentPick = { market: 'sim', symbol: 'SIM-DEMO' };

function valid(pick: unknown): pick is RecentPick {
  if (!pick || typeof pick !== 'object') return false;
  const p = pick as RecentPick;
  return typeof p.market === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(p.market)
    && typeof p.symbol === 'string' && p.symbol.length > 0 && p.symbol.length <= 128
    && !/[\x00-\x1f\x7f]/.test(p.symbol);
}

/**
 * A `?symbol=market:SYMBOL` deep link (a shared URL, or a desktop launch that
 * names an instrument), validated exactly like a saved pick. Null when the
 * parameter is absent or malformed, so a bad link is ignored silently.
 */
export function symbolFromSearch(search: string | undefined): RecentPick | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('symbol');
  } catch {
    return null;
  }
  if (!raw) return null;
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const pick = { market: raw.slice(0, colon), symbol: raw.slice(colon + 1) };
  return valid(pick) ? pick : null;
}

/**
 * The instrument to open at boot: a `?symbol=` deep link first (this session
 * only, not persisted), then the saved pick, then recents, then the demo.
 */
export function loadStartupSymbol(storage: Storage | null, search?: string): RecentPick {
  const fromUrl = symbolFromSearch(search);
  if (fromUrl !== null) return fromUrl;
  try {
    const raw = storage?.getItem(ACTIVE_SYMBOL_KEY);
    if (raw) {
      const pick: unknown = JSON.parse(raw);
      if (valid(pick)) return pick;
    }
  } catch { /* unavailable storage uses recents or the explicit demo */ }
  const recent = loadRecents(storage).find(valid);
  return recent ?? DEMO;
}

export function saveStartupSymbol(storage: Storage | null, market: string, symbol: string): void {
  const pick = { market, symbol };
  if (!valid(pick)) return;
  try { storage?.setItem(ACTIVE_SYMBOL_KEY, JSON.stringify(pick)); } catch { /* best effort */ }
}
