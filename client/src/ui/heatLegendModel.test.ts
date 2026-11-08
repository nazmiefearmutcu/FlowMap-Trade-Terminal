import { describe, expect, it } from 'vitest';

import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE } from '../proto/types';
import { depthIsSynthetic, depthReadoutTier } from './heatLegendModel';

describe('depthIsSynthetic', () => {
  it('treats a capability the server marks synthetic as synthetic, whatever its tier', () => {
    expect(depthIsSynthetic({ synthetic: true, depth: 'L2' }, MODE_L2)).toBe(true);
  });

  it('reads a live real-depth capability as real', () => {
    expect(depthIsSynthetic({ depth: 'L2' }, MODE_L2)).toBe(false);
  });

  it('falls back to the book mode when the capability names no tier', () => {
    expect(depthIsSynthetic(null, MODE_SYNTH_PROFILE)).toBe(true);
    expect(depthIsSynthetic(null, MODE_L2)).toBe(false);
  });

  it('a replay without recorded-density provenance is synthetic, as on the renderer ramp', () => {
    expect(depthIsSynthetic({ depth: 'L2', playback: {} }, MODE_L2)).toBe(true);
    expect(depthIsSynthetic({ depth: 'L2', playback: {}, depth_provenance: 'recorded-density' }, MODE_L2)).toBe(false);
  });
});

describe('depthReadoutTier', () => {
  it('labels a polled venue snapshot L2-SNAPSHOT even inside an L2 book, never plain L2', () => {
    expect(depthReadoutTier({ depth: 'L2-snapshot' }, MODE_L2)).toBe('L2-SNAPSHOT');
  });

  it('labels native depth by its tier and an L1 band as L1', () => {
    expect(depthReadoutTier({ depth: 'L2' }, MODE_L2)).toBe('L2');
    expect(depthReadoutTier({ depth: 'L1_BAND' }, MODE_L1_BAND)).toBe('L1');
  });

  it('labels synthetic depth SYNTH, including a recording that is not marked recorded-density', () => {
    expect(depthReadoutTier({ depth: 'SYNTH', playback: {} }, null)).toBe('SYNTH');
    expect(depthReadoutTier({ depth: 'L2', playback: {} }, MODE_L2)).toBe('SYNTH');
  });

  it('keeps a keyless recording SYNTH even when it carries recorded-density provenance', () => {
    const replayedSynth = { depth: 'SYNTH', depth_provenance: 'recorded-density', playback: {} };
    expect(depthIsSynthetic(replayedSynth, null)).toBe(true);
    expect(depthReadoutTier(replayedSynth, null)).toBe('SYNTH');
  });

  it('keeps the real tier of a recorded-density replay of native depth', () => {
    expect(depthReadoutTier({ depth: 'L2', depth_provenance: 'recorded-density', playback: {} }, MODE_L2)).toBe('L2');
  });

  it('is null when nothing names a tier', () => {
    expect(depthReadoutTier(null, null)).toBeNull();
  });
});
