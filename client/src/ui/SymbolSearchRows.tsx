/**
 * Result rows of the symbol palette: a directory symbol with its quote columns
 * and depth chip, and a venue entry in the venue list.
 */

import { useT } from '../i18n/useT';
import { capabilityChipClass, capabilityChipLabel, capabilityChipTitle, capabilityChips, marketGroup, type VenueOption } from './symbols';
import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';
import { groupText, venueText, type Row } from './SymbolSearchModel';

interface SymbolRowProps {
  row: Row;
  idx: number;
  active: boolean;
  /** True for a row in the Recent section above the directory. */
  recent: boolean;
  onHover: (idx: number) => void;
  onCommit: (row: Row) => void;
}

/** One selectable symbol: group chip, symbol, sparkline or depth chip, price and change. */
export function SymbolRow({ row, idx, active, recent, onHover, onCommit }: SymbolRowProps): JSX.Element {
  const t = useT();
  const g = marketGroup(row.entry.market);
  const chg = row.quote?.changePct ?? null;
  const dir = sparkDirection(row.quote?.spark ?? []);
  return (
    <div
      id={`sympal-opt-${idx}`}
      className={`sympal__row${active ? ' is-active' : ''}`}
      role="option"
      aria-selected={active}
      data-testid="symbol-row"
      data-market={row.entry.market}
      data-symbol={row.entry.symbol}
      data-recent={recent ? 'true' : undefined}
      onMouseEnter={() => onHover(idx)}
      onMouseDown={(e) => {
        e.preventDefault();
        onCommit(row);
      }}
    >
      <span className={`sympal__grp sympal__grp--${g}`}>{groupText(t, g)}</span>
      <span className="sympal__sym">{row.entry.symbol}</span>
      {row.quote?.spark?.length ? (
        <svg className="sympal__spark" viewBox="0 0 56 18" preserveAspectRatio="none" aria-hidden="true">
          <path
            d={sparkPath(row.quote.spark, 56, 18)}
            className={dir >= 0 ? 'spark-up' : 'spark-down'}
            fill="none"
          />
        </svg>
      ) : (
        // The DEPTH chip only: it is the fidelity claim that decides whether a row
        // is worth opening, and the 11-character `L2-SNAPSHOT` would wrap the full
        // set to three lines per row. The complete honest set is in the preview
        // panel, which follows the highlighted row.
        <span className="sympal__caps">
          {capabilityChips(row.entry.capability)
            .slice(0, 1)
            .map((c) => (
              <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c, t)}>
                {capabilityChipLabel(c, t)}
              </span>
            ))}
        </span>
      )}
      <span className="sympal__px">{fmtPrice(row.quote?.price)}</span>
      <span className={`sympal__chg${chg == null ? '' : chg >= 0 ? ' is-up' : ' is-down'}`}>
        {fmtPct(chg)}
      </span>
    </div>
  );
}

interface VenueRowProps {
  venue: VenueOption;
  idx: number;
  active: boolean;
  onHover: (idx: number) => void;
  onChoose: (market: string) => void;
}

/** One venue in the venue list: its group chip, label and depth chip. */
export function VenueRow({ venue, idx, active, onHover, onChoose }: VenueRowProps): JSX.Element {
  const t = useT();
  return (
    <div
      id={`sympal-opt-${idx}`}
      className={`sympal__vrow${active ? ' is-active' : ''}`}
      role="option"
      aria-selected={active}
      data-testid="venue-row"
      data-market={venue.market}
      onMouseEnter={() => onHover(idx)}
      onMouseDown={(e) => {
        e.preventDefault();
        onChoose(venue.market);
      }}
    >
      <span className={`sympal__grp sympal__grp--${venue.group}`}>
        {groupText(t, venue.group)}
      </span>
      <span className="sympal__sym">{venueText(t, venue)}</span>
      <span className="sympal__vmeta">
        {venue.depth ? (
          <span
            className={capabilityChipClass(venue.depth.toUpperCase())}
            title={capabilityChipTitle(venue.depth.toUpperCase(), t)}
          >
            {venue.depth.toUpperCase()}
          </span>
        ) : null}
      </span>
    </div>
  );
}
