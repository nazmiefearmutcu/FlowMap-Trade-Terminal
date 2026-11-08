import { describe, expect, it } from 'vitest';

import { fmtStreamClock } from './streamClock';

describe('fmtStreamClock', () => {
  it('formats a nanosecond timestamp as UTC HH:MM:SS', () => {
    expect(fmtStreamClock(0n)).toBe('00:00:00');
    expect(fmtStreamClock(3_723_000_000_000n)).toBe('01:02:03');
  });

  it('returns null for a value the Date range cannot represent', () => {
    expect(fmtStreamClock(10n ** 30n)).toBeNull();
  });
});
