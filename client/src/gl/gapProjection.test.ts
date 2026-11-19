import { describe, expect, it } from 'vitest';
import { gapProjection, recordingClock } from './gapProjection';
import { chartColumn, chartTimestamp } from './overlays/coords';

describe('recording gaps in the overview', () => {
  it('makes a long gap readable without shifting the reserved live quote area', () => {
    const projection = gapProjection(
      { colOffset: 0, colScale: 100, rowOffset: 0, rowScale: 20 },
      [{ left: 20, right: 20.01, leftNs: 0n, rightNs: 30_000_000_000_000n }],
      60_000_000_000, 0.7,
    )!;
    const left = projection.fractionAt(20);
    const right = projection.fractionAt(20.01);
    expect(right - left).toBeGreaterThan(0.2);
    expect(projection.emptyAt((left + right) / 2)).toBe(true);
    expect(projection.emptyAt(left / 2)).toBe(false);
    expect(projection.columnAt((left + right) / 2)).toBeCloseTo(20.005);
    expect(projection.fractionAt(85)).toBeCloseTo(0.85);
    expect(projection.fractionAt(100)).toBeCloseTo(1);
  });

  it('maps the first and last recorded prices around a raw restart without compressing the outage', () => {
    const dtNs = 250_000_000;
    const first = 10_000_000_000;
    const restart = first + 18_000e9;
    const clock = recordingClock({
      startSeq: 100, t0: Float64Array.of(first, first + dtNs, restart, restart + dtNs),
    }, dtNs);
    const time = { anchorSeq: 103, anchorT0Ns: BigInt(restart + dtNs), dtNs, slots: clock.slots, priceGaps: clock.gaps };
    const midpoint = BigInt(first + 9_000e9);
    const col = chartColumn(time, midpoint);
    expect(chartTimestamp(time, 99)).toBe(BigInt(first - dtNs));
    expect(chartColumn(time, BigInt(first - dtNs))).toBe(99);
    expect(chartTimestamp(time, col)).toBe(midpoint);
    const view = { colOffset: 98, colScale: 8, rowOffset: 0, rowScale: 20 };
    const projection = gapProjection(view, clock.gaps, dtNs)!;
    expect(projection.emptyAt(projection.fractionAt(col))).toBe(true);
    expect(projection.emptyAt(projection.fractionAt(102.5))).toBe(false);
    expect(projection.fractionAt(102) - projection.fractionAt(101.5)).toBeGreaterThan(.45);
  });

  it('assigns elapsed-time positions to restored minutes and the gap before them', () => {
    const dtNs = 250_000_000;
    const minute = 60e9;
    const start = 0;
    const restart = 50 * minute;
    const finish = restart + 254 * minute + 30e9;
    const starts = [start, ...Array.from({ length: 255 }, (_, i) => restart + i * minute), finish];
    const clock = recordingClock({ startSeq: 0, t0: Float64Array.from(starts) }, dtNs, true);
    const time = { anchorSeq: 256, anchorT0Ns: BigInt(finish), dtNs, slots: clock.slots, priceGaps: clock.gaps };
    expect(clock.gaps).toHaveLength(1);
    expect(clock.gaps[0].minuteRun).toBe(true);
    const projection = gapProjection(
      { colOffset: 0, colScale: 280, rowOffset: 0, rowScale: 20 }, clock.gaps, dtNs, undefined, time,
    )!;
    const left = projection.fractionAt(.5);
    const right = projection.fractionAt(255);
    const firstCandle = projection.fractionAt(1);
    expect((firstCandle - left) / (right - left)).toBeCloseTo(50 / 304);
    expect(projection.columnAt(firstCandle)).toBeCloseTo(1);
  });
});
