/**
 * Time & sales tape panel (right rail).
 *
 * A scrolling list of the most recent trades (newest on top), each row: time
 * (HH:MM:SS.mmm), price, size, colored by aggressor side (buy teal / sell red /
 * unknown grey). Bounded to the last ~200. Large trades are emphasized (bold +
 * background tint) above a rolling threshold (the p90 of the visible sizes — a
 * display emphasis, not a data claim). The badge is honest: `TAPE TICK` for a
 * real tick tape, else `TAPE <mode>` (e.g. `TAPE POLL` / `TAPE 10S`) — it always
 * states the actual tier.
 *
 * Time is formatted from `ts_ns` as wall-clock HH:MM:SS.mmm in the Settings → Time
 * zone choice (UTC by default). The sim's ts_ns is session-relative, not wall time:
 * the tape prints it as UTC digits with no zone label and never converts it to the
 * chosen zone (the axis and the top bar show that same session clock as T+).
 *
 * Each row also carries the aggressor side as a triangle (▲ buy, ▼ sell, – unknown)
 * and a screen-reader word, so the side is never conveyed by colour alone (WCAG 1.4.1).
 *
 * Auto-scroll keeps the newest trade at the top; hovering the tape PAUSES updates
 * (freezing the list so a row can be read) and resuming snaps to the latest. Trades
 * arrive off the module-scoped {@link bookStore} at ~10 Hz, off the React
 * high-frequency path so the GL loop is untouched.
 *
 * On top of the rolling p90 display emphasis, a PERSISTED absolute threshold
 * (settings.bigTradeUsd, via the `bigTradeUsd` prop) gives rows at or above the
 * notional a static accent highlight plus an honest header chip (`3 big`); it is
 * off at 0 (the default) and renders nothing then.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { SIDE_BUY, SIDE_SELL } from '../proto/types';
import {
  subscribe,
  getSnapshot,
  bookSessionKey,
  type BookSnapshot,
  type TapeTrade,
} from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { useT } from '../i18n/useT';
import { exchangeZoneFor, formatClock, formatFixed, formatNumber, formatPrice, useTimeZone, type TimeZonePref } from '../i18n/format';
import { priceDecimals } from './DomLadder';
import { marketGroup } from './symbols';
import './TradingPanels.css';
import './Tape.css';

/** Max rows rendered: the last ~200 prints. */
const TAPE_MAX = 200;
const EMPTY_TAPE: readonly TapeTrade[] = Object.freeze([]);
/** Minimum trades before the large-lot emphasis kicks in (avoid noise on cold start). */
const LARGE_MIN_SAMPLES = 12;

/** Honest tape-tier badge from the capability descriptor. */
export function tapeBadge(capability: Record<string, unknown> | null): string {
  const t = capability?.tape;
  if (typeof t !== 'string') return 'TAPE';
  return `TAPE ${t.toUpperCase()}`;
}

/**
 * The p90 size over the visible trades, or Infinity when there are too few
 * samples OR no spread to be "large" against. A uniform tape (every print the
 * same size) has no outliers, so nothing is emphasised; before this check every
 * row at that size was bolded. When most prints share the floor size
 * but a few are larger, the p90 sits on the floor, so the smallest larger size
 * is the threshold instead: a lone outlier still stands out.
 */
export function largeThreshold(trades: readonly TapeTrade[]): number {
  if (trades.length < LARGE_MIN_SAMPLES) return Number.POSITIVE_INFINITY;
  const sizes = trades.map((t) => t.size).sort((a, b) => a - b);
  const floor = sizes[0];
  const idx = Math.floor(sizes.length * 0.9);
  const p90 = sizes[Math.min(idx, sizes.length - 1)];
  if (p90 > floor) return p90;
  return sizes.find((s) => s > floor) ?? Number.POSITIVE_INFINITY;
}

/**
 * The persisted big-trade rule (settings.bigTradeUsd): a trade qualifies when
 * `price × native size` reaches the threshold. The stored key retains its
 * historical name; contract quantities do not imply USD notional. Pure + strict:
 *   - a threshold at or below 0 (or non-finite) is OFF — nothing is ever big;
 *   - a NaN price or size is never big (no honest notional, no highlight);
 *   - the boundary counts: exactly at the threshold IS big.
 */
