import { describe, expect, it } from 'vitest';
import { honestDepthTier, replayDepthChip } from './depthTier';
import { rampForMode, RAMP_FLOW, RAMP_SYNTH } from './lut';
import { MODE_L2 } from '../proto/types';

const PLAYBACK = { start_ns: '1', end_ns: '2', position_ns: '1', paused: false, ended: false, speed: 1, columns: 1, generation: 0 };

describe('honestDepthTier', () => {
  it('passes a live capability through unchanged', () => {
    expect(honestDepthTier({ depth: 'L2' })).toBe('L2');
    expect(honestDepthTier({ depth: 'SYNTH' })).toBe('SYNTH');
    expect(honestDepthTier(null)).toBeUndefined();
    expect(honestDepthTier(undefined)).toBeUndefined();
  });

  it('ignores the replay-capable badge that every live session carries', () => {
    expect(honestDepthTier({ depth: 'L2', replay: true })).toBe('L2');
    expect(rampForMode(MODE_L2, honestDepthTier({ depth: 'L2', replay: true }))).toBe(RAMP_FLOW);
  });

  it('keeps a recorded real-density replay at its recorded tier', () => {
    const cap = { depth: 'L2', replay: true, playback: PLAYBACK, depth_provenance: 'recorded-density' };
    expect(honestDepthTier(cap)).toBe('L2');
  });

  it('does not let a replay without recorded-density claim real depth', () => {
    expect(honestDepthTier({ depth: 'L2', replay: true, playback: PLAYBACK })).toBe('SYNTH');
    expect(honestDepthTier({ depth: 'L2', playback: PLAYBACK, depth_provenance: 'synthetic' })).toBe('SYNTH');
  });

  it('keeps a replayed SYNTH recording on the synthetic ramp', () => {
    const tier = honestDepthTier({ depth: 'SYNTH', playback: PLAYBACK, depth_provenance: 'recorded-density' });
    expect(rampForMode(MODE_L2, tier)).toBe(RAMP_SYNTH);
  });

  it('a replay without recorded-density is drawn on the synthetic ramp, not the real-depth ramp', () => {
    const tier = honestDepthTier({ depth: 'L2', playback: PLAYBACK });
    expect(rampForMode(MODE_L2, tier)).toBe(RAMP_SYNTH);
    expect(rampForMode(MODE_L2, honestDepthTier({ depth: 'L2' }))).toBe(RAMP_FLOW);
  });
});

describe('replayDepthChip', () => {
  it('labels a replayed SYNTH recording synthetic, never recorded density', () => {
    const cap = { depth: 'SYNTH', depth_provenance: 'recorded-density', playback: PLAYBACK };
    expect(replayDepthChip(cap)).toBe('synthetic');
    expect(rampForMode(MODE_L2, honestDepthTier(cap))).toBe(RAMP_SYNTH);
  });

  it('labels a replayed real-depth recording as recorded density', () => {
    const cap = { depth: 'L2-snapshot', depth_provenance: 'recorded-density', playback: PLAYBACK };
    expect(replayDepthChip(cap)).toBe('recordedDensity');
    expect(rampForMode(MODE_L2, honestDepthTier(cap))).toBe(RAMP_FLOW);
  });

  it('labels a replay without recorded-density provenance synthetic', () => {
    expect(replayDepthChip({ depth: 'L2', playback: PLAYBACK })).toBe('synthetic');
  });

  it('labels a synthetic-flagged replay synthetic whatever its depth tier', () => {
    const cap = { depth: 'L2', synthetic: true, depth_provenance: 'recorded-density', playback: PLAYBACK };
    expect(replayDepthChip(cap)).toBe('synthetic');
    expect(honestDepthTier(cap)).toBe('SYNTH');
  });

  it('shows no provenance chip for a live feed or a missing capability', () => {
    expect(replayDepthChip({ depth: 'L2', replay: true })).toBeNull();
    expect(replayDepthChip(null)).toBeNull();
    expect(replayDepthChip(undefined)).toBeNull();
  });

  it('shows no provenance chip for a replay tier that is neither synthetic nor real', () => {
    expect(replayDepthChip({ depth: 'UNKNOWN', depth_provenance: 'recorded-density', playback: PLAYBACK })).toBeNull();
  });
});
