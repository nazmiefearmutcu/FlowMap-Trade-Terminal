/**
 * Contrasting under-stroke for thin overlay traces.
 *
 * A trace drawn in one ink can vanish over the hot end of the density ramp,
 * where its colour and the ramp have close luminance. The price line already
 * fixes this with an opaque halo in the theme's contrast colour
 * (`OVERLAY.priceHalo`: white on light grounds, black on dark ones). This helper
 * gives the other default-visible line traces the same under-stroke.
 *
 * All halo segments are emitted before any core segment, so one batch paints
 * the halo first and the core on top, including at polyline joins.
 */

import { OVERLAY } from './palette';
import type { SolidBatch } from './primitives';
import type { RGBA } from './primitives';

/** CSS px the halo extends beyond each side of the core stroke. */
export const UNDER_STROKE_EXTRA_PX = 2;

/** One straight segment in CSS px, before clip-space mapping. */
export interface TraceSegment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Halo width (CSS px) for a core stroke of `coreWidth` CSS px. */
export function underStrokeWidth(coreWidth: number): number {
  return coreWidth + UNDER_STROKE_EXTRA_PX;
}

/**
 * Add `segments` to the open solid batch as a halo pass followed by a core
 * pass. The caller owns `begin()` and `flush()`. The coordinates are whatever
 * the caller passes to `addThickLine` (clip space for {@link SolidBatch}).
 */
export function addUnderStrokedSegments(
  solid: SolidBatch,
  segments: readonly TraceSegment[],
  coreWidth: number,
  core: RGBA,
  cssW: number,
  cssH: number,
): void {
  const haloWidth = underStrokeWidth(coreWidth);
  for (const s of segments) {
    solid.addThickLine(s.x0, s.y0, s.x1, s.y1, haloWidth, OVERLAY.priceHalo.gl, cssW, cssH);
  }
  for (const s of segments) {
    solid.addThickLine(s.x0, s.y0, s.x1, s.y1, coreWidth, core, cssW, cssH);
  }
}
