import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Crosshair } from './Crosshair';
import { lastProbeSpot, resetProbeSpotForTest } from './lastProbe';
import { getCrosshairProbe } from './crosshairStore';
import type { CrosshairReadout, Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import { getTimeZonePref, setTimeZonePref } from '../i18n/format';

afterEach(() => { vi.restoreAllMocks(); resetProbeSpotForTest(); });
it('uses the latest pointer and refreshes a stationary probe, then stops outside and on teardown', () => {
  // A still pointer is re-read on a 100 ms timer, not on every frame.
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
  const canvas = document.createElement('canvas');
  const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
  const container = document.createElement('div'); const root = createRoot(container);
  let price = 100, priceDecimals = 2;
  const probeAt = vi.fn((x: number) => ({ colSeq: x, row: 1, group: 1, price, priceLo: price, priceHi: price, priceDecimals, bid: 1, ask: 2, timeNs: 0n, inRange: true } satisfies CrosshairReadout));
  const rendererRef = { current: { probeAt } as unknown as Renderer };
  const pump = (): void => { const pending = [...callbacks.values()]; callbacks.clear(); act(() => pending.forEach(cb => cb(0))); };
  const move = (x: number): void => { const event = new Event('pointermove'); Object.assign(event, { clientX: x, clientY: 20 }); canvas.dispatchEvent(event); };
  act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
  move(10); move(30); expect(callbacks.size).toBe(1); pump();
  expect(probeAt).toHaveBeenLastCalledWith(30, 20);
  expect(container.querySelector('[data-testid="crosshair-price"]')?.textContent).toBe('100.00');
  price = 101; vi.advanceTimersByTime(100); pump();
  expect(container.querySelector('[data-testid="crosshair-price"]')?.textContent).toBe('101.00');
  price = 103.25; vi.advanceTimersByTime(100); pump();
  expect(container.querySelector('[data-testid="crosshair-price"]')?.textContent).toBe('103.25');
  price = .000000112; priceDecimals = 9; vi.advanceTimersByTime(100); pump();
  expect(container.querySelector('[data-testid="crosshair-price"]')?.textContent).toBe('0.000000112');
  act(() => canvas.dispatchEvent(new Event('pointerleave')));
  expect(callbacks.size).toBe(0); expect(container.textContent).toBe('');
  move(40); expect(callbacks.size).toBe(1);
  act(() => root.unmount()); expect(callbacks.size).toBe(0);
  move(50); expect(callbacks.size).toBe(0);
  vi.useRealTimers();
});

it('does not re-probe a still pointer more often than the throttle allows', () => {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
  const canvas = document.createElement('canvas');
  const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
  const container = document.createElement('div'); const root = createRoot(container);
  const probeAt = vi.fn(() => null);
  const rendererRef = { current: { probeAt } as unknown as Renderer };
  act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
  const event = new Event('pointermove'); Object.assign(event, { clientX: 10, clientY: 20 });
  canvas.dispatchEvent(event);
  const pumpFrames = (n: number): void => { for (let i = 0; i < n; i++) { const pending = [...callbacks.values()]; callbacks.clear(); act(() => pending.forEach(cb => cb(0))); } };
  pumpFrames(1);
  // Sixty frames of 16 ms each: about 1 s of stillness, which is ~10 probes, not 60.
  for (let i = 0; i < 60; i++) { act(() => { vi.advanceTimersByTime(16); }); pumpFrames(1); }
  expect(probeAt.mock.calls.length).toBeLessThanOrEqual(12);
  expect(probeAt.mock.calls.length).toBeGreaterThanOrEqual(8);
  act(() => root.unmount());
  vi.useRealTimers();
});

it('drops the probe spot the A key would anchor on when the pointer leaves the chart', () => {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
  const canvas = document.createElement('canvas');
  const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
  const container = document.createElement('div'); const root = createRoot(container);
  const probeAt = vi.fn((x: number) => ({ colSeq: x, row: 1, group: 1, price: 100, priceLo: 100, priceHi: 100, priceDecimals: 2, bid: 1, ask: 2, timeNs: 0n, inRange: true } satisfies CrosshairReadout));
  const rendererRef = { current: { probeAt } as unknown as Renderer };
  const pump = (): void => { const pending = [...callbacks.values()]; callbacks.clear(); act(() => pending.forEach(cb => cb(0))); };
  const move = (x: number): void => { const event = new Event('pointermove'); Object.assign(event, { clientX: x, clientY: 20 }); canvas.dispatchEvent(event); };
  act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
  move(10); pump();
  expect(lastProbeSpot()?.price).toBe(100);
  act(() => canvas.dispatchEvent(new Event('pointerleave')));
  expect(lastProbeSpot()).toBeNull();
  act(() => root.unmount());
  vi.useRealTimers();
});

it('labels a replayed synthetic recording SYNTH and marks its sizes, even when it is marked recorded-density', () => {
  useFlowMapStore.setState({ capability: { depth: 'SYNTH', playback: {}, depth_provenance: 'recorded-density' } });
  try {
    vi.useFakeTimers();
    const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
    const canvas = document.createElement('canvas');
    const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
    const container = document.createElement('div'); const root = createRoot(container);
    const probeAt = vi.fn((x: number) => ({ colSeq: x, row: 1, group: 1, price: 100, priceLo: 100, priceHi: 100, priceDecimals: 2, bid: 1, ask: 2, timeNs: 0n, inRange: true } satisfies CrosshairReadout));
    const rendererRef = { current: { probeAt } as unknown as Renderer };
    const pump = (): void => { const pending = [...callbacks.values()]; callbacks.clear(); act(() => pending.forEach(cb => cb(0))); };
    const event = new Event('pointermove'); Object.assign(event, { clientX: 10, clientY: 20 });
    act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
    canvas.dispatchEvent(event); pump();
    expect(container.querySelector('[data-testid="crosshair-src"]')?.textContent).toBe('SYNTH');
    expect(container.querySelector('[data-testid="crosshair-bid"]')?.className).toContain('crosshair__val--synth');
    act(() => root.unmount());
  } finally {
    useFlowMapStore.setState({ capability: null });
    vi.useRealTimers();
  }
});

/** Mounts a crosshair with one probe, returning the readout box and a teardown. */
function mountProbedCrosshair(readout: Partial<CrosshairReadout>): { container: HTMLElement; canvas: HTMLCanvasElement; done: () => void } {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
  const canvas = document.createElement('canvas');
  const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
  const container = document.createElement('div'); const root = createRoot(container);
  const full: CrosshairReadout = { colSeq: 1, row: 1, group: 1, price: 100, priceLo: 100, priceHi: 100, priceDecimals: 2, bid: 1, ask: 2, timeNs: 0n, inRange: true, ...readout };
  const rendererRef = { current: { probeAt: () => full } as unknown as Renderer };
  act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
  const event = new Event('pointermove'); Object.assign(event, { clientX: 10, clientY: 20 });
  canvas.dispatchEvent(event);
  const pending = [...callbacks.values()]; callbacks.clear();
  act(() => pending.forEach(cb => cb(0)));
  return { container, canvas, done: () => { act(() => root.unmount()); vi.useRealTimers(); } };
}

it('reads a sim readout as the session-relative clock, not a zoned wall time', () => {
  const previousZone = getTimeZonePref();
  setTimeZonePref('local');
  useFlowMapStore.setState({ subscription: { market: 'sim', symbol: 'SIM-DEMO', band: 'native', mode: 'live' } });
  const mounted = mountProbedCrosshair({ timeNs: 5_000_000_000n, colSeq: 1 });
  try {
    expect(mounted.container.querySelector('[data-testid="crosshair-time"]')?.textContent).toBe('00:00:05.000');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ subscription: null });
    setTimeZonePref(previousZone);
  }
});

