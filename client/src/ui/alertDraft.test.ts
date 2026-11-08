import { describe, expect, it } from 'vitest';

import { draftPrice } from './alertDraft';

describe('draftPrice (the add-alert input)', () => {
  it('reads a typed level', () => {
    expect(draftPrice('60000.5')).toBe(60000.5);
  });

  it('is null for an empty or blank draft (Number("") is 0, which is not a level)', () => {
    expect(draftPrice('')).toBeNull();
    expect(draftPrice('   ')).toBeNull();
  });

  it('is null for zero, negative, non-numeric and non-finite drafts', () => {
    for (const draft of ['0', '-3', 'abc', 'Infinity']) {
      expect(draftPrice(draft)).toBeNull();
    }
  });
});
