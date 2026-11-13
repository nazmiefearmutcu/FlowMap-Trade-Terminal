/**
 * The crosshair's current probe, shared with the price and time axes.
 *
 * Crosshair.tsx publishes the readout under the pointer here, so the axis tags
 * show the same price and time the readout box shows. Plain module state with
 * no React in it: a write notifies subscribers only when a field changed, so a
 * still pointer that re-probes the same cell causes no re-render.
 */

import { useSyncExternalStore } from 'react';

export interface CrosshairProbe {
  /** CSS px from the chart canvas's left edge. */
  x: number;
  /** CSS px from the chart canvas's top edge. */
  y: number;
  price: number | null;
  priceDecimals: number;
  timeNs: bigint | null;
  /** True for the sim feed's session clock, which is elapsed time, not wall time. */
  sessionRelative: boolean;
}

let current: CrosshairProbe | null = null;
const listeners = new Set<() => void>();

function sameProbe(a: CrosshairProbe, b: CrosshairProbe): boolean {
  return (
    Object.is(a.x, b.x) &&
    Object.is(a.y, b.y) &&
    Object.is(a.price, b.price) &&
    Object.is(a.priceDecimals, b.priceDecimals) &&
    Object.is(a.timeNs, b.timeNs) &&
    Object.is(a.sessionRelative, b.sessionRelative)
  );
}

/** Publish the probe under the pointer, or null when the pointer has left the chart. */
export function setCrosshairProbe(probe: CrosshairProbe | null): void {
  if (probe === null && current === null) return;
  if (probe !== null && current !== null && sameProbe(current, probe)) return;
  current = probe;
  listeners.forEach((listener) => listener());
}

export function getCrosshairProbe(): CrosshairProbe | null {
  return current;
}

/** Register a change listener. Returns the function that removes it. */
export function subscribeCrosshair(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current probe, re-rendering the caller whenever it changes. */
export function useCrosshairProbe(): CrosshairProbe | null {
  return useSyncExternalStore(subscribeCrosshair, getCrosshairProbe, getCrosshairProbe);
}
