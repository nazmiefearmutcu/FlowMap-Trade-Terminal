import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';

import { gammaForContrast } from '../gl/heatmap';
import { Renderer } from '../gl/renderer';
import { getTheme } from '../theme';
import { bookStore } from '../state/bookStore';
import { safeLocalStorage } from '../state/safeStorage';
import { useFlowMapStore } from '../state/store';
import { loadStartupSymbol } from '../ui/startupSymbol';
import type { FlowMapSettings } from '../ui/settings';
import { whenSidecarReady } from '../net/sidecarStatus';
import { installControlSpy } from './controlSpy';
import type { ChartThemeSync } from './useChartThemeBridge';

export interface RendererLifecycleDeps {
  canvasRef: RefObject<HTMLCanvasElement>;
  priceAxisRef: RefObject<HTMLCanvasElement>;
  timeAxisRef: RefObject<HTMLCanvasElement>;
  rendererRef: MutableRefObject<Renderer | null>;
  /** The symbol a Retry reconnects to (set only by Retry, read once on mount). */
  retryTargetRef: MutableRefObject<{ market: string; symbol: string } | null>;
  settingsRef: MutableRefObject<FlowMapSettings>;
  syncChartTheme: ChartThemeSync['syncChartTheme'];
  resetChartThemeSignature: ChartThemeSync['resetChartThemeSignature'];
  /** Bumped by the fallback's Retry to re-create the renderer on the canvas. */
  rendererAttempt: number;
  setGlError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Renderer lifecycle: create the WebGL renderer on the canvas, apply the
 * persisted settings at boot, connect the store to the stream, and dispose both
 * on unmount or Retry. GL setup can legitimately fail (no WebGL2, disabled GPU):
 * the failure is recorded and the stream still connects, so the DOM panels run
 * without the canvas instead of the whole tree going blank.
 */
export function useRendererLifecycle(deps: RendererLifecycleDeps): void {
  const {
    canvasRef, priceAxisRef, timeAxisRef, rendererRef, retryTargetRef, settingsRef,
    syncChartTheme, resetChartThemeSignature, rendererAttempt, setGlError,
  } = deps;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dev-only heatmap e2e hook (`?test=heatmap`) owns the canvas itself.
    // The DEV guard keeps both the branch and the harness module out of production.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('test') === 'heatmap') {
      let disposed = false;
      void import('../gl/testHook').then((m) => {
        if (!disposed) m.installHeatmapTestHook(canvas);
      });
      return () => {
        disposed = true;
      };
    }

    const params = new URLSearchParams(window.location.search);
    const startup = retryTargetRef.current ?? loadStartupSymbol(safeLocalStorage(), window.location.search);
    retryTargetRef.current = null;
    const priceBand = settingsRef.current.priceBand;
    // The mount-time connect waits for the desktop engine to answer; in a plain
    // browser it runs at once. The returned cancel is the effect's cleanup.
    const connectAtStart = (): (() => void) => whenSidecarReady(() => {
      useFlowMapStore.getState().connectAndSubscribe(startup.market, startup.symbol, 'live', priceBand);
    });
    // Harness flags (e2e / perf / spy taps) exist only in development builds: a
    // production bundle neither honours a query flag nor ships the code it reaches.
    const harnessFlag = (name: string): boolean => import.meta.env.DEV && params.get(name) === '1';
    const perfMode = harnessFlag('perf');
    const normalizeMode = harnessFlag('normalize');
    const overlaysMode = harnessFlag('overlays');
    const panelsMode = harnessFlag('panels');
    const scrollbackMode = harnessFlag('scrollback');
    const spyMode = harnessFlag('spy');
    const benchmarkMode = (window as unknown as { __FLOWMAP_BENCHMARK__?: boolean }).__FLOWMAP_BENCHMARK__ === true;
    const budgetParam = params.get('budget');
    const rendererOpts = scrollbackMode
      ? { capacityColsTarget: budgetParam ? Number.parseInt(budgetParam, 10) : 512 }
      : {};

    // Install the control tap BEFORE the store opens its socket.
    if (spyMode) installControlSpy();

    let renderer: Renderer;
    try {
      // The display context requires EXT_color_buffer_float: without it the SUM
      // mip passes cannot run, and a silent reduced-density chart would look like
      // data. The fallback says so instead.
      renderer = new Renderer(canvas, useFlowMapStore, {
        ...rendererOpts,
        benchmark: benchmarkMode,
        requireColorBufferFloat: true,
      });
      renderer.attachOverlaySurfaces(priceAxisRef.current, timeAxisRef.current);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
      let cancelConnect: () => void = () => {};
      if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
        cancelConnect = connectAtStart();
      }
      return () => {
        cancelConnect();
        useFlowMapStore.getState().disconnect();
      };
    }
    rendererRef.current = renderer;
    // The chart-ramp signature must not survive a new renderer instance (React
    // StrictMode and HMR re-run this setup), or the boot sync below would skip it.
    resetChartThemeSignature();
    // Apply persisted, live-honourable settings at boot.
    renderer.setOverlayVisibility(settingsRef.current.overlays);
    renderer.setBubbleMinSize(settingsRef.current.bubbleMinSize);
    renderer.setContrast(gammaForContrast(settingsRef.current.contrast));
    renderer.setTolerance(settingsRef.current.tolerance);
    renderer.setColormap(settingsRef.current.colormap);
    // Seed the chart ramp from the RESOLVED theme (getTheme(), not a hook value:
    // this effect runs once and must not trust a closure). The theme bridge
    // re-syncs on theme/colormap changes; the signature gate makes this a no-op then.
    syncChartTheme(getTheme(), settingsRef.current.colormap);
    renderer.setNormPercentile(settingsRef.current.normPercentile);
    // Follow policy is remembered by the renderer (`want*`) so the lazy ring
    // creation on the first column cannot discard it.
    renderer.setFollowTime(settingsRef.current.follow);
    // BOOT uses 'fit' on purpose: there is no user zoom to preserve yet, and
    // auto-fit is the only thing that frames the book instead of showing the whole
    // multi-thousand-row grid as a hairline. Once the user has a scale, the
    // settings toggle and the axis chip enable 'track' (see PriceAxis).
    renderer.setPriceFollow(settingsRef.current.followPrice ? 'fit' : 'off');
    // Depth display channel (optional-chained: a build without it keeps 'sum').
    renderer.setDepthChannel?.(settingsRef.current.depthChannel);
    // Chart style: normal is the default; pixel is opt-in.
    renderer.setChartStyle?.(settingsRef.current.chartStyle);
    // Tick grouping (optional-chained for the same reason).
    renderer.setTickGrouping?.(settingsRef.current.tickGrouping);

    let cancelConnect: () => void = () => {};
    if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
      cancelConnect = connectAtStart();
    }

    if (
      import.meta.env.DEV ||
      perfMode ||
      scrollbackMode ||
      normalizeMode ||
      overlaysMode ||
      panelsMode ||
      spyMode ||
      benchmarkMode
    ) {
      (window as unknown as { __flowmapLive: unknown }).__flowmapLive = {
        renderer,
        store: useFlowMapStore,
        bookStore,
      };
    }

    return () => {
      cancelConnect();
      renderer.dispose();
      rendererRef.current = null;
      useFlowMapStore.getState().disconnect();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __flowmapLive?: unknown }).__flowmapLive;
      }
    };
  }, [
    canvasRef, priceAxisRef, timeAxisRef, rendererRef, retryTargetRef, settingsRef,
    syncChartTheme, resetChartThemeSignature, rendererAttempt, setGlError,
  ]);
}
