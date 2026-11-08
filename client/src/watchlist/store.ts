/**
 * Watchlist store — a plain module-scoped favorites list
 * OUTSIDE React (the alertsStore pattern), persisted to localStorage under the
 * key `flowmap.watchlist.v1`.
 *
 * Shape: keys are the composite `market:symbol` strings used everywhere else
 * (palette, recents, alerts), stored as a plain JSON string array in APPEND
 * order. Discipline:
 *   - at most {@link WATCHLIST_CAP} entries; an add beyond the cap is REFUSED
 *     (returns false) rather than silently evicting a user's favorite,
 *   - exact-string dedupe ("case as stored" — keys are persisted verbatim),
 *   - order is stable: adds append, removes splice; nothing reorders,
 *   - load is a total coercion over an arbitrary parsed blob — a corrupted or
 *     foreign payload degrades to an empty list, never throws
 *     (the ui/settings.ts `normalizeSettings` style).
 *
 * React consumes it via `useSyncExternalStore(subscribeWatchlist, getWatchlist)`
 * (the exported `useWatchlist()` hook); the snapshot identity is stable between
 * mutations so subscribers only re-render on a real change.
 */

import { useSyncExternalStore } from 'react';

import { t } from '../i18n';
import { safeLocalStorage } from '../state/safeStorage';

/** localStorage key. Saved favorites live under this name, so it must not change. */
export const WATCHLIST_KEY = 'flowmap.watchlist.v1';
/** Max favorites retained. */
export const WATCHLIST_CAP = 30;

/** Minimal Web-Storage subset (mirrors ui/settings.ts / state/alertsStore.ts). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** A valid key is `market:symbol` with both halves non-empty. */
export function isValidWatchKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const i = key.indexOf(':');
  return i > 0 && i < key.length - 1;
}

/**
 * Coerce an arbitrary parsed blob into a valid favorites list: strings only,
 * valid `market:symbol` keys only, first occurrence wins, capped at
 * {@link WATCHLIST_CAP}. Never throws.
 */
export function normalizeWatchlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!isValidWatchKey(item)) continue;
    if (out.includes(item)) continue; // exact-string dedupe, order preserved
    out.push(item);
    if (out.length >= WATCHLIST_CAP) break;
  }
  return out;
}

/** Read + normalize the persisted list (missing/corrupt → empty; never throws). */
export function loadWatchlist(storage: StorageLike | null | undefined): string[] {
  if (!storage) return [];
  let text: string | null = null;
  try {
    text = storage.getItem(WATCHLIST_KEY);
  } catch {
    return []; // private-mode / disabled storage: the list is a nicety, not a need
  }
  if (!text) return [];
  try {
    return normalizeWatchlist(JSON.parse(text));
  } catch {
    return []; // corrupted payload — degrade to empty, never render junk
  }
}

/**
 * Persist the list. Returns true when it was written; false when there is no
 * storage or the write failed (quota, serialization). The list still works for
 * the session either way, so the caller decides how to tell the user.
 */
export function saveWatchlist(
  storage: StorageLike | null | undefined,
  keys: readonly string[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WATCHLIST_KEY, JSON.stringify(keys.slice(0, WATCHLIST_CAP)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The default storage (browser localStorage), resolved lazily. A denied profile
 * (privacy mode, blocked site data) reads as null, so the list stays session-local
 * through the one guarded accessor shared with the other boot-time readers.
 */
function defaultStorage(): StorageLike | null {
  return safeLocalStorage();
}

let storage: StorageLike | null | undefined;
let keys: string[] | null = null; // lazy: loaded from storage on first touch
const listeners = new Set<() => void>();
/** The save-failure notice is shown once per page session, then stays quiet. */
let saveFailureNotified = false;

function getStorage(): StorageLike | null {
  if (storage === undefined) storage = defaultStorage();
  return storage;
}

function current(): string[] {
  if (keys === null) keys = loadWatchlist(getStorage());
  return keys;
}

/** Persist the current list; a failed save tells the user once per session. */
function persist(): void {
  if (saveWatchlist(getStorage(), current())) return;
  notifySaveFailure();
}

/**
 * Tell the user, once per page session, that favourites will not survive a
 * reload. Goes through the shared toast hook (`window.__flowmapToast`), as the
 * alert store does; the hook is optional, so the notice is best-effort.
 */
function notifySaveFailure(): void {
  if (saveFailureNotified) return;
  saveFailureNotified = true;
  if (typeof window === 'undefined') return;
  try {
    window.__flowmapToast?.(t('watchlist.saveFailed'));
  } catch {
    /* the notice itself must never break a favourite toggle */
  }
}

function bump(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a broken subscriber must never break the store */
    }
  }
}

// --- reads -----------------------------------------------------------------------

/**
 * The favorites list, in append order. Stable identity between mutations —
 * safe as a `useSyncExternalStore` snapshot.
 */
export function getWatchlist(): readonly string[] {
  return current();
}

/** Register a change listener; returns an unsubscribe fn. */
export function subscribeWatchlist(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** true when `key` is favorited (invalid keys are never members). */
export function isWatchlisted(key: string): boolean {
  return isValidWatchKey(key) && current().includes(key);
}

// --- mutations -------------------------------------------------------------------

/**
 * Add `key` at the end of the list. Returns true when it was added; false for
 * an invalid key, an existing member, or a FULL list (the cap is an honest
 * refusal — never a silent eviction of another favorite).
 */
export function addToWatchlist(key: string): boolean {
  if (!isValidWatchKey(key)) return false;
  const list = current();
  if (list.includes(key)) return false;
  if (list.length >= WATCHLIST_CAP) return false;
  keys = [...list, key];
  persist();
  bump();
  return true;
}

/** Remove `key`; true when it was present. Order of the rest is untouched. */
export function removeFromWatchlist(key: string): boolean {
  const list = current();
  const idx = list.indexOf(key);
  if (idx < 0) return false;
  keys = list.slice(0, idx).concat(list.slice(idx + 1));
  persist();
  bump();
  return true;
}

/** Toggle membership; returns the NEW membership state. */
export function toggleWatchlist(key: string): boolean {
  if (isWatchlisted(key)) {
    removeFromWatchlist(key);
    return false;
  }
  return addToWatchlist(key);
}

// --- React binding ---------------------------------------------------------------

/**
 * React hook over the store; the component re-renders only on real changes.
 * (React is already a dependency; no store library involved.)
 */
export function useWatchlist(): readonly string[] {
  return useSyncExternalStore(subscribeWatchlist, getWatchlist, getWatchlist);
}

// --- test seams ------------------------------------------------------------------

/** Inject a storage double (or null to disable persistence). Unit tests only. */
export function setWatchlistStorage(s: StorageLike | null): void {
  storage = s;
}

/** Reset all in-memory state (NOT storage contents). Unit tests only. */
export function resetWatchlistForTest(): void {
  keys = null;
  storage = undefined;
  saveFailureNotified = false;
  listeners.clear();
}
