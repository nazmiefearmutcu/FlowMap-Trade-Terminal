import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSingleKeyShortcutsEnabled,
  parseSingleKeyShortcuts,
  setSingleKeyShortcutsEnabled,
  SINGLE_KEY_SHORTCUTS_STORAGE_KEY,
  subscribeSingleKeyShortcuts,
} from './shortcutPrefs';

describe('parseSingleKeyShortcuts', () => {
  it('defaults to enabled when nothing is stored', () => {
    expect(parseSingleKeyShortcuts(null)).toBe(true);
    expect(parseSingleKeyShortcuts(undefined)).toBe(true);
  });

  it('is disabled only by the explicit off marker', () => {
    expect(parseSingleKeyShortcuts('0')).toBe(false);
    expect(parseSingleKeyShortcuts('1')).toBe(true);
    expect(parseSingleKeyShortcuts('garbage')).toBe(true);
  });
});

describe('setSingleKeyShortcutsEnabled', () => {
  afterEach(() => {
    setSingleKeyShortcutsEnabled(true);
  });

  it('persists the choice, notifies subscribers on a change only, and stops after dispose', () => {
    setSingleKeyShortcutsEnabled(true);
    const listener = vi.fn();
    const dispose = subscribeSingleKeyShortcuts(listener);

    setSingleKeyShortcutsEnabled(false);
    expect(isSingleKeyShortcutsEnabled()).toBe(false);
    expect(window.localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY)).toBe('0');
    expect(listener).toHaveBeenCalledTimes(1);

    setSingleKeyShortcutsEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);

    dispose();
    setSingleKeyShortcutsEnabled(true);
    expect(isSingleKeyShortcutsEnabled()).toBe(true);
    expect(window.localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY)).toBe('1');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
