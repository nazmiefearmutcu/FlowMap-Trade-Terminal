/**
 * The palette's result list. One listbox shows one of four things: the venue list
 * while a venue is being picked, the loading, failed or empty state of a venue
 * listing, or the symbol rows (recent picks first, then the directory).
 */

import { Fragment, type RefObject } from 'react';

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
        <>
          <div className="sympal__section">{t('search.venuesReachable', { count: formatNumber(venueTotal - 1) })}</div>
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
        </>
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
        <>
          {query.trim() === '' && scope !== ALL_VENUES && (
            <div className="sympal__section">{t('search.scopeSection', { scope, count: formatNumber(scopeRowCount) })}</div>
          )}
          {query.trim() === '' && scope === ALL_VENUES && recentCount === 0 && rows.length > 0 && (
            <div className="sympal__section">{t('search.allMarkets')}</div>
          )}
          {rows.map((row, idx) => (
            // Section headers ride INSIDE the map so they scroll with their rows:
            // Recent first, then All markets.
            <Fragment key={`${row.entry.market}:${row.entry.symbol}`}>
              {idx === 0 && recentCount > 0 && (
                <div className="sympal__section" data-testid="recent-section">
                  {t('search.recent')}
                </div>
              )}
              {idx === recentCount && recentCount > 0 && (
                <div className="sympal__section">{t('search.allMarkets')}</div>
              )}
              <SymbolRow
                row={row}
                idx={idx}
                active={idx === active}
                recent={idx < recentCount}
                onHover={onHover}
                onCommit={onCommit}
              />
            </Fragment>
          ))}
        </>
      )}
    </div>
  );
}
