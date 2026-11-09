/**
 * One watchlist row: the star, the symbol (the keyboard control), the source tag,
 * the sparkline, the price and change, the talent and jet chips, and the remove
 * button. The row markup is a list item; the star and remove buttons are its
 * siblings, so the row click stays a pointer convenience.
 */

import { formatFixed, formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { CorporateJetData, TalentData } from '../state/intelligenceStore';
import { removeFromWatchlist, toggleWatchlist } from '../watchlist/store';
import { sparkPath } from './spark';
import {
  quoteChangeText,
  quoteDirection,
  quotePriceText,
  symbolOf,
  type ActiveWatchQuote,
  type WatchQuote,
} from './WatchlistQuotes';

const SPARK_W = 64;
const SPARK_H = 16;

export interface WatchlistRowProps {
  watchKey: string;
  activeKey: string;
  /** The active symbol's live price, already gated to this session (null otherwise). */
  liveQuote: ActiveWatchQuote | null;
  /** The shared quote feed's latest value for this key. */
  network: WatchQuote | undefined;
  talentMap: Record<string, TalentData>;
  corporateJets: readonly CorporateJetData[];
  onSelect: (key: string) => void;
}

export function WatchlistRow({
  watchKey,
  activeKey,
  liveQuote,
  network,
  talentMap,
  corporateJets,
  onSelect,
}: WatchlistRowProps) {
  const t = useT();
  const live = watchKey === activeKey ? liveQuote : null;
  const q = live ? { ...network, price: live.price, stale: live.stale, reachable: true,
    changePct: network?.reachable === false ? null : network?.changePct } : network;
  const source = live?.source ?? (q ? 'snapshot' : 'none');
  const dir = quoteDirection(q);
  const stale = q?.stale === true;
  const unreachable = q?.reachable === false;
  const available = quotePriceText(q) !== '—';
  const d = q && available && q.spark && q.spark.length > 1 ? sparkPath(q.spark, SPARK_W, SPARK_H) : '';
  const symbol = symbolOf(watchKey);
  const talent = talentMap[symbol.toUpperCase()];
  const isMaHub = corporateJets.some((j) => j.symbol === symbol.toUpperCase() && j.isMaHub);

  return (
    <li
      className={`watchlist__row${watchKey === activeKey ? ' is-active' : ''}${
        stale ? ' is-stale' : ''
      }${unreachable ? ' is-unreachable' : ''}`}
      onClick={() => onSelect(watchKey)}
      title={watchKey}
      data-testid={`watchlist-row-${watchKey}`}
      data-key={watchKey}
      data-source={source}
    >
      <button
        type="button"
        className="watchlist__star"
        aria-label={t('watchlist.starAria', { symbol })}
        onClick={(e) => {
          e.stopPropagation();
          toggleWatchlist(watchKey);
        }}
        data-testid={`watchlist-star-${watchKey}`}
      >
        ★
      </button>
      <span className="watchlist__identity">
        <button
          type="button"
          className="watchlist__sym"
          data-testid={`watchlist-select-${watchKey}`}
          aria-current={watchKey === activeKey ? 'true' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(watchKey);
          }}
        >
          {symbol}
        </button>
        <span className="watchlist__source" data-testid={`watchlist-source-${watchKey}`}
          title={live ? t('watchlist.liveTitle') : t('watchlist.snapshotTitle')}>
          {source === 'live-mid'
            ? t('watchlist.source.liveMid')
            : source === 'live-last'
              ? t('watchlist.source.liveLast')
              : t('watchlist.source.snapshot')}
        </span>
      </span>
      <svg
        className="watchlist__spark"
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        aria-hidden="true"
      >
        {d && <path className={`watchlist__spark-path is-${dir}`} d={d} />}
      </svg>
      <span
        className={`watchlist__px${unreachable ? ' is-empty' : ''}`}
        data-testid={`watchlist-price-${watchKey}`}
        data-raw-price={quotePriceText(q) === '—' ? undefined : q?.price ?? undefined}
      >
        {quotePriceText(q)}
      </span>
      <span
        className={`watchlist__chg is-${dir}`}
        data-testid={`watchlist-change-${watchKey}`}
        title={t('watchlist.changeTitle')}
      >
        {quoteChangeText(q)}
      </span>
      {talent && Number.isFinite(talent.talentDeltaPct) && Number.isFinite(talent.rdOpenings) && (
        <span
          className={`watchlist__chip watchlist__talent is-${talent.talentDeltaPct >= 0 ? 'pos' : 'neg'}`}
          title={t('watchlist.talentTitle', {
            delta: `${talent.talentDeltaPct >= 0 ? '+' : ''}${formatFixed(talent.talentDeltaPct, 1)}`,
            count: formatNumber(talent.rdOpenings),
          })}
          data-testid={`watchlist-talent-${watchKey}`}
        >
          {talent.talentDeltaPct >= 0 ? '+' : ''}{formatFixed(talent.talentDeltaPct, 0)}%
        </span>
      )}
      {isMaHub && <WatchlistJetChip watchKey={watchKey} />}
      {unreachable ? (
        <span
          className="watchlist__chip watchlist__chip--na"
          data-testid={`watchlist-nodata-${watchKey}`}
        >
          {t('watchlist.noData')}
        </span>
      ) : stale ? (
        <span
          className="watchlist__chip watchlist__chip--stale"
          data-testid={`watchlist-stale-${watchKey}`}
        >
          {t('watchlist.stale')}
        </span>
      ) : null}
      <button
        type="button"
        className="watchlist__remove"
        aria-label={t('watchlist.removeAria', { symbol })}
        onClick={(e) => {
          e.stopPropagation();
          removeFromWatchlist(watchKey);
        }}
        data-testid={`watchlist-remove-${watchKey}`}
      >
        ×
      </button>
    </li>
  );
}

/** The corporate-jet marker for a symbol whose hub is a tracked M&A hub. */
function WatchlistJetChip({ watchKey }: { watchKey: string }) {
  const t = useT();
  const jetTitle = t('watchlist.jetTitle');
  return (
    <span
      className="watchlist__chip watchlist__jet"
      title={jetTitle}
      aria-label={jetTitle}
      role="img"
      data-testid={`watchlist-jet-${watchKey}`}
    >
      ✈️
    </span>
  );
}