it('titles a Cboe top-five source tag with its exchange scope', () => {
  useFlowMapStore.setState({ capability: { depth: 'L2-snapshot', depth_scope: 'cboe-top5' } });
  const mounted = mountProbedCrosshair({});
  try {
    const tag = mounted.container.querySelector('[data-testid="crosshair-src"]');
    expect(tag?.textContent).toBe('L2-SNAPSHOT');
    expect(tag?.getAttribute('title')).toContain('Cboe exchanges only');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('keeps the recorded-density disclosure ahead of the scope on a Cboe replay', () => {
  useFlowMapStore.setState({
    capability: { depth: 'L2-snapshot', depth_scope: 'cboe-top5', depth_provenance: 'recorded-density', playback: {} },
  });
  const mounted = mountProbedCrosshair({});
  try {
    const title = mounted.container.querySelector('[data-testid="crosshair-src"]')?.getAttribute('title') ?? '';
    expect(title.startsWith('recorded time-weighted density')).toBe(true);
    expect(title).toContain('Cboe exchanges only');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('keeps the source tag untitled for a ccxt venue snapshot with no scope', () => {
  useFlowMapStore.setState({ capability: { depth: 'L2-snapshot' } });
  const mounted = mountProbedCrosshair({});
  try {
    const tag = mounted.container.querySelector('[data-testid="crosshair-src"]');
    expect(tag?.getAttribute('title')).toBeNull();
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('names a polled venue snapshot L2-SNAPSHOT, never L2', () => {
  useFlowMapStore.setState({ capability: { depth: 'L2-snapshot' } });
  const mounted = mountProbedCrosshair({});
  try {
    expect(mounted.container.querySelector('[data-testid="crosshair-src"]')?.textContent).toBe('L2-SNAPSHOT');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('reads a readout flagged sessionClock as the T+ clock, even off a sim subscription', () => {
  useFlowMapStore.setState({ subscription: null });
  const mounted = mountProbedCrosshair({ timeNs: 12_500_000_000n, sessionClock: true });
  try {
    expect(mounted.container.querySelector('[data-testid="crosshair-time"]')?.textContent).toBe('00:00:12.500');
  } finally {
    mounted.done();
  }
});

it('gives a polled venue snapshot the caution tone, never the synthetic one', () => {
  useFlowMapStore.setState({ capability: { depth: 'L2-snapshot' } });
  const mounted = mountProbedCrosshair({});
  try {
    const tag = mounted.container.querySelector('[data-testid="crosshair-src"]');
    expect(tag?.className).toContain('crosshair__tag--caution');
    expect(tag?.className).not.toContain('crosshair__tag--synth');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('records the probe under the market and symbol it was read on', () => {
  useFlowMapStore.setState({ subscription: { market: 'kraken', symbol: 'XBT/USD', band: 'native', mode: 'live' } });
  const mounted = mountProbedCrosshair({});
  try {
    expect(lastProbeSpot()?.key).toBe('kraken:XBT/USD');
  } finally {
    mounted.done();
    useFlowMapStore.setState({ subscription: null });
  }
});

it('publishes the probe under the pointer to the axis tags, and clears it when the pointer leaves', () => {
  const mounted = mountProbedCrosshair({ price: 156.75, priceDecimals: 2, timeNs: 0n });
  try {
    expect(getCrosshairProbe()).toMatchObject({ x: 10, y: 20, price: 156.75, priceDecimals: 2, timeNs: 0n, sessionRelative: false });
    act(() => mounted.canvas.dispatchEvent(new Event('pointerleave')));
    expect(getCrosshairProbe()).toBeNull();
  } finally {
    mounted.done();
  }
});

it('clears the published probe when the crosshair unmounts', () => {
  const mounted = mountProbedCrosshair({ price: 100 });
  expect(getCrosshairProbe()).not.toBeNull();
  mounted.done();
  expect(getCrosshairProbe()).toBeNull();
});

it('publishes the session-relative flag for a sim readout', () => {
  useFlowMapStore.setState({ subscription: { market: 'sim', symbol: 'SIM-DEMO', band: 'native', mode: 'live' } });
  const mounted = mountProbedCrosshair({ timeNs: 5_000_000_000n });
  try {
    expect(getCrosshairProbe()?.sessionRelative).toBe(true);
  } finally {
    mounted.done();
    useFlowMapStore.setState({ subscription: null });
  }
});

it('omits the bid and ask rows when the depth source is N/A', () => {
  useFlowMapStore.setState({ capability: { depth: 'N/A' } });
  const mounted = mountProbedCrosshair({});
  try {
    expect(mounted.container.querySelector('[data-testid="crosshair-bid"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="crosshair-ask"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="crosshair-time"]')).not.toBeNull();
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('labels the rows with words, not abbreviations', () => {
  useFlowMapStore.setState({ capability: { depth: 'L2' } });
  const mounted = mountProbedCrosshair({ bid: 1, ask: 2 });
  try {
    const labels = [...mounted.container.querySelectorAll('.crosshair__key')].map(el => el.textContent);
    expect(labels).toEqual(['Source', 'Time', 'Price', 'Bid orders', 'Ask orders']);
  } finally {
    mounted.done();
    useFlowMapStore.setState({ capability: null });
  }
});

it('reads a grouped cell as its price band and level count, and an averaged cell as its window', () => {
  const mounted = mountProbedCrosshair({
    group: 4, price: 156.77, priceLo: 156.75, priceHi: 156.79, priceDecimals: 2, averageMs: 64_000,
  });
  try {
    const group = mounted.container.querySelector('[data-testid="crosshair-group"]');
    expect(group?.parentElement?.textContent).toBe('Price band156.75–156.79 (4 levels)');
    const average = mounted.container.querySelector('.crosshair__line--dim:last-child');
    expect(average?.textContent).toBe('Averaged over64.0 s');
  } finally {
    mounted.done();
  }
});

it('publishes the axis-tag probe inside the frame callback, before any effect runs', () => {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>(); let seq = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++seq, cb); return seq; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
  const canvas = document.createElement('canvas');
  const canvasRef = createRef<HTMLCanvasElement>(); Object.assign(canvasRef, { current: canvas });
  const container = document.createElement('div'); const root = createRoot(container);
  let price = 100;
  const probeAt = vi.fn((x: number) => ({ colSeq: x, row: 1, group: 1, price, priceLo: price, priceHi: price, priceDecimals: 2, bid: 1, ask: 2, timeNs: 0n, inRange: true } satisfies CrosshairReadout));
  const rendererRef = { current: { probeAt } as unknown as Renderer };
  act(() => root.render(<Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />));
  const event = new Event('pointermove'); Object.assign(event, { clientX: 10, clientY: 20 });
  canvas.dispatchEvent(event);
  // Run the frame callbacks with no act() wrapper: nothing React-side flushes
  // between the probe and the assertion, so only a synchronous publish passes.
  price = 101;
  const pending = [...callbacks.values()]; callbacks.clear();
  pending.forEach(cb => cb(0));
  expect(getCrosshairProbe()).toMatchObject({ x: 10, y: 20, price: 101, sessionRelative: false });
  act(() => canvas.dispatchEvent(new Event('pointerleave')));
  expect(getCrosshairProbe()).toBeNull();
  act(() => root.unmount());
  vi.useRealTimers();
});
