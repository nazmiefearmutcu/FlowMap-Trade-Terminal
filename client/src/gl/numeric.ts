/**
 * Shared numeric helpers for the WebGL layer.
 */

/** Clamp `v` into `[lo, hi]`. A NaN input is returned unchanged (comparisons fail). */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
