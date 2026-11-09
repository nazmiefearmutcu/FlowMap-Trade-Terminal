/**
 * The watchlist panel's data hooks: the live price of the active symbol (from the
 * local book, coalesced to ten updates a second) and the shared quote feed for
 * every watched symbol. The panel never talks to the network itself.
 */

import { useEffect, useState } from 'react';

import { subscribeQuotes } from '../state/quoteFeed';
import { getSnapshot, subscribe } from '../state/bookStore';
import {
  LIVE_QUOTE_INTERVAL_MS,
  LIVE_QUOTE_STALE_MS,
  activeWatchQuote,
  type ActiveWatchQuote,
  type WatchQuote,
} from './WatchlistQuotes';

/**
 * The active symbol's live price while `liveEligible`, else null. Local display
 * bridge only: the shared HTTP cache and alert monitor never see it.
 */
export function useLiveActiveQuote(liveEligible: boolean, sessionKey: string): ActiveWatchQuote | null {
  const [activeQuote, setActiveQuote] = useState<ActiveWatchQuote | null>(null);

  // Coalesce the <=60Hz book notifications into at most ten price updates/sec.
  useEffect(() => {
    setActiveQuote(null);
    if (!liveEligible) return undefined;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPublished = -Infinity;
    let sessionVersion = getSnapshot().sessionVersion;
    const publish = (): void => {
      updateTimer = null;
      lastPublished = performance.now();
      const quote = activeWatchQuote(getSnapshot(), sessionKey);
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null;
      if (quote) {
        quote.stale = performance.now() - quote.receivedAtMs >= LIVE_QUOTE_STALE_MS;
        if (!quote.stale) {
          staleTimer = setTimeout(() => {
            setActiveQuote((prev) => prev ? { ...prev, stale: true } : null);
          }, Math.max(0, LIVE_QUOTE_STALE_MS - (performance.now() - quote.receivedAtMs)));
        }
      }
      setActiveQuote((prev) => prev?.price === quote?.price && prev?.source === quote?.source
        && prev?.receivedAtMs === quote?.receivedAtMs && prev?.stale === quote?.stale ? prev : quote);
    };
    const off = subscribe((snap) => {
      if (snap.sessionVersion !== sessionVersion) {
        sessionVersion = snap.sessionVersion;
        // A reset is safety metadata, not a price update; clear immediately.
        setActiveQuote(null);
      }
      if (updateTimer !== null) return;
      const wait = LIVE_QUOTE_INTERVAL_MS - (performance.now() - lastPublished);
      if (wait <= 0) publish();
      else updateTimer = setTimeout(publish, wait);
    });
    publish();
    return () => {
      off();
      if (updateTimer !== null) clearTimeout(updateTimer);
      if (staleTimer !== null) clearTimeout(staleTimer);
    };
  }, [liveEligible, sessionKey]);

  return activeQuote;
}

/**
 * The shared quote feed for the whole list: one subscription, and an empty list
 * opens none. `watchKeys` identity is stable between mutations, so the feed
 * re-subscribes exactly on add/remove and cleans up on unmount.
 */
export function useWatchQuotes(watchKeys: readonly string[]): Record<string, WatchQuote> {
  const [quotes, setQuotes] = useState<Record<string, WatchQuote>>({});

  useEffect(() => {
    setQuotes((prev) => {
      // Drop quotes for removed symbols: a re-add must not flash the old price.
      const next: Record<string, WatchQuote> = {};
      for (const k of watchKeys) {
        const q = prev[k];
        if (q !== undefined) next[k] = q;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    if (watchKeys.length === 0) return undefined;
    return subscribeQuotes([...watchKeys], (key: string, quote: WatchQuote) => {
      setQuotes((prev) => ({ ...prev, [key]: quote }));
    });
  }, [watchKeys]);

  return quotes;
}
