import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { THEME_IDS } from '../theme';
import { loadSettings } from '../ui/settings';
import { useChartThemeSync, type ChartThemeSync } from './useChartThemeBridge';

const THEME = THEME_IDS[0];
const COLORMAP = loadSettings(null).colormap;
const OTHER_THEME = THEME_IDS[1];

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setChartTheme = vi.fn();
const rendererRef: { current: Renderer | null } = { current: null };
const attachRenderer = (): void => {
  rendererRef.current = { setChartTheme } as unknown as Renderer;
};
let sync: ChartThemeSync | null = null;

function Probe(): null {
  sync = useChartThemeSync(rendererRef);
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  setChartTheme.mockClear();
  attachRenderer();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rendererRef.current = null;
});

describe('useChartThemeSync', () => {
  it('pushes the ramp only when the (theme, colormap) pair changes', () => {
    const { syncChartTheme } = sync!;
    syncChartTheme(THEME, COLORMAP);
    syncChartTheme(THEME, COLORMAP);
    expect(setChartTheme).toHaveBeenCalledTimes(1);
    syncChartTheme(OTHER_THEME, COLORMAP);
    expect(setChartTheme).toHaveBeenCalledTimes(2);
  });

  it('re-pushes after the signature is reset for a fresh renderer', () => {
    const { syncChartTheme, resetChartThemeSignature } = sync!;
    syncChartTheme(THEME, COLORMAP);
    resetChartThemeSignature();
    syncChartTheme(THEME, COLORMAP);
    expect(setChartTheme).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a renderer', () => {
    rendererRef.current = null;
    sync!.syncChartTheme(THEME, COLORMAP);
    expect(setChartTheme).not.toHaveBeenCalled();
  });
});
