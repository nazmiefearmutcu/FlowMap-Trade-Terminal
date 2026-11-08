import { describe, expect, it } from 'vitest';

import { REFUSAL_REASON_UNKNOWN_KEY, refusalReasonKey } from './refusalReason';

describe('refusalReasonKey', () => {
  it('returns null when the server gave no reason', () => {
    expect(refusalReasonKey(null)).toBeNull();
    expect(refusalReasonKey('')).toBeNull();
  });

  it('maps the invalid_symbol token to its own explanation key', () => {
    expect(refusalReasonKey('invalid_symbol')).toBe('banner.refusalReason.invalidSymbol');
  });

  it('maps an unknown token to the generic key, never echoing the raw token', () => {
    expect(refusalReasonKey('some_new_code')).toBe(REFUSAL_REASON_UNKNOWN_KEY);
    expect(refusalReasonKey('constructor')).toBe(REFUSAL_REASON_UNKNOWN_KEY);
  });
});
