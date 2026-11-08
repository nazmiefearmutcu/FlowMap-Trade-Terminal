import { useEffect, type MutableRefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { historyDepthCols, type FlowMapSettings } from '../ui/settings';

/** How often the prefetch waits for the first column to learn the epoch's dt. */
export const HISTORY_PREFETCH_POLL_MS = 400;

/**
 * First-launch history prefetch (once per session). When the chosen depth is not
 * 'off', wait for the first column (so the epoch's dt is known), translate the
 * wall-clock depth to columns, and eagerly pull that much history into the ring
 * so scroll-back is instant. Re-runs when the session identity changes.
 */
export function useHistoryPrefetch(
  subKey: string | null,
  rendererRef: MutableRefObject<Pick<Renderer, 'timeline' | 'prefetchHistory'> | null>,
  settingsRef: MutableRefObject<FlowMapSettings>,
): void {
  useEffect(() => {
    // Skip inside the e2e test harnesses (?scrollback / ?perf / …): those drive
    // history + residency deterministically, and an eager auto-prefetch would
    // pollute their request-count / LRU assertions.
    const p = new URLSearchParams(window.location.search);
    if (import.meta.env.DEV && ['scrollback', 'perf', 'normalize', 'overlays', 'panels'].some((m) => p.get(m) === '1')) return;
    let done = false;
    const id = window.setInterval(() => {
      if (done) return;
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) return; // wait for the first data
      // Read the depth LIVE (not captured at setup) so a choice made during the
      // boot window before the first column takes effect.
      const depth = settingsRef.current.historyDepth;
      if (depth !== 'off') rendererRef.current?.prefetchHistory(historyDepthCols(depth, tl.timeBase.dtNs));
      done = true;
      window.clearInterval(id);
    }, HISTORY_PREFETCH_POLL_MS);
    return () => window.clearInterval(id);
  }, [subKey, rendererRef, settingsRef]);
}
