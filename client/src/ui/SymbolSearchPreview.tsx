/**
 * Preview panel of the symbol palette. It follows the highlighted row: a symbol's
 * live price, change, sparkline, honest capability chips and as-of time, or the
 * detail of the highlighted venue while the venue list is open.
 */

import { formatDateTime } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { PreviewQuote } from './previewQuotes';
import { capabilityChipClass, capabilityChipTitle, capabilityChips, marketGroup, ALL_VENUES, type VenueOption } from './symbols';
import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';
import { groupText, venueText, type Row } from './SymbolSearchModel';

interface PreviewPaneProps {
  pickingVenue: boolean;
  activeVenue: VenueOption | undefined;
  activeRow: Row | undefined;
  /** The highlighted symbol's cached quote, when one has arrived. */
  shown: PreviewQuote | undefined;
  scope: string;
}

/** The side panel: venue detail while the venue list is open, else the highlighted symbol. */
export function PreviewPane({ pickingVenue, activeVenue, activeRow, shown, scope }: PreviewPaneProps): JSX.Element {
  const t = useT();
  return (
    <aside className="sympal__preview" aria-label={t('search.previewAria')}>
      {pickingVenue ? (
        activeVenue ? (
          <>
            <div className="sympal__pv-sym">{venueText(t, activeVenue)}</div>
            <div className="sympal__pv-mkt">
              {activeVenue.market === ALL_VENUES ? t('search.bundled') : groupText(t, activeVenue.group)}
            </div>
            <div className="sympal__pv-note">
              {activeVenue.market === ALL_VENUES
                ? t('search.venueCurated')
                : activeVenue.native
                  ? t('search.venueNative')
                  : t('search.venueCcxt')}
            </div>
            <div className="sympal__pv-caps">
              {activeVenue.depth ? (
                <span
                  className={capabilityChipClass(activeVenue.depth.toUpperCase())}
                  title={capabilityChipTitle(activeVenue.depth.toUpperCase(), t)}
                >
                  {activeVenue.depth.toUpperCase()}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <div className="sympal__pv-note">{t('search.pickVenue')}</div>
        )
      ) : activeRow ? (
        <SymbolPreview row={activeRow} shown={shown} />
      ) : (
        <div className="sympal__pv-note">
          {scope === ALL_VENUES
            ? t('search.typeAll')
            : t('search.typeScope', { scope })}
        </div>
      )}
    </aside>
  );
}

interface SymbolPreviewProps {
  row: Row;
  shown: PreviewQuote | undefined;
}

/** The highlighted symbol's price, change, sparkline, capability chips and freshness. */
function SymbolPreview({ row, shown }: SymbolPreviewProps): JSX.Element {
  const t = useT();
  const previewDir = shown ? sparkDirection(shown.spark) : 0;
  // Dates follow the UI locale, not the browser default.
  const previewAsOf = shown?.asOf
    ? formatDateTime(shown.asOf / 1e6, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  // Stale copy must match the market: crypto trades 24/7, so "market closed" is a
  // false reason there. Equities say the market is closed.
  const staleGroup = marketGroup(row.entry.market);
  const staleAgeSec = shown?.asOf
    ? Math.max(0, Math.round((Date.now() - shown.asOf / 1e6) / 1000))
    : null;
  const staleText = staleGroup === 'crypto'
    ? staleAgeSec !== null ? t('search.staleCrypto', { age: `${staleAgeSec} ${t('unit.s')}` }) : t('search.staleCryptoNoAge')
    : t('search.marketClosed');
  return (
    <>
      <div className="sympal__pv-sym">{row.entry.symbol}</div>
      <div className="sympal__pv-mkt">{row.entry.market}</div>
      <div className={`sympal__pv-px ${previewDir >= 0 ? 'is-up' : 'is-down'}`}>
        {fmtPrice(shown?.price)}
      </div>
      <div className={`sympal__pv-chg ${(shown?.changePct ?? 0) >= 0 ? 'is-up' : 'is-down'}`}>
        {fmtPct(shown?.changePct)}
      </div>
      {shown?.spark?.length ? (
        <svg className="sympal__pv-spark" viewBox="0 0 220 60" preserveAspectRatio="none" aria-hidden="true">
          <path d={sparkPath(shown.spark, 220, 60, 3)} className={previewDir >= 0 ? 'spark-up' : 'spark-down'} fill="none" />
        </svg>
      ) : (
        <div className="sympal__pv-note">
          {shown?.reachable === false ? t('search.dataUnavailable') : t('search.loadingPreview')}
        </div>
      )}
      <div className="sympal__pv-caps">
        {capabilityChips(row.entry.capability).map((c) => (
          <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c, t)}>
            {c}
          </span>
        ))}
      </div>
      {shown?.stale && <div className="sympal__pv-stale">{staleText}</div>}
      {previewAsOf && <div className="sympal__pv-note">{t('search.asOf', { time: previewAsOf })}</div>}
    </>
  );
}
