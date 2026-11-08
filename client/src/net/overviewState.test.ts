import { describe, expect, it } from 'vitest';

import { OVERVIEW_DEGRADED_KEY, overviewDegraded } from './overviewState';

describe('overviewDegraded', () => {
  it('is true when the capability sets the overview flag', () => {
    expect(overviewDegraded({ [OVERVIEW_DEGRADED_KEY]: true })).toBe(true);
  });

  it('is false for an absent, healthy or malformed value', () => {
    expect(overviewDegraded({})).toBe(false);
    expect(overviewDegraded(null)).toBe(false);
    expect(overviewDegraded(undefined)).toBe(false);
    expect(overviewDegraded({ [OVERVIEW_DEGRADED_KEY]: false })).toBe(false);
    expect(overviewDegraded({ [OVERVIEW_DEGRADED_KEY]: 'true' })).toBe(false);
  });
});
