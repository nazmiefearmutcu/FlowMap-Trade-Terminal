/**
 * The last crosshair probe, shared between components.
 *
 * Crosshair.tsx records every pointer probe here (it already computes the
 * readout); PriceAlerts reads it when `A` is pressed so the new alert lands at
 * exactly the price the user is pointing at. Plain module scope, no React
 * state, never on the render path — writers are pointer-rAF throttled already.
 */

export interface ProbeSpot {
  /** Price under the cursor, null when off-grid / no data. */
  price: number | null;
  /** Decimals to print `price` with. */
  priceDecimals: number;
  /** Cursor position, canvas CSS px. */
  x: number;
  y: number;
  /** Probe time, ms epoch (staleness checks). */
  at: number;
}

/**
 * How fresh a probe must be to anchor an alert. The probe loop refreshes it every
 * frame while the pointer is over the chart, so a probe older than this means the
 * cursor has left (or the frame loop stopped): its price is no longer under the
 * pointer and must not become a level.
 */
export const PROBE_FRESH_MS = 2_000;

let last: ProbeSpot | null = null;

/** Record a probe (called by Crosshair). */
export function recordProbeSpot(s: ProbeSpot): void {
  last = s;
}

/** Forget the probe (the cursor left the chart, or the symbol changed under it). */
export function clearProbeSpot(): void {
  last = null;
}

/**
 * The most recent probe, or null before the first pointer-move or once it is
 * older than `maxAgeMs` (default {@link PROBE_FRESH_MS}).
 */
export function lastProbeSpot(maxAgeMs = PROBE_FRESH_MS): ProbeSpot | null {
  if (last === null) return null;
  if (Date.now() - last.at > maxAgeMs) return null; // stale — the cursor moved on
  return last;
}

/** Test seam. */
export function resetProbeSpotForTest(): void {
  last = null;
}
