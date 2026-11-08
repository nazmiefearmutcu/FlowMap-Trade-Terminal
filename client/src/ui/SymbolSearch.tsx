/**
 * Dual-market symbol palette (top bar) — a big, centre-screen search modal in the
 * shape traders expect from TradingView / an exchange search box.
 *
 * - A compact TRIGGER lives in the top bar (current symbol + a ⌘K hint). Clicking
 *   it — or the `/` and ⌘K / Ctrl-K global shortcuts (see input/keys.ts + App) —
 *   opens the modal, which is portalled to <body> and centred over a backdrop.
 * - On open (empty query) it shows the entire bundled directory immediately,
 *   with recent picks first. Prices and sparklines enrich those rows separately
 *   (GET /api/movers), never delaying or moving a selectable symbol.
 * - Typing fuzzy-ranks the FULL curated universe (GET /api/universe, fetched once
 *   and matched locally, so it is instant and not a per-keystroke server round
 *   trip) — the substring-only server filter is no longer the ranking.
 * - The active row drives a live preview panel (price / % change / sparkline /
 *   honest capability chips) via GET /api/quote.
 * - Clicking the backdrop, pressing Escape, or selecting a row closes it;
 *   selecting reports `(market, symbol)` up so the App re-subscribes.
 *
 * VENUE SCOPE. The engine reaches ~106 venues, far more than the bundled
 * directory browses, so the palette carries a scope. `all` (the default) is the
 * bundled cross-venue directory and stays the FAST PATH: opening the palette
 * never blocks on a venue. Choosing a venue from the venue list is the opt-in
 * that costs a round trip — `/api/universe?market=<venue>` enumerates it live,
 * in that venue's own symbol spelling, and the FIRST call for a venue can take
 * seconds, so it renders an explicit loading state and the ANSWER is cached per
 * venue for the session (the server caches it for 15 min besides). Only an
 * answer: a listing that FAILED is never cached, because caching one bad second
 * as `[]` would kill the venue for the rest of the session. The chosen scope
 * survives closing the palette; and the three outcomes read as three different
 * things — a venue that listed nothing says so, a listing that failed says THAT
 * and offers a retry, and neither looks like an empty search.
 *
 * Symmetry / honesty: capability chips are shown verbatim off the feed's
 * descriptor, so an equity symbol that cannot reach L2 depth or a true CVD reads
 * `SYNTH` / `SIDE NA` rather than pretending parity with crypto, and a ccxt-served
 * venue reads `L2-SNAPSHOT` rather than borrowing a native feed's `L2`. A symbol
 * whose quote provider is unreachable shows "data unavailable".
 *
 * The parts live beside this file: data hooks in SymbolSearchHooks.ts, pure
 * helpers in SymbolSearchModel.ts, rows in SymbolSearchRows.tsx, the result list
 * in SymbolSearchResults.tsx and the preview in SymbolSearchPreview.tsx.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/useT';
import { formatNumber } from '../i18n/format';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';

import {
  ALL_VENUES,
  capabilityChipClass,
  capabilityChipTitle,
  fuzzyRank,
  rankVenueOptions,
  venueOptions,
  type VenueOption,
} from './symbols';
import { loadRecents, pushRecent, type RecentPick } from './recents';
import { pushOverlay } from './overlayStack';
import { useMoversWarmup, usePreviewQuotes, usePreviewWarmup, useScopeListing, useUniverse, useVenueCatalog, useWarmSymbols } from './SymbolSearchHooks';
import { searchChord, trapFocusKeyDown, venueText, type Row } from './SymbolSearchModel';
import { PreviewPane } from './SymbolSearchPreview';
import { SymbolSearchResults } from './SymbolSearchResults';

export interface SymbolSearchHandle {
  /** Open the palette (bound to the `/` and ⌘K/Ctrl-K global shortcuts). */
  open: () => void;
  /** Back-compat alias used by the older `/`-focus wiring. */
  focus: () => void;
}

interface SymbolSearchProps {
  /** The currently subscribed `market:symbol` (shown on the trigger). */
  current: string;
  onSelect: (market: string, symbol: string) => void;
}

