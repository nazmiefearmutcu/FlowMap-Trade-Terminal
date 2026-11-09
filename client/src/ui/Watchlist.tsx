/**
 * Watchlist panel — the right rail's favorites surface.
 *
 * Rows come from the module-scoped `watchlist/store` (persisted favorites,
 * `flowmap.watchlist.v1`); their live prices come from the shared
 * `state/quoteFeed` poll loop — this panel never talks to the
 * network itself, so N watched symbols share ONE poller and one TTL server-side.
 *
 * Honesty rules:
 *   - a quote that never arrived renders em-dashes, never a made-up price;
 *   - `reachable === false` renders em-dashes + a `no data` chip;
 *   - `stale === true` mutes the row's text to the secondary ink and shows a `stale`
 *     chip while keeping the LAST KNOWN price visible (stale data is labelled, not hidden);
 *   - the sparkline is an inline SVG path (`ui/spark.ts`) — no canvas element,
 *     so the global `canvas { position: absolute }` rule is a non-issue.
 *
 * The panel is self-contained: it imports its own CSS and takes only
 * `{ activeKey, onSelect }`. The app mounts it above the DOM ladder. The pure
 * quote helpers live in WatchlistQuotes.ts, the data hooks in WatchlistHooks.ts,
 * and one row in WatchlistRow.tsx.
 */

import { useCallback, useMemo } from 'react';

import { formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import { bookSessionKey } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import {
  WATCHLIST_CAP,
  addToWatchlist,
  isValidWatchKey,
  isWatchlisted,
  useWatchlist,
} from '../watchlist/store';
import { loadRecents, type RecentPick } from './recents';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { safeLocalStorage } from '../state/safeStorage';
import { useLiveActiveQuote, useWatchQuotes } from './WatchlistHooks';
import { WatchlistRow } from './WatchlistRow';
import { symbolOf } from './WatchlistQuotes';
import '../watchlist/watchlist.css';
import './TradingPanels.css';

export {
  LIVE_QUOTE_STALE_MS,
  activeWatchQuote,
  quoteChangeText,
  quoteDirection,
  quotePriceText,
  symbolOf,
  type WatchQuote,
} from './WatchlistQuotes';

export interface WatchlistProps {
  /** The chart's active `market:symbol` key (the one the add button adds). */
  activeKey: string;
  /** Switch the chart to `key` — the panel never switches symbols itself. */
  onSelect: (key: string) => void;
}

export function Watchlist({ activeKey, onSelect }: WatchlistProps): JSX.Element {
  const t = useT();
  const watchKeys = useWatchlist();
  const subscription = useFlowMapStore((s) => s.subscription);
  const sessionKey = useFlowMapStore(bookSessionKey);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const liveEligible = activeKey === `${subscription?.market}:${subscription?.symbol}`
    && subscription?.market !== 'sim' && subscription?.mode === 'live'
    && status === 'live' && feedState !== 'closed' && watchKeys.includes(activeKey);
  const activeQuote = useLiveActiveQuote(liveEligible, sessionKey);
  const quotes = useWatchQuotes(watchKeys);
  const liveQuote = liveEligible && activeQuote?.sessionKey === sessionKey ? activeQuote : null;

  const empty = watchKeys.length === 0;
  const full = watchKeys.length >= WATCHLIST_CAP;
  const activeValid = isValidWatchKey(activeKey);
  const activePresent = activeValid && isWatchlisted(activeKey);

  // Empty state suggestions: recents are a shortcut, NOT auto-favorites.
  const recents = useMemo(() => (empty ? loadRecents(safeLocalStorage()) : []), [empty]);

  const talentMap = useIntelligenceStore((s) => s.talent);
  const corporateJets = useIntelligenceStore((s) => s.corporateJets);

  const addActive = useCallback(() => {
    addToWatchlist(activeKey);
  }, [activeKey]);

  return (
    <section className="panel watchlist" data-testid="watchlist" aria-label={t('watchlist.title')}>
      <header className="panel__header watchlist__header">
        <h2 className="panel__heading"><span className="panel__title">{t('watchlist.title')}</span></h2>
        <span className="panel__badge watchlist__count" data-testid="watchlist-count">
          {formatNumber(watchKeys.length)}
        </span>
        <button
          type="button"
          className="watchlist__add"
          onClick={addActive}
          disabled={activePresent || full || !activeValid}
          title={
            full
              ? t('watchlist.full', { cap: WATCHLIST_CAP })
              : !activeValid
                ? t('watchlist.noActive')
                : activePresent
                  ? t('watchlist.alreadyOn', { symbol: symbolOf(activeKey) })
                  : t('watchlist.addSymbol', { symbol: symbolOf(activeKey) })
          }
          data-testid="watchlist-add"
        >
          {t('watchlist.addCurrent')}
        </button>
      </header>

      {empty ? (
        <WatchlistEmpty recents={recents} onSelect={onSelect} />
      ) : (
        <ul className="watchlist__body">
          {watchKeys.map((key) => (
            <WatchlistRow
              key={key}
              watchKey={key}
              activeKey={activeKey}
              liveQuote={liveQuote}
              network={quotes[key]}
              talentMap={talentMap}
              corporateJets={corporateJets}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The empty list: the copy, and the recent picks as one-click suggestions. */
function WatchlistEmpty({
  recents,
  onSelect,
}: {
  recents: readonly RecentPick[];
  onSelect: (key: string) => void;
}) {
  const t = useT();
  return (
    <div className="watchlist__empty" data-testid="watchlist-empty">
      <p className="watchlist__empty-copy">
        {t('watchlist.emptyCopy')}
      </p>
      {recents.length > 0 && (
        <>
          <span className="watchlist__empty-label">{t('watchlist.recent')}</span>
          <div className="watchlist__suggestions">
            {recents.map((r) => {
              const key = `${r.market}:${r.symbol}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="watchlist__suggestion"
                  onClick={() => onSelect(key)}
                  data-testid={`watchlist-recent-${key}`}
                >
                  {r.symbol}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default Watchlist;
