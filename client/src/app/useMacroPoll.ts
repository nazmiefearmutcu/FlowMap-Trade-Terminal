import { useEffect } from 'react';

import { fetchMacro } from '../net/macroApi';
import { useIntelligenceStore } from '../state/intelligenceStore';

/** How often the macro reading is refreshed. The public sources publish daily. */
export const MACRO_POLL_MS = 15 * 60 * 1000;

/**
 * Keeps the top bar's macro ticker current. The reading is fetched on mount and
 * every {@link MACRO_POLL_MS}. A failed fetch leaves the last reading in place,
 * and an unmount aborts the request in flight.
 */
export function useMacroPoll(): void {
  useEffect(() => {
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetchMacro(current.signal)
        .then((reading) => useIntelligenceStore.getState().setMacroReading(reading))
        .catch(() => {
          // Keep the reading on screen. An abort from unmount or from the next poll lands here too.
        });
    };
    load();
    const timer = setInterval(load, MACRO_POLL_MS);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, []);
}
