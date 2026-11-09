/**
 * The open symbol palette: the portalled dialog that holds the search box, the
 * venue scope bar, the result list, the preview and the key hints. Its state and
 * keyboard handling live in SymbolSearch.tsx; this file only lays them out.
 */

import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../i18n/useT';
import { trapFocusKeyDown, type Row, type ScopeState } from './SymbolSearchModel';
import { PreviewPane } from './SymbolSearchPreview';
import { SymbolSearchResults } from './SymbolSearchResults';
import { capabilityChipClass, capabilityChipLabel, capabilityChipTitle, type VenueOption } from './symbols';
import type { PreviewQuote } from './previewQuotes';

export interface SymbolSearchPaletteProps {
  query: string;
  onQueryChange: (query: string) => void;
  onInputKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLInputElement>;
  listRef: RefObject<HTMLDivElement>;
  placeholder: string;
  /** Rows the list can select: venues while the venue list is open, else symbols. */
  count: number;
  active: number;
  onHover: (idx: number) => void;
  onClose: () => void;
  pickingVenue: boolean;
  onTogglePicker: () => void;
  scope: string;
  scopeLabel: string;
  scopeDepth: string;
  scopeNote: string;
  venuesLoaded: boolean;
  venueRows: readonly VenueOption[];
  venueTotal: number;
  onChooseVenue: (market: string) => void;
  rows: readonly Row[];
  recentCount: number;
  scopeState: ScopeState;
  scopeRowCount: number;
  onCommit: (row: Row) => void;
  onRetry: () => void;
  activeVenue: VenueOption | undefined;
  activeRow: Row | undefined;
  shownPreview: PreviewQuote | undefined;
}

/** The palette dialog, portalled to the document body over a backdrop. */
export function SymbolSearchPalette(props: SymbolSearchPaletteProps): JSX.Element {
  const t = useT();
  const { pickingVenue, scope, scopeLabel, scopeDepth, scopeNote, onClose } = props;
  return createPortal(
    <div
      className="sympal__backdrop"
      data-testid="symbol-search-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
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
            ref={props.inputRef}
            className="sympal__input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            data-testid="symbol-search-input"
            placeholder={props.placeholder}
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            onKeyDown={props.onInputKeyDown}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls="sympal-listbox"
            aria-activedescendant={props.count ? `sympal-opt-${props.active}` : undefined}
            aria-label={t('search.inputAria')}
          />
          <button type="button" className="sympal__esc" onClick={onClose} aria-label={t('search.closeAria')}>
            esc
          </button>
        </div>

        <div className="sympal__scope">
          <button
            type="button"
            className={`sympal__venuebtn${pickingVenue ? ' is-on' : ''}`}
            data-testid="venue-picker-toggle"
            aria-expanded={pickingVenue}
            onClick={props.onTogglePicker}
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
              {capabilityChipLabel(scopeDepth, t)}
            </span>
          ) : null}
          <span className="sympal__scopenote">{scopeNote}</span>
        </div>

        <div className="sympal__body">
          <SymbolSearchResults
            listRef={props.listRef}
            pickingVenue={pickingVenue}
            venuesLoaded={props.venuesLoaded}
            venueRows={props.venueRows}
            venueTotal={props.venueTotal}
            rows={props.rows}
            recentCount={props.recentCount}
            scope={scope}
            scopeState={props.scopeState}
            scopeRowCount={props.scopeRowCount}
            query={props.query}
            active={props.active}
            onHover={props.onHover}
            onChooseVenue={props.onChooseVenue}
            onCommit={props.onCommit}
            onRetry={props.onRetry}
          />
          <PreviewPane
            pickingVenue={pickingVenue}
            activeVenue={props.activeVenue}
            activeRow={props.activeRow}
            shown={props.shownPreview}
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
  );
}
