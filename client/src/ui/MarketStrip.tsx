import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Renderer } from '../gl/renderer';
import { useT } from '../i18n/useT';
import { formatFixed, formatPrice } from '../i18n/format';
import { getSnapshot, subscribe } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { bookTopOfBook, priceDecimals, fmtSz } from './DomLadder';
import './MarketStrip.css';

/** `label` identifies the button (test ids and the selected state); the window's caption is translated at render. */
const WINDOWS = [
  { label: '15s', ms: 15_000 }, { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 }, { label: '30m', ms: 1_800_000 }, { label: 'All', ms: null },
] as const;

/** Unit suffixes for {@link quoteAgeText}; English by default, the strip passes the UI's own. */
export interface QuoteAgeUnits {
  ms: string;
  s: string;
}

/** Minimum gap between two book-driven repaints of the strip (about 10 Hz). */
const SNAPSHOT_INTERVAL_MS = 100;

/** Feed-health token → label key. Raw transport tokens never reach the screen. */
export const FEED_KEY: Record<string, string> = {
  connecting: 'marketStrip.feed.connecting',
  reconnecting: 'marketStrip.feed.reconnecting',
  idle: 'marketStrip.feed.idle',
  closed: 'marketStrip.feed.closed',
  degraded: 'marketStrip.feed.degraded',
};

const EN_QUOTE_AGE_UNITS: QuoteAgeUnits = { ms: 'ms', s: 's' };

export function quoteAgeText(
  receivedAt: number | undefined,
  now: number,
  units: QuoteAgeUnits = EN_QUOTE_AGE_UNITS,
): string {
  if (receivedAt === undefined) return '—';
  const age = Math.max(0, now - receivedAt);
  return age < 1000 ? `${Math.round(age)} ${units.ms}` : `${formatFixed(age / 1000, 1)} ${units.s}`;
}

/** Active instrument facts use the raw quote/tape, independent of depth grouping. */
export function MarketStrip({ rendererRef }: { rendererRef: RefObject<Renderer | null> }): JSX.Element {
  const t = useT();
  const [snap, setSnap] = useState(getSnapshot);
  const [now, setNow] = useState(() => performance.now());
  const [selected, setSelected] = useState<string | null>(null);
  const selectedWindow = useRef<number | null | undefined>(undefined);
  const epochs = useFlowMapStore(s => s.epochs);
  const gridEpoch = useFlowMapStore(s => s.gridEpoch);
  const sub = useFlowMapStore(s => s.subscription);
  const status = useFlowMapStore(s => s.status);
  const feedState = useFlowMapStore(s => s.feedState);
  // Book notifications arrive up to 60 Hz; the strip repaints at most every
  // SNAPSHOT_INTERVAL_MS (about 10 Hz, like the watchlist). A change after a quiet
  // spell publishes at once; changes inside the window coalesce into one trailing
  // repaint that reads the newest snapshot when the window closes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPublish = Number.NEGATIVE_INFINITY;
    const publish = (): void => {
      timer = null;
      lastPublish = performance.now();
      setSnap(getSnapshot());
    };
    const unsubscribe = subscribe(() => {
      if (timer !== null) return;
      const wait = SNAPSHOT_INTERVAL_MS - (performance.now() - lastPublish);
      if (wait <= 0) publish();
      else timer = setTimeout(publish, wait);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(performance.now());
      if (selectedWindow.current !== undefined && rendererRef.current?.timeWindowMs !== selectedWindow.current) {
        selectedWindow.current = undefined;
        setSelected(null);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [rendererRef]);
  useEffect(() => { selectedWindow.current = undefined; setSelected(null); }, [sub?.market, sub?.symbol]);
  const params = epochs.get(snap.book?.epoch ?? gridEpoch ?? -1);
  const decimals = params ? priceDecimals(params.tick) : 2;
  // One price format for every surface: venue-tick decimals, no grouping.
  const fmt = (n: number | undefined): string => formatPrice(n ?? Number.NaN, decimals);
  const quoteAgeUnits: QuoteAgeUnits = { ms: t('unit.ms'), s: t('unit.s') };
  const quote = snap.bbo;
  const last = snap.trades[0];
  const age = quote?.receivedAtMs === undefined ? null : Math.max(0, performance.now() - quote.receivedAtMs);
  // No BBO frame yet: show the depth book's best rungs, the same ones the DOM
  // highlights, and label the source so it is never mistaken for a quote.
  const fromBook = quote ? null : bookTopOfBook(snap, params);
  const bidPx = quote ? quote.bidPx : fromBook?.bidPx;
  const askPx = quote ? quote.askPx : fromBook?.askPx;
  const bidSz = quote ? quote.bidSz : (fromBook?.bidSz ?? 0);
  const askSz = quote ? quote.askSz : (fromBook?.askSz ?? 0);
  const spreadPx = bidPx !== undefined && askPx !== undefined ? askPx - bidPx : undefined;
  let stateText: string;
  if (status !== 'live') stateText = t(FEED_KEY[status] ?? 'marketStrip.feed.other');
  else if (feedState && feedState !== 'live') stateText = t(FEED_KEY[feedState] ?? 'marketStrip.feed.other');
  else if (sub?.market === 'sim') stateText = t('marketStrip.demo');
  else if (sub?.mode === 'replay') stateText = t('marketStrip.replay');
  else if (!quote) stateText = t('marketStrip.awaiting');
  else if (age !== null && age > 45000) stateText = t('marketStrip.stale');
  else if (age !== null && age > 3000) stateText = t('marketStrip.quiet');
  else stateText = t('marketStrip.live');
  const windowClick = (label: string, ms: number | null): void => {
    if (rendererRef.current?.setTimeWindowMs(ms)) {
      selectedWindow.current = ms;
      setSelected(label);
    }
  };
  return (
    <div className="market-strip" data-testid="market-strip">
      <dl className="market-strip__quotes">
        <div className="market-strip__last"><dt>{t('marketStrip.lastTrade')}</dt><dd data-testid="market-last">{fmt(last?.price)}</dd></div>
        <div className="market-strip__bid"><dt>{t('marketStrip.bid')} <span>{fmtSz(bidSz)}</span></dt><dd data-testid="market-bid">{fmt(bidPx)}</dd></div>
        <div className="market-strip__ask"><dt>{t('marketStrip.ask')} <span>{fmtSz(askSz)}</span></dt><dd data-testid="market-ask">{fmt(askPx)}</dd></div>
        <div><dt>{t('marketStrip.spread')}</dt><dd data-testid="market-spread">{fmt(spreadPx)}</dd></div>
      </dl>
      <div className="market-strip__feed" data-quiet={age !== null && age > 3000} data-pending={status !== 'live'}
        title={t('marketStrip.feedTitle')}>
        <span>{stateText}</span><span data-testid="market-quote-age">{t('marketStrip.quoteAge', { age: quoteAgeText(quote?.receivedAtMs, Math.max(now, quote?.receivedAtMs ?? now), quoteAgeUnits) })}</span>
        {fromBook && <span data-testid="market-book-src">{t('marketStrip.fromBook')}</span>}
      </div>
      <div className="market-strip__windows" role="group" aria-label={t('marketStrip.windowGroup')}>
        {WINDOWS.map(w => <button key={w.label} type="button" aria-pressed={selected === w.label}
          onClick={() => windowClick(w.label, w.ms)}
          title={w.ms === null ? t('marketStrip.windowFit') : t('marketStrip.windowShow', { label: w.label })}
          data-testid={`time-window-${w.label}`}>{w.ms === null ? t('marketStrip.windowAll') : w.label}</button>)}
      </div>
    </div>
  );
}