export function isBigTrade(price: number, qty: number, threshold: number): boolean {
  if (!(threshold > 0) || !Number.isFinite(threshold)) return false;
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return false;
  return price * qty >= threshold;
}

export type TapeSide = 'buy' | 'sell' | 'unknown';
export type TapeSideFilter = TapeSide | 'all';

/** Price × native quantity, inclusive boundary; contract units vary by venue. */
export function filterTape(trades: readonly TapeTrade[], side: TapeSideFilter, minimum: number): readonly TapeTrade[] {
  const floor = Number.isFinite(minimum) && minimum > 0 ? minimum : 0;
  return trades.filter((t) => (side === 'all' || sideClass(t.side) === side)
    && (floor === 0 || (Number.isFinite(t.price * t.size) && t.price * t.size >= floor)));
}

export function sideClass(side: number): TapeSide {
  if (side === SIDE_BUY) return 'buy';
  if (side === SIDE_SELL) return 'sell';
  return 'unknown';
}

/**
 * The decorative side mark drawn on each row: up for a buy, down for a sell, an
 * en dash for unknown. A shape rather than a letter, so the mark reads the same in
 * every UI locale (buy is "A" in Turkish) and side never rests on colour alone
 * (WCAG 1.4.1). It is aria-hidden; the side word is the screen-reader text.
 */
export function sideGlyph(side: TapeSide): string {
  if (side === 'buy') return '▲';
  if (side === 'sell') return '▼';
  return '–';
}

/**
 * ns → HH:MM:SS.mmm in the chosen zone (default UTC). Sim ts_ns is session-relative,
 * so the tape passes `utc` for it: the digits read as the session clock, never as a
 * wall time in another zone.
 */
export function fmtTapeTime(ns: bigint, pref: TimeZonePref = 'utc', exchangeZone = 'UTC'): string {
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  try {
    return formatClock(ms, pref, exchangeZone, true);
  } catch {
    return '—';
  }
}

/**
 * Tape size text with adaptive precision (2–4 significant decimals by
 * magnitude). The old fixed 2dp printed "0.00" for BTC-class fills of
 * 0.0001–0.004 — a wall of fake zeros. Sub-unit sizes keep 3dp down to 0.1
 * and 4dp below (the data-size precision); anything smaller than even 4dp
 * falls back to 2 significant digits so a real print never reads "0.0000".
 */
export function fmtTapeSize(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return formatFixed(v, 0);
  if (v >= 100) return formatFixed(v, 1);
  if (v >= 1) return formatFixed(v, 2);
  if (v <= 0) return '0';
  if (v >= 0.1) return formatFixed(v, 3);
  if (v >= 0.0001) return formatFixed(v, 4);
  // Two significant digits, in the UI's decimal separator, never exponential.
  return formatNumber(v, { minimumSignificantDigits: 2, maximumSignificantDigits: 2, useGrouping: false });
}

/**
 * Stable React keys for the tape rows. A trade carries no sequence number, so
 * the identity is its content (ts + price + size + side) plus an occurrence
 * index for genuine duplicates. The index is assigned OLDEST-FIRST (right-to-
 * left over the newest-first array) so prepending a newer trade never renumbers
 * an older row's key — the old `${tsNs}-${i}` positional key remounted every
 * visible row ~10 times a second (each append shifts every index by one).
 */
