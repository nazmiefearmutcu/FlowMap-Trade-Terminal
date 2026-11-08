/**
 * The colormap catalog's labels. The picker localizes every option whose name is
 * an English word through an i18n key, and every hint through `palette.<hint>`.
 * Those lookups are dynamic, so the coverage scan of literal `t('key')` calls
 * cannot see them; this test walks the catalog instead.
 */
import { describe, expect, it } from 'vitest';

import { en } from '../i18n/en';
import { tr } from '../i18n/tr';
import { COLORMAP_CATALOG } from './colormaps';

const named = COLORMAP_CATALOG.flatMap((option) => (option.nameKey ? [{ id: option.id, key: option.nameKey }] : []));
const hints = [...new Set(COLORMAP_CATALOG.map((option) => `palette.${option.hint}`))];

describe('colormap option names', () => {
  it('leaves only the scientific names in English', () => {
    expect(COLORMAP_CATALOG.filter((option) => option.nameKey === null).map((option) => option.id)).toEqual([
      'inferno',
      'viridis',
      'cividis',
    ]);
  });

  it.each(named)('$id name resolves to a string in English and Turkish', ({ key }) => {
    expect(en[key], `${key} in en`).toBeTruthy();
    expect(tr[key], `${key} in tr`).toBeTruthy();
  });

  it.each(named)('$id name is translated, not copied from English, in Turkish', ({ key }) => {
    expect(tr[key], key).not.toBe(en[key]);
  });
});

describe('colormap option hints', () => {
  it.each(hints)('%s resolves in English and Turkish', (key) => {
    expect(en[key], `${key} in en`).toBeTruthy();
    expect(tr[key], `${key} in tr`).toBeTruthy();
  });
});
