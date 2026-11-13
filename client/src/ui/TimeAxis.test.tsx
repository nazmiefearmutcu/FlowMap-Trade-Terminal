import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('TimeAxis tag clamp', () => {
  // jsdom has no layout: the axis is 300px wide and every tag 60px, through stubs.
  let axisWidth = 300;
  const tagWidth = 60;
  let restore: () => void = () => {};
  let observed: (() => void) | null = null;

  beforeEach(() => {
    axisWidth = 300;
    observed = null;
    const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) { return this.classList.contains('time-axis') ? axisWidth : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('axis-tag') ? tagWidth : 0; },
    });
    // A stand-in ResizeObserver that keeps its callback, so a test can fire a resize.
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observed = cb; }
      observe(): void {}
      disconnect(): void {}
    });
    restore = () => {
      Object.defineProperty(Element.prototype, 'clientWidth', client);
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
      vi.unstubAllGlobals();
    };
  });

  afterEach(() => {
    restore();
  });

  const leftOf = (container: HTMLElement): string | undefined => tagOf(container)?.style.left;

  it('pulls the tag centre in at the left edge so the whole tag stays in the gutter', () => {
    setCrosshairProbe(probe({ x: 2, timeNs: 5_000_000_000n, sessionRelative: true }));
    expect(leftOf(render())).toBe('30px');
  });

  it('pulls the tag centre in at the right edge so the whole tag stays in the gutter', () => {
    setCrosshairProbe(probe({ x: 298, timeNs: 5_000_000_000n, sessionRelative: true }));
    expect(leftOf(render())).toBe('270px');
  });

  it('leaves the centre on the cursor away from both edges', () => {
    setCrosshairProbe(probe({ x: 150, timeNs: 5_000_000_000n, sessionRelative: true }));
    expect(leftOf(render())).toBe('150px');
  });

  it('re-clamps when the axis is resized without any probe change', () => {
    setCrosshairProbe(probe({ x: 190, timeNs: 5_000_000_000n, sessionRelative: true }));
    const container = render();
    expect(leftOf(container)).toBe('190px');
    // The axis narrows to 200px: the right-edge limit becomes 170px.
    axisWidth = 200;
    act(() => observed?.());
    expect(leftOf(container)).toBe('170px');
  });
});
