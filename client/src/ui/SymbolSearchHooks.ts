/**
 * Data hooks for the symbol palette: the preview cache and its server warm-up,
 * the bundled-directory refresh, the venue catalog, the live venue listing and
 * the movers warm-up. Each keeps one concern's fetch, cache and retry state out
 * of the palette component.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { BUNDLED_DIRECTORY } from './bundledDirectory';
import type { RecentPick } from './recents';
import { PreviewQuotes, type PreviewQuote } from './previewQuotes';
import { ALL_VENUES, marketGroup, setVenueCatalog, type SymbolEntry, type VenueInfo } from './symbols';
import {
  EMPTY_LISTING_TTL_MS,
  VENUE_LIMIT,
  getJson,
  previewStorage,
  validPreviewSnapshot,
  type PreviewSnapshot,
  type PreviewWarmup,
  type ScopeState,
} from './SymbolSearchModel';

/**
 * The shared quote cache. `onChange` fires whenever a quote lands, so the palette
 * can rebuild its rows; the cache is created once for the component's lifetime.
 */
export function usePreviewQuotes(onChange: () => void): PreviewQuotes {
  const [previewQuotes] = useState(() => new PreviewQuotes({
    storage: previewStorage(),
    fetchQuote: (market, symbol, signal) => getJson<PreviewQuote>(
      `/api/quote?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`,
      signal,
    ),
    onChange,
  }));
  useEffect(() => {
    previewQuotes.resume();
    return () => previewQuotes.dispose();
  }, [previewQuotes]);
  return previewQuotes;
}

/**
 * Pulls the server's preview warm-up while the palette is closed too. The server
 * prepares the entire catalog from startup; this endpoint reads memory and never
 * starts provider work. A generation token recovers the cursor if the desktop
 * sidecar restarts without reloading the UI.
 */
export function usePreviewWarmup(previewQuotes: PreviewQuotes): PreviewWarmup | null {
  const [previewWarmup, setPreviewWarmup] = useState<PreviewWarmup | null>(null);
  useEffect(() => {
    let stopped = false;
    let revision = 0;
    let generation = '';
    let timer: number | undefined;
    let timeout: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      const requestedAt = Date.now();
      controller = new AbortController();
      const currentController = controller;
      timeout = window.setTimeout(() => currentController.abort(), 3_000);
      const body = await getJson<PreviewSnapshot>(
        `/api/previews?after=${revision}${generation ? `&generation=${encodeURIComponent(generation)}` : ''}`,
        currentController.signal,
      );
      window.clearTimeout(timeout);
      if (stopped) return;
      let next = 3_000;
      if (validPreviewSnapshot(body)) {
        // Limit untrusted responses even though the server also caps its cache.
        for (const quote of body.quotes.slice(0, 512)) previewQuotes.put(quote, requestedAt);
        revision = body.revision;
        generation = body.generation;
        setPreviewWarmup((previous) => previous && previous.total === body.total
          && previous.completed === body.completed && previous.ready === body.ready
          && previous.warming === body.warming ? previous : {
            total: body.total, completed: body.completed, ready: body.ready, warming: body.warming,
          });
        next = body.warming ? 500 : 30_000;
      }
      timer = window.setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(timer);
      window.clearTimeout(timeout);
    };
  }, [previewQuotes]);
  return previewWarmup;
}

/**
 * Prefetches the previews of the current symbol and the recent picks before the
 * trader opens search, plus the head of the bundled directory. The bounded
 * scheduler shares requests with hover and never clears a good chart while it
 * refreshes. Sim has no provider preview to warm.
 */
export function useWarmSymbols(
  current: string,
  recents: readonly RecentPick[],
  universe: readonly SymbolEntry[],
  previewQuotes: PreviewQuotes,
): void {
  useEffect(() => {
    const separator = current.indexOf(':');
    const picks = separator > 0
      ? [{ market: current.slice(0, separator), symbol: current.slice(separator + 1) }, ...recents]
      : recents;
    for (const pick of picks) {
      if (marketGroup(pick.market) !== 'sim') previewQuotes.request(pick.market, pick.symbol, true);
    }
    for (const entry of universe.slice(0, 6)) previewQuotes.request(entry.market, entry.symbol);
  }, [current, recents, universe, previewQuotes]);
}

/**
 * The symbol list the palette searches: the bundled directory at first paint, then
 * refreshed once with the server's active capabilities. The local directory already
 * renders and searches on the very first visit; even an unavailable server cannot
 * turn it into a loading or empty screen.
 */
