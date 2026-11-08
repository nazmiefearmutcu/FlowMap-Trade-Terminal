import { describe, expect, it } from 'vitest';

import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE } from '../proto/types';
import { depthTier, isRecordedDensity } from './DomLadderTier';

describe('depthTier — the honest badge for the ladder, legend, crosshair and measure', () => {
  it('a ccxt snapshot book never reads as native L2, even under a book mode of L2', () => {
    expect(depthTier({ depth: 'L2-snapshot' }, MODE_L2)).toBe('L2-SNAPSHOT');
  });

  it('an unrecognised tier makes no claim and does not borrow the book mode', () => {
    expect(depthTier({ depth: 'UNKNOWN' }, MODE_L2)).toBeNull();
    expect(depthTier({ depth: 'N/A' }, MODE_L1_BAND)).toBeNull();
  });

  it('falls back to the book mode only when the capability names no tier', () => {
    expect(depthTier(null, MODE_L2)).toBe('L2');
    expect(depthTier({}, MODE_L1_BAND)).toBe('L1');
    expect(depthTier({}, MODE_SYNTH_PROFILE)).toBe('SYNTH');
    expect(depthTier(null, null)).toBeNull();
  });

  it('maps the recognised tiers', () => {
    expect(depthTier({ depth: 'L2' }, null)).toBe('L2');
    expect(depthTier({ depth: 'L1' }, null)).toBe('L1');
    expect(depthTier({ depth: 'L1_BAND' }, null)).toBe('L1');
    expect(depthTier({ depth: 'SYNTH' }, null)).toBe('SYNTH');
    expect(depthTier({ depth: 'SYNTH_PROFILE' }, null)).toBe('SYNTH');
  });

  it('a replay without recorded provenance reads SYNTH whatever its tier says', () => {
    expect(depthTier({ depth: 'L2', playback: { speed: 1 } }, MODE_L2)).toBe('SYNTH');
  });

  it('a recorded replay keeps its real tier', () => {
    const recorded = { depth: 'L2-snapshot', playback: { speed: 1 }, depth_provenance: 'recorded-density' };
    expect(depthTier(recorded, MODE_L2)).toBe('L2-SNAPSHOT');
  });
});

describe('isRecordedDensity', () => {
  it('is true only for the recorded-density provenance', () => {
    expect(isRecordedDensity({ depth_provenance: 'recorded-density' })).toBe(true);
    expect(isRecordedDensity({ depth_provenance: 'native' })).toBe(false);
    expect(isRecordedDensity(null)).toBe(false);
  });
});
