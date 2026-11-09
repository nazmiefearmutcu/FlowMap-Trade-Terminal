/**
 * The palette's result list. One listbox shows one of four things: the venue list
 * while a venue is being picked, the loading, failed or empty state of a venue
 * listing, or the symbol rows (recent picks first, then the directory).
 *
 * Each section header names the run of options that follows it: the rows sit in a
 * group labelled by that header, so a screen reader announces "Recent" or "All
 * markets" with the rows it covers. The rows stay the listbox's only options.
 */

import { useId, type ReactNode, type RefObject } from 'react';

import { formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { VenueOption } from './symbols';
import { ALL_VENUES } from './symbols';
import { SymbolRow, VenueRow } from './SymbolSearchRows';
import type { Row, ScopeState } from './SymbolSearchModel';

export interface SymbolSearchResultsProps {
  listRef: RefObject<HTMLDivElement>;
  pickingVenue: boolean;
  /** Null until the venue catalog has answered. */
  venuesLoaded: boolean;
  venueRows: readonly VenueOption[];
  /** Every venue option, the all-venues entry included. */
  venueTotal: number;
  rows: readonly Row[];
  /** How many LEADING rows are the Recent section (0 outside the empty-query directory view). */
  recentCount: number;
  scope: string;
  scopeState: ScopeState;
  /** Symbols in the chosen venue's listing. */
  scopeRowCount: number;
  query: string;
  active: number;
  onHover: (idx: number) => void;
  onChooseVenue: (market: string) => void;
  onCommit: (row: Row) => void;
  onRetry: () => void;
}

/** A labelled run of options: the visible section header is the group's name. */
function OptionGroup({ id, label, testId, children }: {
  id: string;
  label: string;
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div role="group" aria-labelledby={id}>
      <div className="sympal__section" id={id} data-testid={testId}>
        {label}
      </div>
      {children}
    </div>
  );
}

interface VenueListingProps {
  venueRows: readonly VenueOption[];
  venueTotal: number;
  venuesLoaded: boolean;
  query: string;
  active: number;
  onHover: (idx: number) => void;
  onChooseVenue: (market: string) => void;
}

/** The venue list, filtered by the palette's input while a venue is being picked. */
function VenueListing({ venueRows, venueTotal, venuesLoaded, query, active, onHover, onChooseVenue }: VenueListingProps): JSX.Element {
  const t = useT();
  const headId = useId();
  return (
    <OptionGroup id={headId} label={t('search.venuesReachable', { count: formatNumber(venueTotal - 1) })}>
      {venueRows.length === 0 ? (
        <div className="sympal__empty">
          {venuesLoaded ? t('search.noVenueMatch', { query }) : t('search.loadingVenues')}
        </div>
      ) : (
        venueRows.map((venue, idx) => (
          <VenueRow
            key={venue.market}
            venue={venue}
            idx={idx}
            active={idx === active}
            onHover={onHover}
            onChoose={onChooseVenue}
          />
        ))
      )}
    </OptionGroup>
  );
}

interface SymbolRowsProps {
  rows: readonly Row[];
  recentCount: number;
  scope: string;
  scopeRowCount: number;
  query: string;
  active: number;
  onHover: (idx: number) => void;
  onCommit: (row: Row) => void;
}

/** The symbol rows, under the header that names what they are (none while searching). */
function SymbolRows({ rows, recentCount, scope, scopeRowCount, query, active, onHover, onCommit }: SymbolRowsProps): JSX.Element {
  const t = useT();
  const headId = useId();
  const rowsFrom = (from: number, to: number): JSX.Element[] =>
    rows.slice(from, to).map((row, offset) => {
      const idx = from + offset;
      return (
        <SymbolRow
          key={`${row.entry.market}:${row.entry.symbol}`}
          row={row}
          idx={idx}
          active={idx === active}
          recent={idx < recentCount}
          onHover={onHover}
          onCommit={onCommit}
        />
      );
    });
  const emptyQuery = query.trim() === '';
  if (recentCount > 0) {
    // Recent picks first, then the rest of the directory.
    return (
      <>
        <OptionGroup id={`${headId}-recent`} label={t('search.recent')} testId="recent-section">
          {rowsFrom(0, recentCount)}
        </OptionGroup>
        {rows.length > recentCount && (
          <OptionGroup id={`${headId}-all`} label={t('search.allMarkets')}>
            {rowsFrom(recentCount, rows.length)}
          </OptionGroup>
        )}
      </>
    );
  }
  if (emptyQuery && scope !== ALL_VENUES) {
    return (
      <OptionGroup id={headId} label={t('search.scopeSection', { scope, count: formatNumber(scopeRowCount) })}>
        {rowsFrom(0, rows.length)}
      </OptionGroup>
    );
  }
  if (emptyQuery && rows.length > 0) {
    return (
      <OptionGroup id={headId} label={t('search.allMarkets')}>
        {rowsFrom(0, rows.length)}
      </OptionGroup>
    );
  }
  return <>{rowsFrom(0, rows.length)}</>;
}

/** The listbox body: venue list, listing state, empty state or symbol rows. */
export function SymbolSearchResults(props: SymbolSearchResultsProps): JSX.Element {
  const t = useT();
  const {
    listRef, pickingVenue, venuesLoaded, venueRows, venueTotal, rows, recentCount,
    scope, scopeState, scopeRowCount, query, active, onHover, onChooseVenue, onCommit, onRetry,
  } = props;
  return (
    <div
      className="sympal__list"
      ref={listRef}
      id="sympal-listbox"
      role="listbox"
      aria-label={pickingVenue ? t('search.venuesAria') : t('search.symbolsAria')}
    >
      {pickingVenue ? (
        <VenueListing
          venueRows={venueRows}
          venueTotal={venueTotal}
          venuesLoaded={venuesLoaded}
          query={query}
          active={active}
          onHover={onHover}
          onChooseVenue={onChooseVenue}
        />
      ) : scopeState === 'loading' ? (
        // The opt-in slow path: a venue's FIRST listing is a live REST round trip.
        // Say which venue and that seconds are expected. An unexplained empty list
        // would read as "no symbols".
        <div className="sympal__loading" data-testid="venue-loading" role="status" aria-live="polite">
          <span className="sympal__loadbar" aria-hidden="true" />
          {t('search.listingScope', { scope })}
        </div>
      ) : scopeState === 'failed' ? (
        // A FAILED listing is not the same claim as "this venue has no symbols": we
        // never got an answer, so we assert nothing about the venue and cache nothing.
        <div className="sympal__failed" data-testid="venue-failed" role="status" aria-live="polite">
          <span className="sympal__failed-h">{t('search.failedHead', { scope })}</span>
          <span className="sympal__failed-s">{t('search.failedBody', { scope })}</span>
          <button type="button" className="sympal__retry" data-testid="venue-retry" onClick={onRetry}>
            {t('search.retry')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="sympal__empty">
          {scope !== ALL_VENUES
            ? scopeState === 'empty'
              ? t('search.venueEmpty', { scope })
              : t('search.noMatchScope', { scope, query })
            : t('search.noSymbols', { query })}
          {scope !== ALL_VENUES && scopeState === 'empty' && (
            // The empty listing is not cached, so a retry is the honest way out.
            <button type="button" className="sympal__retry" data-testid="venue-retry" onClick={onRetry}>
              {t('search.retry')}
            </button>
          )}
        </div>
      ) : (
        <SymbolRows
          rows={rows}
          recentCount={recentCount}
          scope={scope}
          scopeRowCount={scopeRowCount}
          query={query}
          active={active}
          onHover={onHover}
          onCommit={onCommit}
        />
      )}
    </div>
  );
}
