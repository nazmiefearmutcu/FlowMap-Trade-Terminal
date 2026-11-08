/**
 * Single-character shortcut preference (WCAG 2.1.4, "character key shortcuts").
 *
 * The app-wide bare-key shortcuts (Space, `/`, `E`, `M`, `A`, `H`, `C`, `J`,
 * `F`, `P`, `R`, `T`, `?`) can be switched off here so a speech-input user or
 * anyone who types a shortcut by accident is not interrupted. Chords (Ctrl,
 * Meta or Alt combinations) are never affected by this switch.
 *
 * The preference has its own localStorage key, so the key router can read it
 * without depending on the settings store. It defaults to ON: only the explicit
 * off marker disables the shortcuts. Storage being unavailable keeps the default.
 */

import { useSyncExternalStore } from 'react';

import { safeLocalStorage } from '../state/safeStorage';

export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'flowmap.singleKeyShortcuts';

/** Parse a stored value. Only the explicit off marker `'0'` disables the shortcuts. */
export function parseSingleKeyShortcuts(stored: string | null | undefined): boolean {
  return stored !== '0';
}

function readStored(): string | null {
  try {
    return safeLocalStorage()?.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

let enabled = parseSingleKeyShortcuts(readStored());
const listeners = new Set<() => void>();

/** Whether bare-key (single character) shortcuts are active right now. */
export function isSingleKeyShortcutsEnabled(): boolean {
  return enabled;
}

/** Turn bare-key shortcuts on or off, persist the choice, and notify subscribers. */
export function setSingleKeyShortcutsEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    safeLocalStorage()?.setItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* quota or blocked storage: the choice stays for this session */
  }
  listeners.forEach((listener) => listener());
}

/** Subscribe to changes of the preference. Returns the disposer. */
export function subscribeSingleKeyShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders the caller when the preference changes. */
export function useSingleKeyShortcuts(): boolean {
  return useSyncExternalStore(subscribeSingleKeyShortcuts, isSingleKeyShortcutsEnabled);
}
