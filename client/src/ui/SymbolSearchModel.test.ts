import { describe, expect, it } from 'vitest';

import { capabilityChipLabel } from './SymbolSearchModel';

/** A translator that names the key it was asked for, so the test sees which label was chosen. */
const keyed = (key: string): string => `[${key}]`;

describe('capabilityChipLabel', () => {
  it('translates the visible words of the provenance and side chips', () => {
    expect(capabilityChipLabel('RECORDED DENSITY', keyed)).toBe('[chip.recordedDensity]');
    expect(capabilityChipLabel('SIDE INFERRED', keyed)).toBe('[chip.sideInferred]');
    expect(capabilityChipLabel('SIDE NA', keyed)).toBe('[chip.sideNone]');
    expect(capabilityChipLabel('TAPE POLL', keyed)).toBe('[chip.tapePoll]');
  });

  it('translates the no-claim tokens', () => {
    expect(capabilityChipLabel('N/A', keyed)).toBe('[chip.none]');
    expect(capabilityChipLabel('UNKNOWN', keyed)).toBe('[chip.unknown]');
  });

  it('shows depth tiers and other tokens as they are', () => {
    for (const token of ['L2', 'L1', 'SYNTH', 'L2-SNAPSHOT', 'SIM', 'TAPE TICK']) {
      expect(capabilityChipLabel(token, keyed)).toBe(token);
    }
  });
});
