/**
 * The DOM ladder's honest depth tier, as a pure module (no React): the rung
 * badge, the heat legend, the crosshair and the measure readout all read it, so
 * none of them needs to import a component to agree with the others.
 */

import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE } from '../proto/types';
import { honestDepthTier } from '../gl/depthTier';

/**
 * The depth badge. `L2-SNAPSHOT` is a real but lower-fidelity book (a ccxt
 * venue re-read whole each tick): it never reads as native `L2`.
 */
export type DepthTier = 'L2' | 'L2-SNAPSHOT' | 'L1' | 'SYNTH';

/**
 * The honest depth tier that every surface reads. It reads through
 * {@link honestDepthTier}, the verdict the chart's ramp uses, so a replay without
 * recorded provenance reads `SYNTH` here too. A recorded-density replay keeps its
 * real tier (a keyless equity recording stays `SYNTH`); the provenance is a
 * separate fact, {@link isRecordedDensity}, so the tier never hides a synthetic
 * depth.
 *
 * The book mode is consulted ONLY when the capability names no tier at all (before
 * the first capability frame). A tier the client does not recognise is `null`:
 * it makes no claim, and it never borrows the book mode's label, so a ccxt
 * snapshot book can never read as a native `L2` book.
 */
export function depthTier(
  capability: Record<string, unknown> | null,
  bookMode: number | null,
): DepthTier | null {
  const d = honestDepthTier(capability);
  if (typeof d === 'string') {
    if (d === 'L2') return 'L2';
    if (d === 'L2-snapshot') return 'L2-SNAPSHOT';
    if (d === 'L1_BAND' || d === 'L1') return 'L1';
    if (d === 'SYNTH' || d === 'SYNTH_PROFILE') return 'SYNTH';
    return null;
  }
  if (bookMode === MODE_L2) return 'L2';
  if (bookMode === MODE_L1_BAND) return 'L1';
  if (bookMode === MODE_SYNTH_PROFILE) return 'SYNTH';
  return null;
}

/** True when the density is an interval aggregate from a recording (its own provenance chip). */
export function isRecordedDensity(capability: Record<string, unknown> | null | undefined): boolean {
  return capability?.depth_provenance === 'recorded-density';
}
