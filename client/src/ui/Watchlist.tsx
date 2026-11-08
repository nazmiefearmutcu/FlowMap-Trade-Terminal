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
 *   - `stale === true` dims the row and shows a `stale` chip while keeping the
 *     LAST KNOWN price visible (dimmed data is labelled, not hidden);
 *   - the sparkline is an inline SVG path (`ui/spark.ts`) — no canvas element,
 *     so the global `canvas { position: absolute }` rule is a non-issue.
 *
 * The panel is self-contained: it imports its own CSS and takes only
 * `{ activeKey, onSelect }`. The app mounts it above the DOM ladder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatFixed } from '../i18n/format';
import { useT } from '../i18n/useT';
import { subscribeQuotes } from '../state/quoteFeed';
import { bookSessionKey, getSnapshot, subscribe, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import {
  WATCHLIST_CAP,
  addToWatchlist,
  isValidWatchKey,
  isWatchlisted,
  removeFromWatchlist,
  toggleWatchlist,
  useWatchlist,
} from '../watchlist/store';
import { loadRecents } from './recents';
import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { safeLocalStorage } from '../state/safeStorage';
import '../watchlist/watchlist.css';
import './TradingPanels.css';

/**
 * Structural view of the quote payload from the shared quote feed. Kept locally
 * so this file compiles independently of the quoteFeed module's own type
 * exports; every field is widened so the feed's exact nullability stays
 * assignable.
 */
export interface WatchQuote {
  price?: number | null;
  changePct?: number | null;
  spark?: readonly number[] | null;
  stale?: boolean;
  reachable?: boolean;
}

export interface WatchlistProps {
  /** Subscription key (`market:symbol`) of the symbol on screen. */
  activeKey: string;
  /** Switch the chart to `key` — the panel never switches symbols itself. */
  onSelect: (key: string) => void;
}

const SPARK_W = 64;
const SPARK_H = 16;
const LIVE_QUOTE_INTERVAL_MS = 100;
export const LIVE_QUOTE_STALE_MS = 5_000;

interface ActiveWatchQuote {
  sessionKey: string;
  price: number;
  source: 'live-mid' | 'live-last';
  receivedAtMs: number;
  stale: boolean;
}

/** Raw BBO midpoint; grouped book rungs are deliberately never a quote source. */
export function activeWatchQuote(snap: BookSnapshot, sessionKey: string): ActiveWatchQuote | null {
  if (snap.sessionKey !== sessionKey) return null;
  const bbo = snap.bbo;
  if (bbo && bbo.bidPx > 0 && bbo.askPx >= bbo.bidPx
    && Number.isFinite(bbo.askPx) && typeof bbo.receivedAtMs === 'number') {
    return { sessionKey, price: bbo.bidPx + (bbo.askPx - bbo.bidPx) / 2,
      source: 'live-mid', receivedAtMs: bbo.receivedAtMs, stale: false };
  }
  const last = snap.trades[0];
  if (!last || last.venue === 'sim' || !(last.price > 0) || !Number.isFinite(last.price)
    || typeof last.receivedAtMs !== 'number') return null;
  return { sessionKey, price: last.price, source: 'live-last', receivedAtMs: last.receivedAtMs, stale: false };
}

/** `crypto:BTCUSDT` → `BTCUSDT` (labels are the symbol half). */
export function symbolOf(key: string): string {
  const i = key.indexOf(':');
  return i >= 0 && i < key.length - 1 ? key.slice(i + 1) : key;
}

/**
 * Row direction for colour: the spark's net direction decides first (spec),
 * then the signed `changePct` when the spark is flat/missing — the colour then
 * still agrees with the number printed next to it.
 */
export function quoteDirection(q: WatchQuote | undefined): 'up' | 'down' | 'flat' {
  if (!q) return 'flat';
  const dir = sparkDirection(q.spark ?? []);
  if (dir > 0) return 'up';
  if (dir < 0) return 'down';
  const chg = q.changePct;
  if (typeof chg === 'number' && Number.isFinite(chg) && chg !== 0) {
    return chg > 0 ? 'up' : 'down';
  }
  return 'flat';
}

/** Price text: em-dash when absent OR unreachable — never a fabricated number. */
export function quotePriceText(q: WatchQuote | undefined): string {
  if (!q || q.reachable === false || typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0) return '—';
  return fmtPrice(q.price);
}

/** Change text, same honesty rule as {@link quotePriceText}. */
export function quoteChangeText(q: WatchQuote | undefined): string {
  if (quotePriceText(q) === '—') return '—';
  if (!q) return '—';
  return fmtPct(q.changePct);
}

export function Watchlist({ activeKey, onSelect }: WatchlistProps): JSX.Element {
  const t = useT();
  // Resolved once per render, so the per-row markup below reuses it.
  const jetTitle = t('watchlist.jetTitle');
  const watchKeys = useWatchlist();
  const [quotes, setQuotes] = useState<Record<string, WatchQuote>>({});
  const [activeQuote, setActiveQuote] = useState<ActiveWatchQuote | null>(null);
  const subscription = useFlowMapStore((s) => s.subscription);
  const sessionKey = useFlowMapStore(bookSessionKey);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const liveEligible = activeKey === `${subscription?.market}:${subscription?.symbol}`
    && subscription?.market !== 'sim' && subscription?.mode === 'live'
    && status === 'live' && feedState !== 'closed' && watchKeys.includes(activeKey);

  // Local display bridge only. The shared HTTP cache/alert monitor never sees it.
  // Coalesce the <=60Hz book notifications into at most ten price updates/sec.
  useEffect(() => {
    setActiveQuote(null);
    if (!liveEligible) return undefined;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPublished = -Infinity;
    let sessionVersion = getSnapshot().sessionVersion;
    const publish = (): void => {
      updateTimer = null;
      lastPublished = performance.now();
      const quote = activeWatchQuote(getSnapshot(), sessionKey);
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null;
      if (quote) {
        quote.stale = performance.now() - quote.receivedAtMs >= LIVE_QUOTE_STALE_MS;
        if (!quote.stale) {
          staleTimer = setTimeout(() => {
            setActiveQuote((prev) => prev ? { ...prev, stale: true } : null);
          }, Math.max(0, LIVE_QUOTE_STALE_MS - (performance.now() - quote.receivedAtMs)));
        }
      }
      setActiveQuote((prev) => prev?.price === quote?.price && prev?.source === quote?.source
        && prev?.receivedAtMs === quote?.receivedAtMs && prev?.stale === quote?.stale ? prev : quote);
    };
    const off = subscribe((snap) => {
      if (snap.sessionVersion !== sessionVersion) {
        sessionVersion = snap.sessionVersion;
        // A reset is safety metadata, not a price update; clear immediately.
        setActiveQuote(null);
      }
      if (updateTimer !== null) return;
      const wait = LIVE_QUOTE_INTERVAL_MS - (performance.now() - lastPublished);
      if (wait <= 0) publish();
      else updateTimer = setTimeout(publish, wait);
    });
    publish();
    return () => {
      off();
      if (updateTimer !== null) clearTimeout(updateTimer);
      if (staleTimer !== null) clearTimeout(staleTimer);
    };
  }, [liveEligible, sessionKey]);

  const empty = watchKeys.length === 0;
  const full = watchKeys.length >= WATCHLIST_CAP;
  const activeValid = isValidWatchKey(activeKey);
  const activePresent = activeValid && isWatchlisted(activeKey);

  // Quote wiring: one subscription for the whole list; empty list → no
  // subscription at all. `watchKeys` identity is stable between mutations, so
  // this effect re-runs exactly on add/remove and cleans up on unmount.
  useEffect(() => {
    setQuotes((prev) => {
      // Drop quotes for removed symbols: a re-add must not flash the old price.
      const next: Record<string, WatchQuote> = {};
      for (const k of watchKeys) {
        const q = prev[k];
        if (q !== undefined) next[k] = q;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    if (watchKeys.length === 0) return undefined;
    return subscribeQuotes([...watchKeys], (key: string, quote: WatchQuote) => {
      setQuotes((prev) => ({ ...prev, [key]: quote }));
    });
  }, [watchKeys]);

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
        <span className="panel__title">{t('watchlist.title')}</span>
        <span className="panel__badge watchlist__count" data-testid="watchlist-count">
          {watchKeys.length}
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
      ) : (
        <ul className="watchlist__body">
          {watchKeys.map((key) => {
            const live = key === activeKey && liveEligible && activeQuote?.sessionKey === sessionKey ? activeQuote : null;
            const network = quotes[key];
            const q = live ? { ...network, price: live.price, stale: live.stale, reachable: true,
              changePct: network?.reachable === false ? null : network?.changePct } : network;
            const source = live?.source ?? (q ? 'snapshot' : 'none');
            const dir = quoteDirection(q);
            const stale = q?.stale === true;
            const unreachable = q?.reachable === false;
            const available = quotePriceText(q) !== '—';
            const d =
              q && available && q.spark && q.spark.length > 1
                ? sparkPath(q.spark, SPARK_W, SPARK_H)
                : '';
            return (
              // A list item, not a button: the symbol is the keyboard and
              // assistive-technology control, and the star and remove buttons
              // are siblings of it. The row click is a pointer convenience.
              <li
                key={key}
                className={`watchlist__row${key === activeKey ? ' is-active' : ''}${
                  stale ? ' is-stale' : ''
                }${unreachable ? ' is-unreachable' : ''}`}
                onClick={() => onSelect(key)}
                title={key}
                data-testid={`watchlist-row-${key}`}
                data-key={key}
                data-source={source}
              >
                <button
                  type="button"
                  className="watchlist__star"
                  aria-pressed="true"
                  aria-label={t('watchlist.starAria', { symbol: symbolOf(key) })}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleWatchlist(key);
                  }}
                  data-testid={`watchlist-star-${key}`}
                >
                  ★
                </button>
                <span className="watchlist__identity">
                  <button
                    type="button"
                    className="watchlist__sym"
                    data-testid={`watchlist-select-${key}`}
                    aria-current={key === activeKey ? 'true' : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(key);
                    }}
                  >
                    {symbolOf(key)}
                  </button>
                  <span className="watchlist__source" data-testid={`watchlist-source-${key}`}
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
                  data-testid={`watchlist-price-${key}`}
                  data-raw-price={quotePriceText(q) === '—' ? undefined : q?.price ?? undefined}
                >
                  {quotePriceText(q)}
                </span>
                <span
                  className={`watchlist__chg is-${dir}`}
                  data-testid={`watchlist-change-${key}`}
                  title={t('watchlist.changeTitle')}
                >
                  {quoteChangeText(q)}
                </span>
                {(() => {
                  const s = symbolOf(key).toUpperCase();
                  const talent = talentMap[s];
                  const jet = corporateJets.some((j) => j.symbol === s && j.isMaHub);
                  return (
                    <>
                      {talent && Number.isFinite(talent.talentDeltaPct) && Number.isFinite(talent.rdOpenings) && (
                        <span
                          className={`watchlist__chip watchlist__talent is-${talent.talentDeltaPct >= 0 ? 'pos' : 'neg'}`}
                          title={t('watchlist.talentTitle', {
                            delta: `${talent.talentDeltaPct >= 0 ? '+' : ''}${formatFixed(talent.talentDeltaPct, 1)}`,
                            count: talent.rdOpenings,
                          })}
                          data-testid={`watchlist-talent-${key}`}
                        >
                          {talent.talentDeltaPct >= 0 ? '+' : ''}{formatFixed(talent.talentDeltaPct, 0)}%
                        </span>
                      )}
                      {jet && (
                        <span
                          className="watchlist__chip watchlist__jet"
                          title={jetTitle}
                          aria-label={jetTitle}
                          role="img"
                          data-testid={`watchlist-jet-${key}`}
                        >
                          ✈️
                        </span>
                      )}
                    </>
                  );
                })()}
                {unreachable ? (
                  <span
                    className="watchlist__chip watchlist__chip--na"
                    data-testid={`watchlist-nodata-${key}`}
                  >
                    {t('watchlist.noData')}
                  </span>
                ) : stale ? (
                  <span
                    className="watchlist__chip watchlist__chip--stale"
                    data-testid={`watchlist-stale-${key}`}
                  >
                    {t('watchlist.stale')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="watchlist__remove"
                  aria-label={t('watchlist.removeAria', { symbol: symbolOf(key) })}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromWatchlist(key);
                  }}
                  data-testid={`watchlist-remove-${key}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default Watchlist;
