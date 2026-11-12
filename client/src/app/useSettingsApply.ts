import { useEffect, type MutableRefObject } from 'react';

import { gammaForContrast } from '../gl/heatmap';
import type { Renderer } from '../gl/renderer';
import { getTheme } from '../theme';
import { applyUiStyle } from '../theme/uiStyle';
import { safeLocalStorage } from '../state/safeStorage';
import { useFlowMapStore } from '../state/store';
import { historyDepthCols, saveSettings, type FlowMapSettings } from '../ui/settings';
import type { ChartThemeSync } from './useChartThemeBridge';
import type { LiveFollow } from './useSessionFollow';

/**
 * Persist and apply the settings drawer's values to the renderer and the
 * subscription. Runs on every settings change; each renderer knob is idempotent,
 * and the two follow policies are edge-triggered so they never fight a manual
 * gesture (each compares against the renderer's LIVE state).
 */
export function useSettingsApply(
  settings: FlowMapSettings,
  rendererRef: MutableRefObject<Renderer | null>,
  prevSettingsRef: MutableRefObject<FlowMapSettings>,
  liveFollowRef: MutableRefObject<LiveFollow>,
  syncChartTheme: ChartThemeSync['syncChartTheme'],
): void {
  useEffect(() => {
    saveSettings(settings, safeLocalStorage());
    applyUiStyle(settings.chartStyle); // the window chrome follows the chart style
    const r = rendererRef.current;
    if (r) {
      r.setOverlayVisibility(settings.overlays); // idempotent
      r.setBubbleMinSize(settings.bubbleMinSize); // idempotent
      r.setContrast(gammaForContrast(settings.contrast)); // idempotent
      r.setTolerance(settings.tolerance); // calibrated against visible liquidity
      r.setColormap(settings.colormap); // idempotent
      // Same (theme, colormap) source of truth as the boot path; the signature
      // gate inside makes this a no-op unless the pair actually changed.
      syncChartTheme(getTheme(), settings.colormap);
      r.setNormPercentile(settings.normPercentile); // idempotent
      r.setDepthChannel?.(settings.depthChannel); // idempotent
      r.setChartStyle?.(settings.chartStyle); // idempotent
      r.setTickGrouping?.(settings.tickGrouping); // idempotent
      // Both follows are edge-triggered so they never fight a manual gesture,
      // and each compares against the renderer's LIVE state (a gesture changes
      // the camera without writing settings, so comparing only against the
      // previous settings value would leave the switch showing a stale ON).
      const live = useFlowMapStore.getState().subscription?.mode !== 'replay';
      if (live && settings.follow !== prevSettingsRef.current.follow && settings.follow !== r.wantedFollowTime) {
        // setFollowTime, not goLive: re-pinning the right edge must not discard
        // the price zoom the user has chosen.
        r.setFollowTime(settings.follow);
      }
      if (live && settings.followPrice !== prevSettingsRef.current.followPrice) {
        const wantOn = settings.followPrice;
        // 'track' keeps the user's zoom (recentre-on-drift); never 'fit', which
        // re-frames to the book extent and discards the chosen scale.
        if (wantOn && r.priceFollow === 'off') r.setPriceFollow('track');
        else if (!wantOn && r.priceFollow !== 'off') r.setPriceFollow('off');
      }
      if (live) liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
      // A mid-session history-depth change applies LIVE (every other drawer knob
      // does): pull the newly-chosen span now, bounded to the ring by the prefetch
      // guard. A decrease is a no-op — already-loaded history stays resident.
      if (settings.historyDepth !== prevSettingsRef.current.historyDepth && settings.historyDepth !== 'off') {
        const tl = r.timeline();
        if (tl?.timeBase) r.prefetchHistory(historyDepthCols(settings.historyDepth, tl.timeBase.dtNs));
      }
    }
    // Price coverage belongs to the subscription, including the DOM-only GL
    // fallback. With no active subscription there is no instrument to re-grid.
    if (settings.priceBand !== prevSettingsRef.current.priceBand) {
      const sub = useFlowMapStore.getState().subscription;
      if (sub) {
        useFlowMapStore.getState().connectAndSubscribe(sub.market, sub.symbol, sub.mode, settings.priceBand,
          { startNs: sub.startNs, endNs: sub.endNs });
      }
    }
    prevSettingsRef.current = settings;
  }, [settings, syncChartTheme, rendererRef, prevSettingsRef, liveFollowRef]);
}
