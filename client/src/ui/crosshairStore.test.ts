import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCrosshairProbe,
  setCrosshairProbe,
  subscribeCrosshair,
  type CrosshairProbe,
} from './crosshairStore';

const base: CrosshairProbe = {
  x: 10,
  y: 20,
  price: 156.75,
  priceDecimals: 2,
  timeNs: 5_000_000_000n,
  sessionRelative: false,
};

afterEach(() => {
  setCrosshairProbe(null);
});

describe('crosshairStore', () => {
  it('holds the probe that was last set and returns null once cleared', () => {
    expect(getCrosshairProbe()).toBeNull();
    setCrosshairProbe(base);
    expect(getCrosshairProbe()).toEqual(base);
    setCrosshairProbe(null);
    expect(getCrosshairProbe()).toBeNull();
  });

  it('calls a listener when a field of the probe changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCrosshair(listener);
    setCrosshairProbe(base);
    setCrosshairProbe({ ...base, y: 21 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not call a listener for an identical probe, comparing timeNs by value', () => {
    setCrosshairProbe(base);
    const listener = vi.fn();
    const unsubscribe = subscribeCrosshair(listener);
    setCrosshairProbe({ ...base, timeNs: 5_000_000_000n });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies once when the probe is cleared, and not again while it stays cleared', () => {
    setCrosshairProbe(base);
    const listener = vi.fn();
    const unsubscribe = subscribeCrosshair(listener);
    setCrosshairProbe(null);
    setCrosshairProbe(null);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stops calling a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCrosshair(listener);
    unsubscribe();
    setCrosshairProbe(base);
    expect(listener).not.toHaveBeenCalled();
  });
});
