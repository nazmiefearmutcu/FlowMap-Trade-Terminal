import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../i18n';
import { getTimeZonePref, setTimeZonePref } from '../i18n/format';
import { useFlowMapStore } from '../state/store';
import { setCrosshairProbe, type CrosshairProbe } from './crosshairStore';
import { TimeAxis } from './TimeAxis';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let previousZone = getTimeZonePref();

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const canvasRef = createRef<HTMLCanvasElement>();
  const root = createRoot(container);
  act(() => root.render(<TimeAxis canvasRef={canvasRef} />));
  mounted.push({ container, root });
  return container;
}

function probe(over: Partial<CrosshairProbe> = {}): CrosshairProbe {
  return { x: 120, y: 40, price: 161.25, priceDecimals: 2, timeNs: null, sessionRelative: false, ...over };
}

const tagOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="crosshair-time-tag"]');

beforeEach(() => {
  previousZone = getTimeZonePref();
  setTimeZonePref('utc');
  useFlowMapStore.setState({ subscription: { market: 'kraken', symbol: 'XBT/USD', band: 'native', mode: 'live' } });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setCrosshairProbe(null);
  setLocale('en');
  setTimeZonePref(previousZone);
  useFlowMapStore.setState({ subscription: null });
});

describe('TimeAxis crosshair time tag', () => {
  it('is absent while no probe is published', () => {
    expect(tagOf(render())).toBeNull();
  });

  it('shows weekday, day, month and the clock for the probed instant in the UTC preference', () => {
    // 2026-11-13T20:45:18Z is a Friday.
    setCrosshairProbe(probe({ timeNs: BigInt(Date.UTC(2026, 10, 13, 20, 45, 18)) * 1_000_000n }));
    const tag = tagOf(render());
    expect(tag?.textContent).toBe('Fri 13 Nov 20:45:18');
    expect(tag?.getAttribute('aria-hidden')).toBe('true');
    expect(tag?.style.left).toBe('120px');
  });

  it('shows the Turkish day and month names in Turkish', () => {
    setLocale('tr');
    setCrosshairProbe(probe({ timeNs: BigInt(Date.UTC(2026, 10, 13, 20, 45, 18)) * 1_000_000n }));
    expect(tagOf(render())?.textContent).toBe('Cum 13 Kas 20:45:18');
  });

  it('shows the T+ clock and no date for a session-relative probe', () => {
    setCrosshairProbe(probe({ timeNs: 5_000_000_000n, sessionRelative: true }));
    expect(tagOf(render())?.textContent).toBe('00:00:05.000');
  });

  it('is absent when the probe has no time', () => {
    setCrosshairProbe(probe({ timeNs: null }));
    expect(tagOf(render())).toBeNull();
  });
});
