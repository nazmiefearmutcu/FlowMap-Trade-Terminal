import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tFor } from '../i18n';
import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  resetWatchlistForTest,
  setWatchlistStorage,
  type StorageLike,
} from './store';

type ToastWindow = { __flowmapToast?: (msg: string) => void };

/** A storage whose every write fails, like a full quota. */
function failingStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };
}

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let toasts: string[];

beforeEach(() => {
  toasts = [];
  (window as unknown as ToastWindow).__flowmapToast = (msg) => void toasts.push(msg);
  resetWatchlistForTest();
});

afterEach(() => {
  delete (window as unknown as ToastWindow).__flowmapToast;
  resetWatchlistForTest();
});

describe('watchlist save failure', () => {
  it('keeps the favourite for the session and tells the user once', () => {
    setWatchlistStorage(failingStorage());
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(getWatchlist()).toEqual(['sim:A']);
    expect(toasts).toEqual([tFor('en', 'watchlist.saveFailed')]);

    // A later failed write in the same session does not repeat the notice.
    expect(addToWatchlist('sim:B')).toBe(true);
    expect(removeFromWatchlist('sim:A')).toBe(true);
    expect(toasts).toHaveLength(1);
  });

  it('stays silent when the list is saved', () => {
    setWatchlistStorage(memStorage());
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(toasts).toEqual([]);
  });

  it('never lets a broken toast hook break a favourite toggle', () => {
    (window as unknown as ToastWindow).__flowmapToast = () => {
      throw new Error('toaster down');
    };
    setWatchlistStorage(failingStorage());
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(getWatchlist()).toEqual(['sim:A']);
  });
});
