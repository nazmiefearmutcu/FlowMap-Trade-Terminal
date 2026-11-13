import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMacro, type MacroReadingData } from '../net/macroApi';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { MACRO_POLL_MS, useMacroPoll } from './useMacroPoll';

vi.mock('../net/macroApi', () => ({ fetchMacro: vi.fn() }));

const reading: MacroReadingData = {
  sofr: 3.9, sofrDate: '2026-11-12', yield10y2y: 0.24, curveDate: '2026-11-12',
  hySpread: 3.5, hyDate: '2026-11-11', stressScore: 0.1, status: 'NORMAL_LIQUIDITY',
  sourceStatus: { SOFR: 'ok', BAMLH0A0HYM2: 'ok', T10Y2Y: 'ok' },
  sources: { SOFR: 'New York Fed', T10Y2Y: 'US Treasury', BAMLH0A0HYM2: 'FRED' },
  asOf: 1_700_000_000_000, stale: false,
};

function Probe() {
  useMacroPoll();
  return null;
}

let container: HTMLDivElement;
let root: Root;

/** Flushes pending promise callbacks so a resolved fetch reaches the store. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fetchMacro).mockReset();
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useMacroPoll', () => {
  it('fetches on mount and writes the reading into the store', async () => {
    vi.mocked(fetchMacro).mockResolvedValue(reading);
    act(() => root.render(<Probe />));
    await settle();
    expect(fetchMacro).toHaveBeenCalledTimes(1);
    expect(useIntelligenceStore.getState().macro?.sofrRate).toBe(3.9);
  });

  it('fetches again every 15 minutes', async () => {
    vi.mocked(fetchMacro).mockResolvedValue(reading);
    act(() => root.render(<Probe />));
    await settle();
    expect(MACRO_POLL_MS).toBe(15 * 60 * 1000);
    await act(async () => {
      vi.advanceTimersByTime(MACRO_POLL_MS - 1);
    });
    expect(fetchMacro).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchMacro).toHaveBeenCalledTimes(2);
    await settle();
  });

  it('keeps the last reading when a later fetch fails', async () => {
    vi.mocked(fetchMacro).mockResolvedValueOnce(reading).mockRejectedValueOnce(new Error('Macro data is unavailable right now'));
    act(() => root.render(<Probe />));
    await settle();
    const held = useIntelligenceStore.getState().macro;
    expect(held).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(MACRO_POLL_MS);
    });
    await settle();
    expect(fetchMacro).toHaveBeenCalledTimes(2);
    expect(useIntelligenceStore.getState().macro).toBe(held);
  });

  it('leaves the store empty when the first fetch fails', async () => {
    vi.mocked(fetchMacro).mockRejectedValue(new Error('down'));
    act(() => root.render(<Probe />));
    await settle();
    expect(useIntelligenceStore.getState().macro).toBeNull();
  });

  it('aborts the request in flight on unmount and makes no later fetch', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetchMacro).mockImplementation((s) => {
      signal = s;
      return new Promise<MacroReadingData>(() => undefined);
    });
    act(() => root.render(<Probe />));
    expect(signal?.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(MACRO_POLL_MS * 2);
    });
    expect(fetchMacro).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