export function tapeKeys(trades: readonly TapeTrade[]): string[] {
  const seen = new Map<string, number>();
  const keys = new Array<string>(trades.length);
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const t = trades[i];
    const base = `${t.tsNs}-${t.price}-${t.size}-${t.side}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys[i] = `${base}-${n}`;
  }
  return keys;
}

interface TapeRowProps {
  trade: TapeTrade;
  side: TapeSide;
  large: boolean;
  big: boolean;
  decimals: number;
  tapePref: TimeZonePref;
  tapeZone: string;
  /** The translated side word, the row's screen-reader text. */
  sideWord: string;
}

/**
 * One print on the tape. Memoised: a trade is immutable and the list only grows
 * at its head, so a book flush re-renders the new rows and leaves the rest alone.
 * Every prop is a primitive or the immutable trade, so an unchanged row keeps its
 * previous output.
 */
export const TapeRow = memo(function TapeRow({
  trade,
  side,
  large,
  big,
  decimals,
  tapePref,
  tapeZone,
  sideWord,
}: TapeRowProps): JSX.Element {
  return (
    <div
      className={`tape__row tape__row--${side}${large ? ' is-large' : ''}${big ? ' is-big' : ''}`}
      data-testid="tape-row"
      data-side={side}
      data-side-src={trade.sideSrc}
      data-price={trade.price.toFixed(decimals)}
      data-size={trade.size.toFixed(4)}
      data-large={large ? '1' : '0'}
      data-big={big ? '1' : '0'}
    >
      <span className="tape__time">
        {fmtTapeTime(trade.tsNs, tapePref, tapeZone)}
        <span className="tape__side" aria-hidden="true">{sideGlyph(side)}</span>
        <span className="tape__sr app-visually-hidden">{sideWord}</span>
      </span>
      <span className="tape__px">{formatPrice(trade.price, decimals)}</span>
      <span className="tape__sz">{fmtTapeSize(trade.size)}</span>
    </div>
  );
});

export function Tape({ bigTradeUsd = 0 }: { bigTradeUsd?: number }): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const sessionKey = useFlowMapStore(bookSessionKey);
  const t = useT();
  const zonePref = useTimeZone();
  const subMarket = useFlowMapStore((s) => s.subscription?.market);
  // Sim timestamps are SESSION-RELATIVE: no wall zone applies, so they stay UTC digits.
  const tapePref: TimeZonePref = (subMarket ?? 'sim') === 'sim' ? 'utc' : zonePref;
  const tapeZone = exchangeZoneFor(marketGroup(subMarket ?? 'sim'));
  const [snap, setSnap] = useState<BookSnapshot>(() => getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
  // Hover-pause freezes the list so a row can be read; without a visible
  // indicator that read like a stuck feed, so the header says HELD.
  const [held, setHeld] = useState(false);
  const [sideFilter, setSideFilter] = useState<TapeSideFilter>('all');
  const [minimum, setMinimum] = useState('');
  const pausedRef = useRef(false);
  const explicitHoldRef = useRef(false);
  const sessionVersionRef = useRef(snap.sessionVersion);

  // Reset before paint: even a hovered/explicitly held tape must drop old rows.
  useLayoutEffect(() => {
    pausedRef.current = false;
    explicitHoldRef.current = false;
    setHeld(false);
    setSideFilter('all');
    setMinimum('');
    const current = getSnapshot();
    sessionVersionRef.current = current.sessionVersion;
    setSnap(current);
  }, [sessionKey]);

  useEffect(
    () =>
      subscribe((s) => {
        if (s.sessionVersion !== sessionVersionRef.current) {
          sessionVersionRef.current = s.sessionVersion;
          pausedRef.current = false;
          explicitHoldRef.current = false;
          setHeld(false);
          setSideFilter('all');
          setMinimum('');
          setSnap(s);
        } else if (!pausedRef.current) {
          // Depth-only flushes retain tape identity and do not rerender this list.
          setSnap((prev) => prev.trades === s.trades && prev.sessionKey === s.sessionKey ? prev : s);
        }
      }),
    [],
  );

  const onEnter = (): void => {
    pausedRef.current = true;
    setHeld(true);
  };
  const onLeave = (): void => {
    if (explicitHoldRef.current) return;
    pausedRef.current = false;
    setHeld(false);
    setSnap(getSnapshot());
  };

  const toggleHold = (): void => {
    const next = !held;
    explicitHoldRef.current = next;
    pausedRef.current = next;
    setHeld(next);
    if (!next) setSnap(getSnapshot());
  };

  const source = snap.sessionKey === sessionKey ? snap.trades : EMPTY_TAPE;
  const matched = useMemo(() => filterTape(source, sideFilter, Number(minimum)), [source, sideFilter, minimum]);
  const trades = useMemo(() => matched.slice(0, TAPE_MAX), [matched]);
  const keys = useMemo(() => tapeKeys(trades), [trades]);
  const threshold = useMemo(() => largeThreshold(trades), [trades]);
  // Absolute notional highlight (settings.bigTradeUsd; 0 = off). Computed once
  // per render so the header chip and the row classes always agree.
  const bigActive = bigTradeUsd > 0;
  const bigCount = useMemo(() => bigActive
    ? trades.reduce((n, t) => n + (isBigTrade(t.price, t.size, bigTradeUsd) ? 1 : 0), 0)
    : 0, [bigActive, bigTradeUsd, trades]);
  // Price precision from the active epoch's step when known.
  const params = epochs.get(gridEpoch ?? -1);
  const decimals = params ? priceDecimals(params.tick) : 2;
  const badge = tapeBadge(capability);
  // Screen-reader side words (the same words the side filter shows), translated once.
  const sideWords: Record<TapeSide, string> = {
    buy: t('tape.sideBuy'),
    sell: t('tape.sideSell'),
    unknown: t('tape.sideUnknown'),
  };

  return (
    <section className={`panel tape${collapsed ? ' is-collapsed' : ''}`} data-testid="tape">
      <header className="panel__header">
        <button
          type="button"
          className="panel__collapse"
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed((c) => !c);
            if (!explicitHoldRef.current) {
              pausedRef.current = false;
              setHeld(false);
              setSnap(getSnapshot());
            }
          }}
          data-testid="tape-collapse"
        >
          <span className="panel__chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="panel__title">{t('tape.title')}</span>
        </button>
        <span className="panel__badge panel__badge--tape" data-testid="tape-badge">
          {badge}
        </span>
        {held && (
          <span className="panel__badge tape__held" data-testid="tape-held" title={t('tape.heldTitle')}>
            {t('tape.held')}
          </span>
        )}
        {bigActive && (
          <span
            className="panel__badge tape__big"
            data-testid="tape-big"
            title={t('tape.bigRows', { amount: formatNumber(bigTradeUsd) })}
          >
            {t('tape.big', { count: bigCount })}
          </span>
        )}
        <button type="button" className="panel__lock tape__hold" aria-pressed={held}
          onClick={toggleHold} data-testid="tape-hold">{held ? t('tape.resume') : t('tape.hold')}</button>
      </header>
      {!collapsed && (
        <>
        <div className="tape__controls">
          <label>{t('tape.side')}
            <select aria-label={t('tape.sideAria')} value={sideFilter} data-testid="tape-side"
              onChange={(e) => setSideFilter(e.target.value as TapeSideFilter)}>
              <option value="all">{t('tape.sideAll')}</option><option value="buy">{t('tape.sideBuy')}</option>
              <option value="sell">{t('tape.sideSell')}</option><option value="unknown">{t('tape.sideUnknown')}</option>
            </select>
          </label>
          <label title={t('tape.minTitle')}>{t('tape.minLabel')}
            <input aria-label={t('tape.minAria')} type="number" min="0" step="any"
              placeholder="0" value={minimum} data-testid="tape-minimum"
              onChange={(e) => setMinimum(e.target.value)} />
          </label>
          <span className="tape__count" data-testid="tape-count"
            title={t('tape.countTitle', {
              shown: formatNumber(trades.length),
              matching: formatNumber(matched.length),
              retained: formatNumber(source.length),
            })}>{formatNumber(trades.length)}/{formatNumber(source.length)}</span>
        </div>
        <div
          className="tape__body"
          data-testid="tape-body"
          role="region"
          aria-label={t('tape.title')}
          tabIndex={0}
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        >
          {trades.length === 0 ? (
            <div className="panel__empty">{source.length === 0 ? t('tape.waiting') : t('tape.noMatch')}</div>
          ) : (
            <div className="tape__rows">
              {trades.map((trade, i) => {
                const side = sideClass(trade.side);
                return (
                  <TapeRow
                    key={keys[i]}
                    trade={trade}
                    side={side}
                    large={trade.size >= threshold}
                    big={isBigTrade(trade.price, trade.size, bigTradeUsd)}
                    decimals={decimals}
                    tapePref={tapePref}
                    tapeZone={tapeZone}
                    sideWord={sideWords[side]}
                  />
                );
              })}
            </div>
          )}
        </div>
        </>
      )}
    </section>
  );
}