export function useUniverse(open: boolean): SymbolEntry[] {
  const [universe, setUniverse] = useState<SymbolEntry[]>(BUNDLED_DIRECTORY);
  const universeLoaded = useRef(false);
  useEffect(() => {
    if (!open || universeLoaded.current) return;
    const ctrl = new AbortController();
    void getJson<{ symbols: SymbolEntry[] }>('/api/universe?market=all&limit=1000', ctrl.signal).then(
      (b) => {
        if (ctrl.signal.aborted || !b?.symbols?.length) return;
        universeLoaded.current = true;
        // Keep known symbols in their first-paint order while adopting fresh
        // capabilities. Server-only entries (e.g. sim) append, rather than
        // inserting above the row a keyboard user is about to select.
        setUniverse((previous) => {
          const refreshed = new Map(b.symbols.map((entry) => [`${entry.market}:${entry.symbol}`, entry]));
          const retained = previous.flatMap((entry) => {
            const key = `${entry.market}:${entry.symbol}`;
            const fresh = refreshed.get(key);
            refreshed.delete(key);
            return fresh ? [fresh] : [];
          });
          return [...retained, ...refreshed.values()];
        });
      },
    );
    return () => ctrl.abort();
  }, [open]);
  return universe;
}

/**
 * The venue catalog, fetched ONCE. /api/venues is pure server-side (module
 * constants, no network), so this never delays the rows and lets `marketGroup`
 * answer from the server's assetClass instead of guessing. Null until it answers.
 */
export function useVenueCatalog(open: boolean): VenueInfo[] | null {
  const [venues, setVenues] = useState<VenueInfo[] | null>(null);
  useEffect(() => {
    if (!open || venues !== null) return;
    const ctrl = new AbortController();
    void getJson<{ venues: VenueInfo[] }>('/api/venues', ctrl.signal).then((b) => {
      if (!b) return; // leave `venues` null so the next open retries
      const list = b.venues ?? [];
      setVenueCatalog(list);
      setVenues(list);
    });
    return () => ctrl.abort();
  }, [open, venues]);
  return venues;
}

/**
 * The chosen venue's own listing. This is the OPT-IN slow path: the first listing
 * of a venue is a live REST round trip (about 1 to 7 s), so it reports `loading`
 * rather than an empty list, and the result is memoised per venue for the session.
 * Only an answer is cached: a failed request is never remembered as an empty list.
 */
export function useScopeListing(open: boolean, scope: string, scopeAttempt: number): {
  scopeRows: SymbolEntry[] | null;
  scopeState: ScopeState;
  forgetScope: (scope: string) => void;
} {
  const [scopeRows, setScopeRows] = useState<SymbolEntry[] | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>('idle');
  // Per-venue memo so re-picking a venue this session is instant, not another
  // multi-second listing. Held in a ref: it must survive closing the palette.
  const scopeCache = useRef(new Map<string, SymbolEntry[]>());
  // When each EMPTY listing was fetched; empty answers expire after EMPTY_LISTING_TTL_MS.
  const emptyListingAt = useRef(new Map<string, number>());

  useEffect(() => {
    if (!open || scope === ALL_VENUES) {
      setScopeRows(null);
      setScopeState('idle');
      return;
    }
    const cached = scopeCache.current.get(scope);
    if (cached && (cached.length > 0 || Date.now() - (emptyListingAt.current.get(scope) ?? 0) < EMPTY_LISTING_TTL_MS)) {
      setScopeRows(cached);
      setScopeState(cached.length > 0 ? 'ready' : 'empty');
      return;
    }
    setScopeRows(null);
    setScopeState('loading');
    const ctrl = new AbortController();
    void getJson<{ symbols: SymbolEntry[] }>(
      `/api/universe?market=${encodeURIComponent(scope)}&limit=${VENUE_LIMIT}`,
      ctrl.signal,
    ).then((b) => {
      if (ctrl.signal.aborted) return; // a newer scope superseded this listing
      if (!b) {
        // Non-2xx or a network error: we learned NOTHING about this venue. Leave the
        // cache untouched, so one transient failure is not remembered as an empty venue.
        setScopeState('failed');
        return;
      }
      const list = b.symbols ?? [];
      scopeCache.current.set(scope, list);
      if (list.length > 0) emptyListingAt.current.delete(scope);
      else emptyListingAt.current.set(scope, Date.now());
      setScopeRows(list);
      // An unreachable venue degrades to an empty body server-side rather than
      // erroring, so "no rows" is the honest signal to surface, not a spinner.
      setScopeState(list.length > 0 ? 'ready' : 'empty');
    });
    return () => ctrl.abort();
  }, [open, scope, scopeAttempt]);

  /** Drop the remembered answer so the next attempt reaches the network. */
  const forgetScope = useCallback((target: string) => {
    scopeCache.current.delete(target);
    emptyListingAt.current.delete(target);
  }, []);

  return { scopeRows, scopeState, forgetScope };
}

/** Keeps the all-venues preview columns warm (the top movers), while the palette is closed too. */
export function useMoversWarmup(previewQuotes: PreviewQuotes): void {
  useEffect(() => {
    const ctrl = new AbortController();
    const refresh = () => {
      const requestedAt = Date.now();
      for (const market of ['crypto', 'equity'] as const) {
        void getJson<{ movers: PreviewQuote[] }>(`/api/movers?market=${market}&limit=100`, ctrl.signal).then((b) => {
          if (ctrl.signal.aborted || !b) return;
          for (const quote of b.movers ?? []) previewQuotes.put(quote, requestedAt);
        });
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      ctrl.abort();
      window.clearInterval(interval);
    };
  }, [previewQuotes]);
}
