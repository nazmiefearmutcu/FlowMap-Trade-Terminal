/**
 * The watchlist's default storage goes through the one guarded accessor the rest
 * of the shell uses: a `window.localStorage` read that throws must not
 * take the list down, and a healthy profile must persist through the same path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ storage: null as unknown }));

vi.mock('../state/safeStorage', () => ({
  safeLocalStorage: () => probe.storage,
}));

import { WATCHLIST_KEY, addToWatchlist, getWatchlist, resetWatchlistForTest } from './store';

describe('watchlist default storage', () => {
  beforeEach(() => {
    resetWatchlistForTest();
  });

  it('persists through the shared safeLocalStorage accessor', () => {
    const map = new Map<string, string>();
    probe.storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(map.get(WATCHLIST_KEY)).toBe(JSON.stringify(['sim:A']));
  });

  it('stays session-local when the shared accessor reports no storage', () => {
    probe.storage = null;
    expect(addToWatchlist('sim:B')).toBe(true);
    expect(getWatchlist()).toEqual(['sim:B']);
  });
});
