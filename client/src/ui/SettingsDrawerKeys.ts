/**
 * Which rows of the keyboard reference name a bare key. The single-key switch
 * (input/shortcutPrefs.ts) turns those off. Chords (Ctrl, Cmd, Alt) and named keys
 * (Esc, Del, the arrows, the pointer) keep working whichever way the switch is set.
 */

import type { KeysheetEntry } from './keysheet';

/**
 * True when a reference row's keys include one character, Space, or Shift with a
 * letter. The rows separate alternative keys with ' / ' (`+ / −`, `] / [`).
 */
export function isBareKeyRow(keys: KeysheetEntry['keys']): boolean {
  return keys.split(' / ').some((part) => {
    const token = part.trim();
    return token === 'Space' || /^Shift\+[A-Za-z]$/.test(token) || [...token].length === 1;
  });
}