export const SymbolSearch = forwardRef<SymbolSearchHandle, SymbolSearchProps>(
  function SymbolSearch({ current, onSelect }, ref) {
    const t = useT();
    const singleKeys = useSingleKeyShortcuts();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // Raw highlight index; the RENDER-time `active` below clamps it to the current
    // row count so a shrinking result set can never reference an out-of-bounds row
    // for a frame (a post-commit clamp effect would leave one bad frame committed).
    const [activeState, setActive] = useState(0);
    const [quoteRevision, setQuoteRevision] = useState(0);
    const previewQuotes = usePreviewQuotes(() => setQuoteRevision((revision) => revision + 1));
    const previewWarmup = usePreviewWarmup(previewQuotes);
    // Recent picks (localStorage, max 5, most recent first) — shown as their own
    // section above the directory when the query is empty. Read once at mount; a
    // pick rewrites both the persisted list and this state.
    const [recents, setRecents] = useState<RecentPick[]>(() =>
      loadRecents(typeof window !== 'undefined' ? window.localStorage : null),
    );
    const universe = useUniverse(open);
    useWarmSymbols(current, recents, universe, previewQuotes);
    // Venue scope: `all` = the bundled directory (instant), else a market string
    // enumerated live. `venues === null` means /api/venues has not answered yet.
    const venues = useVenueCatalog(open);
    const [scope, setScope] = useState<string>(ALL_VENUES);
    const [pickingVenue, setPickingVenue] = useState(false);
    // Bumped on every venue pick (even a re-pick of the CURRENT scope) and by the
    // retry control, so a failed listing is re-issuable without first switching
    // away to another venue and back — `scope` alone would be a no-op dep there.
    const [scopeAttempt, setScopeAttempt] = useState(0);
    const { scopeRows, scopeState, forgetScope } = useScopeListing(open, scope, scopeAttempt);
    useMoversWarmup(previewQuotes);
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const doOpen = useCallback(() => {
      setOpen(true);
      setQuery('');
      setActive(0);
      // The venue LIST closes, but the chosen SCOPE persists across opens — a
      // trader working one venue should not re-pick it every ⌘K.
      setPickingVenue(false);
    }, []);

    useImperativeHandle(ref, () => ({ open: doOpen, focus: doOpen }), [doOpen]);

    useEffect(() => {
      if (!open) return;
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }, [open]);

    // The visible rows. Scoped to a venue: that venue's own listing, browsable on
    // an empty query. Scoped to `all`: recent picks + the COMPLETE directory on
    // an empty query, deduped. Movers only fill quote columns, keeping keyboard
    // targets stable while either provider is slow or unavailable.
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

    // The venue list reuses the SAME input as its filter, so the palette stays one
    // box with two modes rather than growing a second search field.
    const allVenues = useMemo(() => venueOptions(venues ?? []), [venues]);
    const venueRows = useMemo<VenueOption[]>(
      () => (pickingVenue ? rankVenueOptions(allVenues, query) : []),
      [pickingVenue, allVenues, query],
    );
    const scopeOption = useMemo(
      () => allVenues.find((v) => v.market === scope),
      [allVenues, scope],
    );

    const count = pickingVenue ? venueRows.length : rows.length;
    const active = count ? Math.min(activeState, count - 1) : 0;
    const activeRow = pickingVenue ? undefined : rows[active];
    const activeVenue = pickingVenue ? venueRows[active] : undefined;

    // The stable identity of the highlighted row. `rows` is rebuilt whenever the
    // movers or the universe resolves, so a row OBJECT changes identity on every
    // such recompute — an effect keyed on it would abort the in-flight quote every
    // time. The preview follows `market:symbol`; the latest row is read through a ref.
    const activeKey = !pickingVenue && activeRow
      ? `${activeRow.entry.market}:${activeRow.entry.symbol}`
      : null;
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

    const close = useCallback(() => {
      setOpen(false);
      triggerRef.current?.focus();
    }, []);

    // The palette joins the open-overlay registry while open (ui/overlayStack):
    // the settings drawer's and shortcuts overlay's window-level Escape handlers
    // defer to the registry's topmost surface, so a single Escape can never
    // close this palette AND another modal in the same keystroke.
    useEffect(() => (open ? pushOverlay('palette') : undefined), [open]);

    const commit = useCallback(
      (row: Row | undefined) => {
        if (!row) return;
        onSelect(row.entry.market, row.entry.symbol);
        // Record the pick as a recent (localStorage, max 5, deduped, MRU first)
        // so the next empty-query open surfaces it above the directory.
        setRecents(
          pushRecent(
            typeof window !== 'undefined' ? window.localStorage : null,
            row.entry.market,
            row.entry.symbol,
            recents,
          ),
        );
        // Route through close() so selecting restores focus to the trigger too —
        // otherwise the portal unmounts the focused input and focus drops to
        // <body>, losing a keyboard/screen-reader user's place.
        close();
      },
      [onSelect, close, recents],
    );

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
    }, []);

    /** Re-issue the current venue's listing (the failure state's retry). */
    const retryScope = useCallback(() => {
      // A retry must reach the network, not the remembered (possibly outage-era) answer.
      forgetScope(scope);
      setScopeAttempt((n) => n + 1);
      inputRef.current?.focus();
    }, [scope, forgetScope]);

    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
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
          if (activeVenue) chooseVenue(activeVenue.market);
        } else {
          commit(rows[active]);
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
          close();
        }
      }
    };

    // Reset the highlight to the top whenever the query or the mode changes.
    // Shrinking result sets are handled by the render-time clamp on `active`, not
    // a post-commit effect, so no out-of-bounds frame can commit.
    useEffect(() => setActive(0), [query, pickingVenue]);
    // Keep the highlighted row scrolled into view.
    useEffect(() => {
      if (!open) return;
      listRef.current?.querySelector(`#sympal-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const shownPreview = activeKey ? previewQuotes.get(activeKey) : undefined;
    const scopeLabel = scopeOption ? venueText(t, scopeOption) : scope;
    const scopeDepth = scopeOption?.depth ? scopeOption.depth.toUpperCase() : '';
    const placeholder = pickingVenue
      ? t('search.placeholderVenue')
      : scope === ALL_VENUES
        ? t('search.placeholderAll')
        : t('search.placeholderScope', { scope });

    /** The honest one-liner for the current scope, beside the venue button. */
    const scopeNote = pickingVenue
      ? venues === null
        ? t('search.readingVenues')
        : t('search.venuesOf', { count: formatNumber(venueRows.length), total: formatNumber(allVenues.length) })
      : scope === ALL_VENUES
        ? previewWarmup && previewWarmup.total > 0
          ? t(previewWarmup.warming ? 'search.symbolsPreparing' : 'search.symbolsPreviewsReady', {
            count: formatNumber(universe.length),
            ready: formatNumber(previewWarmup.ready),
            total: formatNumber(previewWarmup.total),
          })
          : t('search.symbolsPricesSeparate', { count: formatNumber(universe.length) })
        : scopeState === 'loading'
          ? t('search.listing')
          : scopeState === 'failed'
            ? t('search.listingFailed')
            : scopeState === 'empty'
              ? t('search.noListing')
              : t('search.symbolCount', { count: formatNumber(scopeRows?.length ?? 0) });

    return (
      <>
        <button
          type="button"
          ref={triggerRef}
          className="symsearch__trigger"
          data-testid="symbol-search-trigger"
          onClick={doOpen}
          aria-label={t('search.openAria')}
          title={singleKeys
            ? t('search.openTitle', { chord: searchChord() })
            : t('search.openTitleChord', { chord: searchChord() })}
        >
          <span className="symsearch__icon" aria-hidden="true">
            ⌕
          </span>
          <span className="symsearch__current">{current}</span>
          <span className="symsearch__kbd" aria-hidden="true">
            {searchChord()}
          </span>
        </button>

        {open &&
          createPortal(
            <div
              className="sympal__backdrop"
              data-testid="symbol-search-backdrop"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <div
                className="sympal"
                role="dialog"
                aria-modal="true"
                aria-label={t('search.dialogAria')}
                onKeyDown={trapFocusKeyDown}
              >
                <div className="sympal__head">
                  <span className="sympal__icon" aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    ref={inputRef}
                    className="sympal__input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="symbol-search-input"
                    placeholder={placeholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded
                    aria-controls="sympal-listbox"
                    aria-activedescendant={count ? `sympal-opt-${active}` : undefined}
                    aria-label={t('search.inputAria')}
                  />
                  <button type="button" className="sympal__esc" onClick={close} aria-label={t('search.closeAria')}>
                    esc
                  </button>
                </div>

                <div className="sympal__scope">
                  <button
                    type="button"
                    className={`sympal__venuebtn${pickingVenue ? ' is-on' : ''}`}
                    data-testid="venue-picker-toggle"
                    aria-expanded={pickingVenue}
                    onClick={() => {
                      setPickingVenue((v) => !v);
                      setQuery('');
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="sympal__venuebtn-k">{t('search.venueLabel')}</span>
                    <span className="sympal__venuebtn-v" data-testid="venue-scope">
                      {scopeLabel}
                    </span>
                    <span className="sympal__venuebtn-c" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {scopeDepth ? (
                    <span className={capabilityChipClass(scopeDepth)} title={capabilityChipTitle(scopeDepth, t)}>
                      {scopeDepth}
                    </span>
                  ) : null}
                  <span className="sympal__scopenote">{scopeNote}</span>
                </div>

                <div className="sympal__body">
                  <SymbolSearchResults
                    listRef={listRef}
                    pickingVenue={pickingVenue}
                    venuesLoaded={venues !== null}
                    venueRows={venueRows}
                    venueTotal={allVenues.length}
                    rows={rows}
                    recentCount={recentCount}
                    scope={scope}
                    scopeState={scopeState}
                    scopeRowCount={scopeRows?.length ?? 0}
                    query={query}
                    active={active}
                    onHover={setActive}
                    onChooseVenue={chooseVenue}
                    onCommit={commit}
                    onRetry={retryScope}
                  />
                  <PreviewPane
                    pickingVenue={pickingVenue}
                    activeVenue={activeVenue}
                    activeRow={activeRow}
                    shown={shownPreview}
                    scope={scope}
                  />
                </div>

                <div className="sympal__foot">
                  <span><kbd>↑↓</kbd> {t('search.hintNavigate')}</span>
                  <span><kbd>Home/End</kbd> {t('search.hintEdges')}</span>
                  <span><kbd>↵</kbd> {t('search.hintSelect')}</span>
                  <span><kbd>esc</kbd> {pickingVenue ? t('search.hintBack') : t('search.hintClose')}</span>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </>
    );
  },
);
