/**
 * Option chain dialog: the calls and puts of one series of the instrument on the chart,
 * one row per strike, with the series picker above it.
 *
 * It reads `/api/options` when it opens, when a series is picked and every
 * {@link REFRESH_MS} while it is open and the window is visible. The chart price is read
 * every {@link SPOT_MS}, so the mark follows the chart between two readings of the chain. The figures are the
 * source's row for each contract; a field the row does not state is a dash, and a strike
 * that lists one side only leaves the other side empty. The row nearest to the chart price
 * is marked, and in-the-money cells are tinted, only when the chart has a price.
 *
 * Modal contract matches the replay picker: a portal, role=dialog + aria-modal, focus moves
 * in on open and returns to the opener on close, Tab is trapped, and Escape closes only
 * while this dialog is the topmost overlay.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { exchangeZoneFor, formatClock, formatDateTime, formatFixed, formatNumber, formatPrice, useTimeZone } from '../i18n/format';
import { useT } from '../i18n/useT';
import { getSnapshot } from '../state/bookStore';
import {
  atmStrike,
  chartPrice,
  daysToExpiry,
  expiryMs,
  fetchOptionChain,
  hasActivity,
  midDeltaStrike,
  moneyBand,
  optionChainErrorKey,
  premiumDecimals,
  referencePrice,
  seriesKey,
  spotDecimals,
  strikeDecimals,
  visibleDecimals,
  type OptionChainView,
  type OptionSeriesInfo,
  type OptionSeriesRef,
  type OptionSide,
  type OptionStrike,
} from './optionChainModel';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { marketGroup } from './symbols';
import './OptionChain.css';

/** How often an open dialog reads the chain again. The server keeps a reading this long. */
export const REFRESH_MS = 20_000;

/** How often the chart price is read for the mark and the readout. */
export const SPOT_MS = 1_000;

const OVERLAY_ID = 'option-chain';
const NO_STRIKES: readonly OptionStrike[] = [];

type Column =
  | 'bid' | 'ask' | 'theo' | 'iv' | 'delta' | 'gamma' | 'theta' | 'vega' | 'rho'
  | 'bidSize' | 'askSize' | 'last' | 'volume' | 'openInterest';
type ViewMode = 'prices' | 'activity' | 'greeks';

/** Call-side column order per view; the put side mirrors it around the strike. */
const COLUMNS: Readonly<Record<ViewMode, readonly Column[]>> = {
  prices: ['bid', 'ask', 'theo', 'iv', 'delta'],
  activity: ['bidSize', 'askSize', 'last', 'volume', 'openInterest'],
  greeks: ['delta', 'gamma', 'theta', 'vega', 'rho'],
};

const MODE_LABEL: Readonly<Record<ViewMode, string>> = {
  prices: 'optionChain.viewPrices',
  activity: 'optionChain.viewActivity',
  greeks: 'optionChain.viewGreeks',
};

/** Columns whose header carries a longer explanation as its title. */
const COLUMN_TITLE: Partial<Record<Column, string>> = {
  theo: 'optionChain.col.theoTitle',
  iv: 'optionChain.col.ivTitle',
  openInterest: 'optionChain.col.openInterestTitle',
};

/** The sources this build has its own note for; any other gets the general one. */
const SOURCE_NOTE: Readonly<Record<string, string>> = {
  tradingview: 'optionChain.note.tradingview',
  cboe: 'optionChain.note.cboe',
  bybit: 'optionChain.note.bybit',
  deribit: 'optionChain.note.deribit',
};

const COLUMN_LABEL: Readonly<Record<Column, string>> = {
  bid: 'optionChain.col.bid',
  ask: 'optionChain.col.ask',
  theo: 'optionChain.col.theo',
  iv: 'optionChain.col.iv',
  delta: 'optionChain.col.delta',
  gamma: 'optionChain.col.gamma',
  theta: 'optionChain.col.theta',
  vega: 'optionChain.col.vega',
  rho: 'optionChain.col.rho',
  bidSize: 'optionChain.col.bidSize',
  askSize: 'optionChain.col.askSize',
  last: 'optionChain.col.last',
  volume: 'optionChain.col.volume',
  openInterest: 'optionChain.col.openInterest',
};

/** Every key the dialog builds at run time (the i18n coverage test reads this). */
export const OPTION_CHAIN_COLUMN_KEYS: readonly string[] = [
  ...Object.values(COLUMN_LABEL),
  ...Object.values(COLUMN_TITLE),
  ...Object.values(MODE_LABEL),
  ...Object.values(SOURCE_NOTE),
];

