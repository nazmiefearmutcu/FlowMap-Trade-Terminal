import { describe, expect, it } from 'vitest';

import { addUnderStrokedSegments, UNDER_STROKE_EXTRA_PX, underStrokeWidth } from './underStroke';
import { OVERLAY } from './palette';
import type { RGBA } from './primitives';
import type { SolidBatch } from './primitives';

interface ThickCall { x0: number; y0: number; x1: number; y1: number; width: number; color: readonly number[] }

function recordingBatch(): { solid: SolidBatch; calls: ThickCall[] } {
  const calls: ThickCall[] = [];
  const solid = {
    addThickLine: (x0: number, y0: number, x1: number, y1: number, width: number, color: RGBA) => {
      calls.push({ x0, y0, x1, y1, width, color });
    },
  } as unknown as SolidBatch;
  return { solid, calls };
}

describe('addUnderStrokedSegments', () => {
  it('widens the halo by the fixed extra and keeps the core width', () => {
    expect(underStrokeWidth(2.4)).toBe(2.4 + UNDER_STROKE_EXTRA_PX);
  });

  it('emits every halo segment before any core segment, so the core paints on top', () => {
    const { solid, calls } = recordingBatch();
    const core: RGBA = [0.8, 0.5, 1, 0.95];
    addUnderStrokedSegments(
      solid,
      [{ x0: -1, y0: 0, x1: 0, y1: 0 }, { x0: 0, y0: 0, x1: 1, y1: 0.5 }],
      2,
      core,
      800,
      400,
    );
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 2).map((c) => c.width)).toEqual([4, 4]);
    expect(calls.slice(2).map((c) => c.width)).toEqual([2, 2]);
    expect(calls.slice(0, 2).every((c) => c.color === OVERLAY.priceHalo.gl)).toBe(true);
    expect(calls.slice(2).every((c) => c.color === core)).toBe(true);
    expect(calls[2]).toMatchObject({ x0: -1, y0: 0, x1: 0, y1: 0 });
  });

  it('adds nothing for an empty path', () => {
    const { solid, calls } = recordingBatch();
    addUnderStrokedSegments(solid, [], 2, [1, 1, 1, 1], 800, 400);
    expect(calls).toHaveLength(0);
  });
});
