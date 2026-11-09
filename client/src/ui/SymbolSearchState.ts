/**
 * State of the symbol palette, split out of the component so each part stays
 * small and testable: the result rows, the venue scope, the highlight's preview
 * prefetch, the keyboard and the copy shown around the input.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { formatNumber } from '../i18n/format';
import type { TFn } from '../i18n/useT';
import type { PreviewQuotes } from './previewQuotes';
import type { RecentPick } from './recents';
import { ALL_VENUES, rankVenueOptions, venueOptions, fuzzyRank, type SymbolEntry, type VenueInfo, type VenueOption } from './symbols';
import { useScopeListing, useVenueCatalog } from './SymbolSearchHooks';
import { venueText, type PreviewWarmup, type Row, type ScopeState } from './SymbolSearchModel';

/** The visible rows: a venue's listing when scoped, else recent picks and the directory. */
export function useSymbolRows(input: {
  scope: string;
  query: string;
  scopeRows: SymbolEntry[] | null;
  universe: SymbolEntry[];
  recents: RecentPick[];
  previewQuotes: PreviewQuotes;
  quoteRevision: number;
}): { rows: Row[]; recentCount: number } {
  const { scope, query, scopeRows, universe, recents, previewQuotes, quoteRevision } = input;
  // Memoized: a quote landing bumps `quoteRevision` and rebuilds the rows; an
  // unrelated render, such as a keystroke-free highlight move, reuses them.
  const rows = useMemo<Row[]>(() => {
    // The preview cache is read in place, so the revision is what tells this memo a quote changed.
    void quoteRevision;
    if (scope !== ALL_VENUES) {
      return fuzzyRank(scopeRows ?? [], query, 120).map((entry) => ({
        entry,
        quote: previewQuotes.get(`${entry.market}:${entry.symbol}`),
      }));
    }
    if (query.trim() === '') {
      const entriesByKey = new Map(universe.map((entry) => [`${entry.market}:${entry.symbol}`, entry]));
      const recentKeys = new Set(recents.map((r) => `${r.market}:${r.symbol}`));
      const recentRows: Row[] = recents.map((r) => ({
        entry: entriesByKey.get(`${r.market}:${r.symbol}`) ?? { market: r.market, symbol: r.symbol, capability: {} },
        quote: previewQuotes.get(`${r.market}:${r.symbol}`),
      }));
      const directoryRows = universe
        .filter((entry) => !recentKeys.has(`${entry.market}:${entry.symbol}`))
        .map((entry) => ({ entry, quote: previewQuotes.get(`${entry.market}:${entry.symbol}`) }));
      return [...recentRows, ...directoryRows];
    }
    return fuzzyRank(universe, query, 60).map((entry) => ({
      entry,
      quote: previewQuotes.get(`${entry.market}:${entry.symbol}`),
    }));
  }, [scope, scopeRows, query, universe, recents, previewQuotes, quoteRevision]);

  // How many LEADING rows are the Recent section (0 unless the empty-query
  // bundled-directory view) — the render uses it to place section headers.
  const recentCount = useMemo(
    () => (scope === ALL_VENUES && query.trim() === '' ? recents.length : 0),
    [scope, query, recents.length],
  );
  return { rows, recentCount };
}

export interface VenueScope {
  scope: string;
  pickingVenue: boolean;
  setPickingVenue: (picking: boolean) => void;
  scopeRows: SymbolEntry[] | null;
  scopeState: ScopeState;
  /** Null until /api/venues has answered. */
  venues: VenueInfo[] | null;
  allVenues: VenueOption[];
  venueRows: VenueOption[];
  scopeOption: VenueOption | undefined;
  chooseVenue: (market: string) => void;
  togglePicker: () => void;
  retryScope: () => void;
}

/**
 * The venue scope: `all` is the bundled directory (instant); any other venue is a
 * live listing, chosen from the venue list that shares the palette's input.
 */
