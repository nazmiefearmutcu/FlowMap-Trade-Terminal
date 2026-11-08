import { describe, expect, it } from 'vitest';

import { KEYSHEET } from './keysheet';
import { isBareKeyRow } from './SettingsDrawerKeys';

describe('isBareKeyRow — the rows the single-key switch turns off', () => {
  it('flags every reference row that names a character key or Space', () => {
    const bare = KEYSHEET.filter((entry) => isBareKeyRow(entry.keys)).map((entry) => entry.keys);
    expect(bare).toEqual([
      'Space', '/', 'E', 'M', 'A', 'H', 'C', 'T', 'D', 'I', 'J', '?', '+ / −', '] / [', 'F', 'P', 'Shift+P', 'R',
    ]);
  });

  it('leaves chords, named keys, arrows and pointer rows working', () => {
    for (const keys of ['⌘K / Ctrl+K', 'Ctrl+Z', 'Del', 'Esc', '← → ↑ ↓', 'axis wheel / drag']) {
      expect(isBareKeyRow(keys), keys).toBe(false);
    }
  });
});
