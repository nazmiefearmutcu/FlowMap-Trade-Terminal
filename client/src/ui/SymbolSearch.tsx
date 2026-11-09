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
 *   trip); the server's substring filter is not the ranking.
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
 * The parts live beside this file: data hooks in SymbolSearchHooks.ts, the state
 * hooks (rows, venue scope, keyboard, copy) in SymbolSearchState.ts, pure helpers
 * in SymbolSearchModel.ts, rows in SymbolSearchRows.tsx, the result list in
 * SymbolSearchResults.tsx, the preview in SymbolSearchPreview.tsx and the open
 * dialog, with its scope bar, in SymbolSearchPalette.tsx.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useT } from '../i18n/useT';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';

import { loadRecents, pushRecent, type RecentPick } from './recents';
import { safeLocalStorage } from '../state/safeStorage';
import { pushOverlay } from './overlayStack';
import { useMoversWarmup, usePreviewQuotes, usePreviewWarmup, useUniverse, useWarmSymbols } from './SymbolSearchHooks';
import { searchChord, type Row } from './SymbolSearchModel';
import { paletteCopy, paletteKeyDown, scopeLabelText, useHighlightPreview, useSymbolRows, useVenueScope } from './SymbolSearchState';
import { SymbolSearchPalette } from './SymbolSearchPalette';

export interface SymbolSearchHandle {
  /** Open the palette (bound to the `/` and ⌘K/Ctrl-K global shortcuts). */
  open: () => void;
  /** Alias of `open`, for callers that focus the palette by name. */
  focus: () => void;
}

interface SymbolSearchProps {
  /** The currently subscribed `market:symbol` (shown on the trigger). */
  current: string;
  onSelect: (market: string, symbol: string) => void;
}

/** The trigger in the top bar: the current symbol and the chord that opens the palette. */
function SymbolSearchTrigger({ triggerRef, current, singleKeys, onOpen }: {
  triggerRef: RefObject<HTMLButtonElement>;
  current: string;
  singleKeys: boolean;
  onOpen: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <button
      type="button"
      ref={triggerRef}
      className="symsearch__trigger"
      data-testid="symbol-search-trigger"
      onClick={onOpen}
      aria-label={t('search.openAria')}
      title={singleKeys
        ? t('search.openTitle', { chord: searchChord() })
        : t('search.openTitleNoSlash', { chord: searchChord() })}
    >
      <span className="symsearch__icon" aria-hidden="true">
        ⌕
      </span>
      <span className="symsearch__current">{current}</span>
      <span className="symsearch__kbd" aria-hidden="true">
        {searchChord()}
      </span>
    </button>
  );
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
    const [recents, setRecents] = useState<RecentPick[]>(() => loadRecents(safeLocalStorage()));
    const universe = useUniverse(open);
    useWarmSymbols(current, recents, universe, previewQuotes);
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const venue = useVenueScope({ open, query, setQuery, setActive, inputRef });
    const { pickingVenue, setPickingVenue, chooseVenue } = venue;
    useMoversWarmup(previewQuotes);
    const { rows, recentCount } = useSymbolRows({
      scope: venue.scope, query, scopeRows: venue.scopeRows, universe, recents, previewQuotes, quoteRevision,
    });
    const count = pickingVenue ? venue.venueRows.length : rows.length;
    const active = count ? Math.min(activeState, count - 1) : 0;
    const activeRow = pickingVenue ? undefined : rows[active];
    const activeVenue = pickingVenue ? venue.venueRows[active] : undefined;
    const activeKey = useHighlightPreview({ open, pickingVenue, rows, active, activeRow, previewQuotes });

    const doOpen = useCallback(() => {
      setOpen(true);
      setQuery('');
      setActive(0);
      // The venue LIST closes, but the chosen SCOPE persists across opens — a
      // trader working one venue should not re-pick it every ⌘K.
      setPickingVenue(false);
    }, [setPickingVenue]);

    useImperativeHandle(ref, () => ({ open: doOpen, focus: doOpen }), [doOpen]);

    useEffect(() => {
      if (!open) return;
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }, [open]);

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
        setRecents(pushRecent(safeLocalStorage(), row.entry.market, row.entry.symbol, recents));
        // Route through close() so selecting restores focus to the trigger too —
        // otherwise the portal unmounts the focused input and focus drops to
        // <body>, losing a keyboard/screen-reader user's place.
        close();
      },
      [onSelect, close, recents],
    );

    const onKeyDown = paletteKeyDown({
      count, active, setActive, pickingVenue, setPickingVenue, setQuery, rows, activeVenue, chooseVenue, commit, close,
    });

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
    const { placeholder, scopeNote } = paletteCopy(t, {
      pickingVenue,
      venuesLoaded: venue.venues !== null,
      venueRowCount: venue.venueRows.length,
      venueTotal: venue.allVenues.length,
      scope: venue.scope,
      scopeState: venue.scopeState,
      scopeRowCount: venue.scopeRows?.length ?? 0,
      universeCount: universe.length,
      previewWarmup,
    });
    const scopeDepth = venue.scopeOption?.depth ? venue.scopeOption.depth.toUpperCase() : '';

    return (
      <>
        <SymbolSearchTrigger triggerRef={triggerRef} current={current} singleKeys={singleKeys} onOpen={doOpen} />
        {open && (
          <SymbolSearchPalette
            query={query}
            onQueryChange={setQuery}
            onInputKeyDown={onKeyDown}
            inputRef={inputRef}
            listRef={listRef}
            placeholder={placeholder}
            count={count}
            active={active}
            onHover={setActive}
            onClose={close}
            pickingVenue={pickingVenue}
            onTogglePicker={venue.togglePicker}
            scope={venue.scope}
            scopeLabel={scopeLabelText(t, venue.scopeOption, venue.scope)}
            scopeDepth={scopeDepth}
            scopeNote={scopeNote}
            venuesLoaded={venue.venues !== null}
            venueRows={venue.venueRows}
            venueTotal={venue.allVenues.length}
            onChooseVenue={chooseVenue}
            rows={rows}
            recentCount={recentCount}
            scopeState={venue.scopeState}
            scopeRowCount={venue.scopeRows?.length ?? 0}
            onCommit={commit}
            onRetry={venue.retryScope}
            activeVenue={activeVenue}
            activeRow={activeRow}
            shownPreview={shownPreview}
          />
        )}
      </>
    );
  },
);