export function useVenueScope(input: {
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  setActive: (index: number) => void;
  inputRef: RefObject<HTMLInputElement>;
}): VenueScope {
  const { open, query, setQuery, setActive, inputRef } = input;
  const venues = useVenueCatalog(open);
  const [scope, setScope] = useState<string>(ALL_VENUES);
  const [pickingVenue, setPickingVenue] = useState(false);
  // Bumped on every venue pick (even a re-pick of the CURRENT scope) and by the
  // retry control, so a failed listing is re-issuable without first switching
  // away to another venue and back — `scope` alone would be a no-op dep there.
  const [scopeAttempt, setScopeAttempt] = useState(0);
  const { scopeRows, scopeState, forgetScope } = useScopeListing(open, scope, scopeAttempt);
  const allVenues = useMemo(() => venueOptions(venues ?? []), [venues]);
  const venueRows = useMemo<VenueOption[]>(
    () => (pickingVenue ? rankVenueOptions(allVenues, query) : []),
    [pickingVenue, allVenues, query],
  );
  const scopeOption = useMemo(() => allVenues.find((v) => v.market === scope), [allVenues, scope]);

  /** Adopt a venue scope and drop back to the symbol list. */
  const chooseVenue = useCallback((market: string) => {
    setScope(market);
    // Count the pick itself, not just a CHANGE of scope: re-picking the venue
    // you are already scoped to is the natural "try that again" gesture after a
    // failed listing, and keying the effect on `scope` alone would ignore it.
    setScopeAttempt((n) => n + 1);
    setPickingVenue(false);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [setQuery, setActive, inputRef]);

  /** Open or close the venue list, keeping the input focused. */
  const togglePicker = useCallback(() => {
    setPickingVenue((v) => !v);
    setQuery('');
    inputRef.current?.focus();
  }, [setQuery, inputRef]);

  /** Re-issue the current venue's listing (the failure state's retry). */
  const retryScope = useCallback(() => {
    // A retry must reach the network, not the remembered (possibly outage-era) answer.
    forgetScope(scope);
    setScopeAttempt((n) => n + 1);
    inputRef.current?.focus();
  }, [scope, forgetScope, inputRef]);

  return {
    scope, pickingVenue, setPickingVenue, scopeRows, scopeState, venues, allVenues, venueRows, scopeOption,
    chooseVenue, togglePicker, retryScope,
  };
}

/**
 * Prefetches the previews the user is about to see: the highlighted row first,
 * then its neighbours. Returns the highlight's `market:symbol` key (null while
 * choosing a venue), which the preview panel reads.
 */
export function useHighlightPreview(input: {
  open: boolean;
  pickingVenue: boolean;
  rows: Row[];
  active: number;
  activeRow: Row | undefined;
  previewQuotes: PreviewQuotes;
}): string | null {
  const { open, pickingVenue, rows, active, activeRow, previewQuotes } = input;
  const activeKey = !pickingVenue && activeRow ? `${activeRow.entry.market}:${activeRow.entry.symbol}` : null;
  // The stable identity of the highlighted row. `rows` is rebuilt whenever the
  // movers or the universe resolves, so a row OBJECT changes identity on every
  // such recompute — an effect keyed on it would abort the in-flight quote every
  // time. The preview follows `market:symbol`; the latest row is read through a ref.
  const activeRowRef = useRef<Row | undefined>(activeRow);
  activeRowRef.current = activeRow;
  // A cached preview is read during render, so selection never waits for an
  // effect, debounce, or HTTP response. Missing/stale data refreshes through
  // the bounded queue; moving away leaves useful requests alive in the cache.
  useEffect(() => {
    if (!open || !activeKey) return;
    const row = activeRowRef.current;
    if (row) previewQuotes.request(row.entry.market, row.entry.symbol, true);
  }, [open, activeKey, previewQuotes]);

  // The rows inside the highlight's prefetch window. The effect is keyed on their
  // identities (`visibleKey`), not on `rows`: a quote landing rebuilds `rows` and
  // must not re-issue every preview request.
  const visibleRows = rows.slice(Math.max(0, active - 1), active + 4);
  const visibleKey = visibleRows.map((row) => `${row.entry.market}:${row.entry.symbol}`).join('\n');
  const visibleRowsRef = useRef<Row[]>(visibleRows);
  visibleRowsRef.current = visibleRows;
  useEffect(() => {
    if (!open || pickingVenue) return;
    for (const row of visibleRowsRef.current) previewQuotes.request(row.entry.market, row.entry.symbol);
  }, [open, pickingVenue, visibleKey, previewQuotes]);
  return activeKey;
}

/** Everything the keyboard can do to the palette, as plain callbacks. */
export interface PaletteKeys {
  count: number;
  active: number;
  setActive: (index: number) => void;
  pickingVenue: boolean;
  setPickingVenue: (picking: boolean) => void;
  setQuery: (query: string) => void;
  rows: Row[];
  activeVenue: VenueOption | undefined;
  chooseVenue: (market: string) => void;
  commit: (row: Row | undefined) => void;
  close: () => void;
}

/** The input's key handler: arrows and Home/End move the highlight, Enter commits, Escape backs out. */
export function paletteKeyDown(keys: PaletteKeys): (e: ReactKeyboardEvent<HTMLInputElement>) => void {
  return (e) => {
    const { count, active, setActive, pickingVenue, setPickingVenue, setQuery, rows, activeVenue } = keys;
    const last = count - 1;
    // Base navigation on the CLAMPED `active`, not a stale raw index.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (count) setActive(active >= last ? 0 : active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (count) setActive(active <= 0 ? last : active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pickingVenue) {
        if (activeVenue) keys.chooseVenue(activeVenue.market);
      } else {
        keys.commit(rows[active]);
      }
    } else if (e.key === 'Home') {
      // Jump to the first row (the list is short, but scanning it is not).
      e.preventDefault();
      if (count) setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (count) setActive(last);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Escape out of the venue list first — one keystroke should not throw
      // away the whole palette just because a sub-list is open.
      if (pickingVenue) {
        setPickingVenue(false);
        setQuery('');
      } else {
        keys.close();
      }
    }
  };
}