/** One cell's text. A value the source did not state is a dash. */
export function optionCellText(side: OptionSide, column: Column, decimals: number): string {
  const value = side[column];
  if (value === null) return '—';
  if (column === 'bid' || column === 'ask' || column === 'theo' || column === 'last') {
    return formatPrice(value, visibleDecimals(value, decimals));
  }
  if (column === 'bidSize' || column === 'askSize' || column === 'volume' || column === 'openInterest') {
    // A coin venue states sizes in fractions of a coin: a small one is not written as zero.
    return formatNumber(value, { maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2 });
  }
  if (column === 'iv') return `${formatFixed(value * 100, 1)}%`;
  // A delta that rounds to zero is written as zero, never as "-0.000".
  if (column === 'delta') return formatFixed(Math.round(value * 1000) === 0 ? 0 : value, 3);
  return formatNumber(value, { maximumSignificantDigits: 3, useGrouping: false });
}

/** The price the table is marked with, beside the strike count: the chart's, or the source's
 * own when the chart has none. It reads the chart itself, so a tick redraws this line and not
 * the table. */
function ChartPrice({ spotFn, sourcePrice }: { spotFn: () => number | null; sourcePrice: number | null }): JSX.Element | null {
  const t = useT();
  const [spot, setSpot] = useState<number | null>(() => spotFn());
  useEffect(() => {
    const timer = window.setInterval(() => setSpot(spotFn()), SPOT_MS);
    return () => window.clearInterval(timer);
    // spotFn is read on each tick; a new function identity must not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reference = referencePrice(spot, sourcePrice);
  if (reference === null) return null;
  const price = formatPrice(reference.price, spotDecimals(reference.price));
  return <> · {t(reference.from === 'chart' ? 'optionChain.spot' : 'optionChain.sourcePrice', { price })}</>;
}

interface OptionChainDialogProps {
  market: string;
  symbol: string;
  onClose: () => void;
  /** The chart's current price; a test seam. Defaults to the live book buffer. */
  spotFn?: () => number | null;
  /** Wall clock for the days-to-expiry labels; a test seam. */
  nowMs?: () => number;
}

export function OptionChainDialog({
  market,
  symbol,
  onClose,
  spotFn = () => chartPrice(getSnapshot()),
  nowMs = Date.now,
}: OptionChainDialogProps): JSX.Element {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const focusRow = useRef<HTMLTableRowElement>(null);
  // The series the next request names. Null asks the server for the nearest expiry.
  const asked = useRef<OptionSeriesRef | null>(null);
  // The series whose strikes are on screen: what a failed pick falls back to.
  const shown = useRef<OptionSeriesRef | null>(null);
  // True while a request is out, so the timer never cuts a slow answer short.
  const inFlight = useRef(false);
  const [view, setView] = useState<OptionChainView | null>(null);
  // The picker's choice while its strikes are still loading: the table waits for it.
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<{ key: string; status?: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<ViewMode>('prices');
  // The chart price the table is marked with. It changes only when the price moves to
  // another band of strikes (see moneyBand), so a tick does not redraw the table.
  const [spot, setSpot] = useState<number | null>(null);
  const strikesRef = useRef<readonly OptionStrike[]>(NO_STRIKES);
  // The underlying's price as the source states it: what the table is marked with when the
  // chart has no price of its own.
  const sourcePriceRef = useRef<number | null>(null);
  const pref = useTimeZone();
  const exchange = exchangeZoneFor(marketGroup(market), market);

  useEffect(() => pushOverlay(OVERLAY_ID), []);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && isTopOverlay(OVERLAY_ID)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setBusy(true);
    inFlight.current = true;
    fetchOptionChain(market, symbol, asked.current, ctrl.signal)
      .then((next) => {
        if (ctrl.signal.aborted) return;
        // From here every refresh names the series on screen, also when the server chose it.
        // An answer without a series (no options, unreachable) leaves the request as it was.
        if (next.selected !== null) {
          asked.current = next.selected;
          shown.current = next.selected;
        }
        strikesRef.current = next.strikes;
        sourcePriceRef.current = next.underlyingPrice;
        setView(next);
        setSpot(referencePrice(spotFn(), next.underlyingPrice)?.price ?? null);
        setError(null);
        setPending(null);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        // A pick that failed is dropped: the next refresh asks for the series on screen
        // again, not for the one the user never got to see.
        asked.current = shown.current;
        setError(optionChainErrorKey(e));
        setPending(null);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        inFlight.current = false;
        setBusy(false);
      });
    return () => ctrl.abort();
    // spotFn is read at answer time only; a new function identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // A tick while an answer is still on its way is skipped: starting a new request
      // would abort the one that is about to land.
      if (document.visibilityState !== 'hidden' && !inFlight.current) setRefresh((n) => n + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = referencePrice(spotFn(), sourcePriceRef.current)?.price ?? null;
      setSpot((prev) => (moneyBand(strikesRef.current, prev) === moneyBand(strikesRef.current, next) ? prev : next));
    }, SPOT_MS);
    return () => window.clearInterval(timer);
    // spotFn is read on each tick; a new function identity must not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedKey = view?.selected ? seriesKey(view.selected) : null;
  // Bring the money into view once per series, not on every refresh: the row nearest to the
  // chart price, or the half-delta row when the chart has no price.
  useLayoutEffect(() => {
    if (selectedKey !== null && pending === null) focusRow.current?.scrollIntoView?.({ block: 'center' });
  }, [selectedKey, pending]);

  const pick = (key: string): void => {
    const chosen = view?.series.find((series) => seriesKey(series) === key);
    if (!chosen || key === selectedKey) return;
    asked.current = { root: chosen.root, expiry: chosen.expiry };
    setPending(key);
    setRefresh((n) => n + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!isTopOverlay(OVERLAY_ID)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    if (e.key !== 'Tab') return;
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    const inside = panel.current?.contains(active) ?? false;
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  const seriesLabel = (series: OptionSeriesInfo): string => {
    const ms = expiryMs(series.expiry);
    const date = ms === null ? series.expiry : formatDateTime(ms, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const days = daysToExpiry(series.expiry, nowMs());
    const when = days === null ? series.expiry
      : days < 0 ? t('optionChain.expired')
      : days === 0 ? t('optionChain.today')
      : t('optionChain.days', { count: formatNumber(days) });
    return t('optionChain.seriesOption', { date, when, root: series.root, count: formatNumber(series.contracts) });
  };

  const showTable = view !== null && view.status === 'ok' && pending === null;
  const strikes = showTable ? view.strikes : [];
  const strikeDp = strikeDecimals(strikes);
  const premiumDp = premiumDecimals(strikes);
  const atm = atmStrike(strikes, spot);
  const centre = atm ?? midDeltaStrike(strikes);
  const loading = pending !== null || (view === null && busy);
  // The activity view exists only for a chain that states sizes, trades or open interest.
  // It is read off the chain last loaded, so the button does not blink away while another
  // expiry is on its way.
  const modes: readonly ViewMode[] = hasActivity(view?.strikes ?? []) ? ['prices', 'activity', 'greeks'] : ['prices', 'greeks'];
  const shownMode: ViewMode = modes.includes(mode) ? mode : 'prices';
  const callColumns = COLUMNS[shownMode];
  const putColumns = [...callColumns].reverse();
  const readAt = view?.capturedMs == null ? null : formatClock(view.capturedMs, pref, exchange);
  const message = view === null || pending !== null ? null
    : view.status === 'none' ? t('optionChain.none', { symbol })
    : view.status === 'unsupported' ? t('optionChain.unsupported')
    : view.status === 'unreachable' ? t('optionChain.unreachable')
    : null;

  const sideCells = (side: OptionSide | null, columns: readonly Column[], kind: 'call' | 'put', itm: boolean): JSX.Element[] =>
    columns.map((column) => (
      <td
        key={`${kind}-${column}`}
        className={`option-chain__cell is-${kind}${itm ? ' is-itm' : ''}${side === null ? ' is-absent' : ''}`}
        title={side?.symbol}
      >
        {side === null ? '' : optionCellText(side, column, premiumDp)}
      </td>
    ));

  return createPortal(
    <div className="option-chain__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className="option-chain" role="dialog" aria-modal="true" aria-labelledby="option-chain-title" data-testid="option-chain" onKeyDown={onKeyDown}>
        <header className="option-chain__head">
          <h2 id="option-chain-title" className="option-chain__title">
            {t('optionChain.title')} · {market} / {symbol}
          </h2>
          {view?.underlying && (
            <span className="option-chain__underlying" data-testid="option-chain-underlying">
              {t('optionChain.underlying')} <strong>{view.underlying}</strong>
            </span>
          )}
          <button ref={close} type="button" className="option-chain__close" onClick={onClose} aria-label={t('optionChain.close')} data-testid="option-chain-close">
            ×
          </button>
        </header>

        <div className="option-chain__controls">
          {view !== null && view.series.length > 0 && (
            <label className="option-chain__series">
              {t('optionChain.series')}
              <select
                value={pending ?? selectedKey ?? ''}
                onChange={(e) => pick(e.target.value)}
                data-testid="option-chain-series"
              >
                {view.series.map((series) => (
                  <option key={seriesKey(series)} value={seriesKey(series)}>{seriesLabel(series)}</option>
                ))}
              </select>
            </label>
          )}
          <div className="option-chain__modes" role="group" aria-label={t('optionChain.view')}>
            {modes.map((item) => (
              <button key={item} type="button" aria-pressed={shownMode === item} onClick={() => setMode(item)} data-testid={`option-chain-mode-${item}`}>
                {t(MODE_LABEL[item])}
              </button>
            ))}
          </div>
          <button type="button" className="option-chain__refresh" disabled={busy} onClick={() => setRefresh((n) => n + 1)} data-testid="option-chain-refresh">
            {t('optionChain.refresh')}
          </button>
        </div>

        <p className="option-chain__meta" role="status" data-testid="option-chain-status">
          {loading && t('optionChain.loading')}
          {showTable && readAt !== null && t('optionChain.meta', { count: formatNumber(strikes.length), time: readAt })}
          {showTable && <ChartPrice spotFn={spotFn} sourcePrice={view.underlyingPrice} />}
          {showTable && view.delayS !== null && view.delayS >= 60 && (
            <> · {t('optionChain.delayed', { minutes: formatNumber(Math.round(view.delayS / 60)) })}</>
          )}
          {showTable && view.premiumUnit !== null && view.premiumUnit !== 'USD' && (
            <> · {t('optionChain.premiumUnit', { unit: view.premiumUnit })}</>
          )}
          {message}
        </p>
        {showTable && view.stale && readAt !== null && (
          <p className="option-chain__warn" role="alert" data-testid="option-chain-stale">{t('optionChain.stale', { time: readAt })}</p>
        )}
        {error && (
          <p className="option-chain__error" role="alert" data-testid="option-chain-error">
            {t(error.key, error.status === undefined ? undefined : { status: error.status })}
          </p>
        )}

        {showTable && strikes.length > 0 && (
          <div className="option-chain__scroll" tabIndex={0} data-testid="option-chain-scroll">
            <table className="option-chain__table">
              <caption className="app-visually-hidden">{t('optionChain.caption')}</caption>
              <thead>
                <tr>
                  <th colSpan={callColumns.length} scope="colgroup" className="is-call">{t('optionChain.calls')}</th>
                  <th rowSpan={2} scope="col" className="option-chain__strike-head">{t('optionChain.strike')}</th>
                  <th colSpan={putColumns.length} scope="colgroup" className="is-put">{t('optionChain.puts')}</th>
                </tr>
                <tr>
                  {callColumns.map((column) => (
                    <th key={`call-${column}`} scope="col" title={COLUMN_TITLE[column] ? t(COLUMN_TITLE[column]) : undefined}>{t(COLUMN_LABEL[column])}</th>
                  ))}
                  {putColumns.map((column) => (
                    <th key={`put-${column}`} scope="col" title={COLUMN_TITLE[column] ? t(COLUMN_TITLE[column]) : undefined}>{t(COLUMN_LABEL[column])}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {strikes.map((row) => {
                  const isAtm = atm !== null && row.strike === atm;
                  return (
                    <tr key={row.strike} ref={row.strike === centre ? focusRow : undefined} className={isAtm ? 'is-atm' : undefined} data-testid={isAtm ? 'option-chain-atm' : undefined}>
                      {sideCells(row.call, callColumns, 'call', spot !== null && row.strike < spot)}
                      <th scope="row" className="option-chain__strike" title={isAtm ? t('optionChain.atm') : undefined}>
                        {formatPrice(row.strike, strikeDp)}
                      </th>
                      {sideCells(row.put, putColumns, 'put', spot !== null && row.strike > spot)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="option-chain__note">{t((view !== null && SOURCE_NOTE[view.source]) || 'optionChain.note')}</p>
      </div>
    </div>,
    document.body,
  );
}
