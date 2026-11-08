/**
 * The shared keyboard reference: every binding the keys router really handles
 * is listed, and every row resolves in both locale tables.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { en } from '../i18n/en';
import { tFor, setLocale, t } from '../i18n';
import { tr } from '../i18n/tr';
import { THEME_IDS } from '../theme/registry';
import { KEYSHEET, themeNamesLine } from './keysheet';
import { keyCapKey } from './keysheetList';

afterEach(() => {
  setLocale('en');
});

describe('keysheet theme sentence', () => {
  // The T row's sentence is generated from the theme registry names, so a rename
  // in the settings drawer's theme names reaches the shortcut sentence too.
  it.each([
    ['en', en],
    ['tr', tr],
  ] as const)('names every theme as the drawer shows it (%s)', (locale, table) => {
    const sentence = tFor(locale, 'keysheet.theme');
    expect(sentence).not.toContain('{themes}');
    for (const id of THEME_IDS) {
      expect(sentence, `theme ${id}`).toContain(table[`theme.${id}.name`]);
    }
  });

  it('lists the themes in registry order, joined with arrows, in the active locale', () => {
    expect(themeNamesLine('en')).toBe(
      'Midnight → Paper → Studio → Amber → Deep sea → Daylight → High contrast',
    );
    expect(themeNamesLine('tr')).toBe(
      'Gece yarısı → Parşömen → Stüdyo → Kehribar → Derin deniz → Gün ışığı → Yüksek kontrast',
    );
    setLocale('tr');
    expect(t('keysheet.theme')).toBe(`renk temasını değiştir: ${themeNamesLine('tr')}`);
  });
});

describe('KEYSHEET', () => {
  it('lists the chord, the Shift+P re-fit, and the intelligence toggle as their own rows', () => {
    const keys = KEYSHEET.map((entry) => entry.keys);
    expect(keys).toContain('⌘K / Ctrl+K');
    expect(keys).toContain('Shift+P');
    expect(keys).toContain('J');
  });

  it('lists the bracket keys that zoom the price axis from the chart canvas', () => {
    expect(KEYSHEET.map((entry) => entry.keys)).toContain('] / [');
  });

  it('resolves every row in both the English and Turkish tables', () => {
    for (const entry of KEYSHEET) {
      expect(en[entry.actionKey], `en ${entry.actionKey}`).toBeDefined();
      expect(tr[entry.actionKey], `tr ${entry.actionKey}`).toBeDefined();
    }
  });

  it('translates the key names Turkish reads differently and keeps the rest', () => {
    const labelled = KEYSHEET.map((entry) => entry.keys).filter((keys) => keyCapKey(keys) !== null);
    expect(labelled).toEqual(['Space', 'Del', 'axis wheel / drag']);
    for (const keys of labelled) {
      const key = keyCapKey(keys)!;
      expect(en[key], `en ${key}`).toBeDefined();
      expect(tr[key], `tr ${key}`).toBeDefined();
      expect(tFor('tr', key), `tr label for ${keys}`).not.toBe(keys);
    }
    expect(tFor('tr', 'keysheet.keyCap.space')).toBe('Boşluk');
    expect(keyCapKey('Esc')).toBeNull();
  });
});
