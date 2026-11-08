import { describe, expect, it } from 'vitest';
import { PartialDepthGate, type PartialColumn } from './partialGate';

function col(over: Partial<PartialColumn> = {}): PartialColumn {
  return {
    epoch: 1,
    col_seq: 10,
    t0_ns: 1_000n,
    final: false,
    bid: Float32Array.from([1, 2, 3]),
    ask: Float32Array.from([4, 5, 6]),
    ...over,
  };
}

describe('PartialDepthGate', () => {
  it('does not skip the first partial a ring receives', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    expect(gate.isRepeat(col(), ring)).toBe(false);
  });

  it('skips a byte-identical repeat of the last partial on the same ring', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    expect(gate.isRepeat(col(), ring)).toBe(true);
    expect(gate.isRepeat(col(), ring)).toBe(true);
  });

  it('applies a partial whose texels changed', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    expect(gate.isRepeat(col({ bid: Float32Array.from([1, 2, 3.5]) }), ring)).toBe(false);
    expect(gate.isRepeat(col({ ask: Float32Array.from([4, 5, 7]) }), ring)).toBe(false);
  });

  it('applies a partial that differs only in the sign of a zero texel', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col({ bid: Float32Array.from([0, 2, 3]) }), ring);
    expect(gate.isRepeat(col({ bid: Float32Array.from([-0, 2, 3]) }), ring)).toBe(false);
    expect(gate.isRepeat(col({ bid: Float32Array.from([0, 2, 3]) }), ring)).toBe(true);
  });

  it('applies a partial whose sequence, epoch or start time changed', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    expect(gate.isRepeat(col({ col_seq: 11 }), ring)).toBe(false);
    expect(gate.isRepeat(col({ epoch: 2 }), ring)).toBe(false);
    expect(gate.isRepeat(col({ t0_ns: 2_000n }), ring)).toBe(false);
  });

  it('never skips a final column', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    expect(gate.isRepeat(col({ final: true }), ring)).toBe(false);
  });

  it('a final write disarms the gate so the next partial is applied', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    gate.note(col({ final: true }), ring);
    expect(gate.isRepeat(col(), ring)).toBe(false);
  });

  it('a replaced ring never matches the old ring\'s partial', () => {
    const gate = new PartialDepthGate();
    const oldRing = {};
    gate.note(col(), oldRing);
    expect(gate.isRepeat(col(), {})).toBe(false);
    expect(gate.isRepeat(col(), null)).toBe(false);
  });

  it('clear() forgets the last write', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    gate.note(col(), ring);
    gate.clear();
    expect(gate.isRepeat(col(), ring)).toBe(false);
  });

  it('keeps its own copy, so mutating the source buffer cannot fake a repeat', () => {
    const gate = new PartialDepthGate();
    const ring = {};
    const source = col();
    gate.note(source, ring);
    source.bid[0] = 99;
    expect(gate.isRepeat(source, ring)).toBe(false);
    expect(gate.isRepeat(col(), ring)).toBe(true);
  });
});
