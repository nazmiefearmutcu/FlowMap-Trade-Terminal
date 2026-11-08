import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { setLocale } from '../i18n';
import { DeskToolbar } from './DeskToolbar';
import { DEFAULT_SETTINGS } from './settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

/** Mount the toolbar against a renderer stub that reports history progress, then let its 500 ms poll run. */
function mountWithProgress(loaded: number, total: number): HTMLElement {
  vi.useFakeTimers();
  const rendererRef = {
    current: {
      following: true,
      priceFollow: 'off',
      stats: () => ({ fps: 60 }),
      overviewStats: () => ({ error: null, progress: { loaded, total } }),
    } as unknown as Renderer,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(
      <DeskToolbar
        rendererRef={rendererRef}
        settings={DEFAULT_SETTINGS}
        layout="orderflow"
        onLayout={() => {}}
        onChange={() => {}}
        onTrack={() => {}}
        onFit={() => {}}
      />,
    );
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  setLocale('en');
});

describe('DeskToolbar history progress', () => {
  it('groups the loaded and total counts in English', () => {
    setLocale('en');
    const el = mountWithProgress(1200, 12000);
    expect(el.querySelector('[data-testid="history-loading"]')?.textContent).toBe('Loading history 1,200/12,000');
  });

  it('groups the loaded and total counts with the Turkish separator, like the rest of the UI', () => {
    setLocale('tr');
    const el = mountWithProgress(1000, 12000);
    expect(el.querySelector('[data-testid="history-loading"]')?.textContent).toBe('Geçmiş yükleniyor 1.000/12.000');
  });
});