/** The placeholder in the input and the honest one-liner for the current scope, beside the venue button. */
export function paletteCopy(
  t: TFn,
  s: {
    pickingVenue: boolean;
    venuesLoaded: boolean;
    venueRowCount: number;
    venueTotal: number;
    scope: string;
    scopeState: ScopeState;
    scopeRowCount: number;
    universeCount: number;
    previewWarmup: PreviewWarmup | null;
  },
): { placeholder: string; scopeNote: string } {
  const placeholder = s.pickingVenue
    ? t('search.placeholderVenue')
    : s.scope === ALL_VENUES
      ? t('search.placeholderAll')
      : t('search.placeholderScope', { scope: s.scope });
  const scopeNote = s.pickingVenue
    ? s.venuesLoaded
      ? t('search.venuesOf', { count: formatNumber(s.venueRowCount), total: formatNumber(s.venueTotal) })
      : t('search.readingVenues')
    : s.scope === ALL_VENUES
      ? s.previewWarmup && s.previewWarmup.total > 0
        ? t(s.previewWarmup.warming ? 'search.symbolsPreparing' : 'search.symbolsPreviewsReady', {
          count: formatNumber(s.universeCount),
          ready: formatNumber(s.previewWarmup.ready),
          total: formatNumber(s.previewWarmup.total),
        })
        : t('search.symbolsPricesSeparate', { count: formatNumber(s.universeCount) })
      : s.scopeState === 'loading'
        ? t('search.listing')
        : s.scopeState === 'failed'
          ? t('search.listingFailed')
          : s.scopeState === 'empty'
            ? t('search.noListing')
            : t('search.symbolCount', { count: formatNumber(s.scopeRowCount) });
  return { placeholder, scopeNote };
}

/** The label of the venue button: the venue's own name, or the raw scope when it is not in the catalog. */
export function scopeLabelText(t: TFn, scopeOption: VenueOption | undefined, scope: string): string {
  return scopeOption ? venueText(t, scopeOption) : scope;
}
