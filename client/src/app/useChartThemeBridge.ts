import { useCallback, useEffect, useRef } from 'react';

import { applyChartInk, applyOverlayPalette } from '../gl/overlays/palette';
import type { Renderer } from '../gl/renderer';
import { resolveAppearance } from '../theme/appearance';
import { attachThemeKey, getCanvasPalette, THEMES, type ThemeId } from '../theme';
import type { Colormap } from '../ui/settings';

/**
 * The subset of `ThemeMeta.chart` the 2D ink bridge (`applyChartInk`) consumes.
 * Mapping explicitly keeps the ramps (density/synth) off the 2D canvas seam:
 * they go to the LUT store via `renderer.setChartTheme`.
 */
type ChartInk = {
  ink: string;
  inkDim: string;
  grid: string;
  gridAlpha?: number;
  axis: string;
  price: string;
  bg: string;
  chipBg: string;
};

function chartInkOf(c: ChartInk): ChartInk {
  return {
    ink: c.ink,
    inkDim: c.inkDim,
    grid: c.grid,
    gridAlpha: c.gridAlpha,
    axis: c.axis,
    price: c.price,
    bg: c.bg,
    chipBg: c.chipBg,
  };
}

export interface ChartThemeSync {
  /** Push the (theme, colormap) ramp to the renderer; a no-op unless the pair changed. */
  syncChartTheme: (themeId: ThemeId, colormap: Colormap) => void;
  /** Forget the last pushed pair, so the next sync reaches a freshly created renderer. */
  resetChartThemeSignature: () => void;
}

/**
 * The renderer's chart ramp is recreated by `setChartTheme` (a LUT texture
 * upload), so only a real (theme, colormap) change may call it. The signature
 * gate lives here so every caller shares one.
 */
export function useChartThemeSync(rendererRef: { readonly current: Renderer | null }): ChartThemeSync {
  const lastSignatureRef = useRef<string | null>(null);
  const syncChartTheme = useCallback((themeId: ThemeId, colormap: Colormap): void => {
    const r = rendererRef.current;
    if (!r) return;
    const sig = `${themeId}|${colormap}`;
    if (lastSignatureRef.current === sig) return;
    lastSignatureRef.current = sig;
    r.setChartTheme(resolveAppearance(themeId, colormap));
  }, [rendererRef]);
  const resetChartThemeSignature = useCallback((): void => {
    lastSignatureRef.current = null;
  }, []);
  return { syncChartTheme, resetChartThemeSignature };
}

/**
 * Theme bridge: the `T` theme key, the 2D overlay palette and ink, the chart ramp,
 * and the `<html>` theme attributes. The theme STORE owns the value; the
 * `data-theme` effect keeps the document in lockstep with it.
 */
export function useChartThemeBridge(
  theme: ThemeId,
  colormap: Colormap,
  syncChartTheme: ChartThemeSync['syncChartTheme'],
): void {
  // `T` cycles themes (self-contained binder from the theme module; editable
  // and dialog guarded, so it yields to the drawer/search like the other keys).
  useEffect(() => attachThemeKey(), []);

  // Theme owns chart semantics and ink for every density family.
  useEffect(() => {
    applyOverlayPalette(getCanvasPalette(theme));
    applyChartInk(chartInkOf(THEMES[theme].chart));
    syncChartTheme(theme, colormap);
  }, [theme, colormap, syncChartTheme]);

  // setTheme also writes the attribute; this only heals the pre-init path, so the
  // first paint and every later render agree.
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // Expose the persisted family for diagnostics; theme CSS owns chart tokens.
  useEffect(() => {
    document.documentElement.dataset.chartRamp = colormap;
  }, [colormap]);
}
