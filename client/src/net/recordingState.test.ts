import { describe, expect, it } from 'vitest';

import { RECORDING_DEGRADED_KEY, RECORDING_HEALTH_KEY, RECORDING_WEDGED, recordingDegraded } from './recordingState';

describe('recordingDegraded', () => {
  it('is true when the capability reports the wedged writer', () => {
    expect(recordingDegraded({ [RECORDING_HEALTH_KEY]: RECORDING_WEDGED })).toBe(true);
  });

  it('is true when the capability sets the explicit degraded flag', () => {
    expect(recordingDegraded({ [RECORDING_DEGRADED_KEY]: true })).toBe(true);
  });

  it('is false for a healthy, absent or malformed value', () => {
    expect(recordingDegraded({})).toBe(false);
    expect(recordingDegraded(null)).toBe(false);
    expect(recordingDegraded(undefined)).toBe(false);
    expect(recordingDegraded({ [RECORDING_HEALTH_KEY]: 'ok' })).toBe(false);
    expect(recordingDegraded({ [RECORDING_HEALTH_KEY]: true })).toBe(false);
    expect(recordingDegraded({ [RECORDING_DEGRADED_KEY]: 'true' })).toBe(false);
    expect(recordingDegraded({ [RECORDING_DEGRADED_KEY]: false })).toBe(false);
  });
});
