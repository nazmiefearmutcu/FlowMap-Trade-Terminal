/**
 * Shared numeric helpers for the WebGL layer.
 */

/** Clamp `v` into `[lo, hi]`. A NaN input is returned unchanged (comparisons fail). */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Decimal places a price step needs, so labels show the step's own digits and
 * no noise. The count grows with the step: a 1.2e-9 step prints 10 places, so a
 * tiny price never reads 0.00000000. The first count at which the step is a whole
 * number of units is used; the tolerance is relative, so float noise in a nice
 * step (0.0300000001) does not add places. Non-positive or non-finite input gives 2.
 */
export function priceDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 2;
  for (let decimals = 0; decimals < 12; decimals++) {
    const scaled = step * 10 ** decimals;
    if (scaled >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-8 * scaled) return decimals;
  }
  return 12;
}
