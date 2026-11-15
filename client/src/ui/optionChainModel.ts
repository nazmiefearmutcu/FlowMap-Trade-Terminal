/**
 * The option chain dialog's data: the `/api/options` answer, read defensively, and the
 * small pure helpers the table is drawn from.
 *
 * What the server states is the source's row for each contract. A field the row does not
 * state arrives as null and is shown as a dash; nothing here fills a gap.
 */

import { sidecarFetch } from '../net/serverBase';
import type { BookSnapshot } from '../state/bookStore';

/** One contract of a series: the call or the put at a strike. */
export interface OptionSide {
  /** The contract as the source spells it (`OPRA:AAPL261113C307.5`). */
  symbol: string;
  bid: number | null;
  /** How much rests at the bid; null when the source states no size. */
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  /** The last trade's price. */
  last: number | null;
  /** The source's theoretical price. */
  theo: number | null;
  /** Implied volatility as a fraction (0.25 is 25%). */
  iv: number | null;
  /** Contracts traded in the session (a crypto venue: in the last 24 hours). */
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

/** One strike of a series. A strike often lists one side only. */
export interface OptionStrike {
  strike: number;
  call: OptionSide | null;
  put: OptionSide | null;
}

/** A series is a contract family and an expiry day (`YYYY-MM-DD`). */
export interface OptionSeriesRef {
  root: string;
  expiry: string;
}

export interface OptionSeriesInfo extends OptionSeriesRef {
  /** How many contracts the source lists in the series, calls and puts together. */
  contracts: number;
}

/**
 * `ok`: strikes follow. `none`: the source lists no options for the instrument.
 * `unsupported`: the market has no ticker the source spells. `unreachable`: the source did
 * not answer and there is no earlier reading.
 */
export type OptionChainStatus = 'ok' | 'none' | 'unsupported' | 'unreachable';

export interface OptionChainView {
  market: string;
  symbol: string;
  status: OptionChainStatus;
  /** What the options are listed under, as the source spells it (`AAPL`, `BIST:THYAO`, `BTC`). */
  underlying: string | null;
  /** The underlying's price as the source states it, when it states one. */
  underlyingPrice: number | null;
  /** What a premium is quoted in when the source says (`USD`, `USDT`, `BTC`). */
  premiumUnit: string | null;
  /** How far behind the market the source is, in seconds; 0 is live, null is not stated. */
  delayS: number | null;
  series: OptionSeriesInfo[];
  /** The series the strikes belong to; the server picks the nearest when none was asked. */
  selected: OptionSeriesRef | null;
  strikes: OptionStrike[];
  /** When the strikes were read from the source (epoch milliseconds). */
  capturedMs: number | null;
  /** True when a refresh failed and this is the last good reading. */
  stale: boolean;
  source: string;
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'none', 'unsupported', 'unreachable']);
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a market whose instruments can have a chain here: every market but the sim feed,
 * whose instruments are not real. The top bar offers no button for it.
 */
export function hasOptionChains(market: string): boolean {
  const m = market.trim().toLowerCase();
  return m !== '' && m !== 'sim' && m !== 'futures-eurex-official';
}

/** The request path of one chain; `series` names the expiry and family, when chosen. */
export function optionChainPath(market: string, symbol: string, series?: OptionSeriesRef | null): string {
  const query = [`market=${encodeURIComponent(market)}`, `symbol=${encodeURIComponent(symbol)}`];
  if (series) {
    query.push(`expiry=${encodeURIComponent(series.expiry)}`, `root=${encodeURIComponent(series.root)}`);
  }
  return `/api/options?${query.join('&')}`;
}

/** A stable identity for a series, used as the picker's option value. */
export function seriesKey(series: OptionSeriesRef): string {
  return `${series.expiry}|${series.root}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function parseSide(value: unknown): OptionSide | null {
  if (!isRecord(value) || typeof value.symbol !== 'string') return null;
  return {
    symbol: value.symbol,
    bid: numberOrNull(value.bid),
    bidSize: numberOrNull(value.bidSize),
    ask: numberOrNull(value.ask),
    askSize: numberOrNull(value.askSize),
    last: numberOrNull(value.last),
    theo: numberOrNull(value.theo),
    iv: numberOrNull(value.iv),
    volume: numberOrNull(value.volume),
    openInterest: numberOrNull(value.openInterest),
    delta: numberOrNull(value.delta),
    gamma: numberOrNull(value.gamma),
    theta: numberOrNull(value.theta),
    vega: numberOrNull(value.vega),
    rho: numberOrNull(value.rho),
  };
}

function parseSeriesRef(value: unknown): OptionSeriesRef | null {
  if (!isRecord(value) || typeof value.root !== 'string' || typeof value.expiry !== 'string') return null;
  if (value.root === '' || !EXPIRY.test(value.expiry)) return null;
  return { root: value.root, expiry: value.expiry };
}

/**
 * The `/api/options` body as a view, or null when it is not one. A malformed row is dropped
 * rather than repaired; a body without a known status is refused whole.
 */
export function parseOptionChain(data: unknown): OptionChainView | null {
  if (!isRecord(data)) return null;
  if (typeof data.status !== 'string' || !STATUSES.has(data.status)) return null;
  if (typeof data.market !== 'string' || typeof data.symbol !== 'string') return null;
  const series: OptionSeriesInfo[] = [];
  for (const item of Array.isArray(data.series) ? data.series : []) {
    const ref = parseSeriesRef(item);
    const contracts = isRecord(item) ? numberOrNull(item.contracts) : null;
    if (ref !== null && contracts !== null && contracts >= 0) series.push({ ...ref, contracts });
  }
  const strikes: OptionStrike[] = [];
  for (const item of Array.isArray(data.strikes) ? data.strikes : []) {
    if (!isRecord(item)) continue;
    const strike = numberOrNull(item.strike);
    if (strike === null) continue;
    const call = parseSide(item.call);
    const put = parseSide(item.put);
    if (call !== null || put !== null) strikes.push({ strike, call, put });
  }
  strikes.sort((a, b) => a.strike - b.strike);
  return {
    market: data.market,
    symbol: data.symbol,
    status: data.status as OptionChainStatus,
    underlying: typeof data.underlying === 'string' ? data.underlying : null,
    underlyingPrice: positiveOrNull(data.underlyingPrice),
    premiumUnit: typeof data.premiumUnit === 'string' && data.premiumUnit !== '' ? data.premiumUnit : null,
    delayS: nonNegativeOrNull(data.delayS),
    series,
    selected: parseSeriesRef(data.selected),
    strikes,
    capturedMs: numberOrNull(data.capturedMs),
    stale: data.stale === true,
    source: typeof data.source === 'string' ? data.source : '',
  };
}

/**
 * Why a chain request failed: `network` (no engine answered), `http` (it answered with an
 * error status) or `invalid` (the body is not a chain).
 */
export class OptionChainRequestError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'invalid',
    readonly status: number,
  ) {
    super(`option chain request ${kind} ${status}`);
  }
}

/** Reads one chain. Throws {@link OptionChainRequestError}; an abort rethrows the abort. */
export async function fetchOptionChain(
  market: string,
  symbol: string,
  series: OptionSeriesRef | null,
  signal: AbortSignal,
): Promise<OptionChainView> {
  let response: Response;
  try {
    response = await sidecarFetch(optionChainPath(market, symbol, series), { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new OptionChainRequestError('network', 0);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  // A non-JSON error body (a proxy page, an empty body) means no engine answered.
  if (!response.ok) throw new OptionChainRequestError(data === undefined ? 'network' : 'http', response.status);
  const view = parseOptionChain(data);
  if (view === null) throw new OptionChainRequestError('invalid', response.status);
  return view;
}

/** The translation key (and its HTTP status, when it has one) that explains a failed request. */
export function optionChainErrorKey(e: unknown): { key: string; status?: number } {
  if (!(e instanceof OptionChainRequestError) || e.kind === 'network') return { key: 'optionChain.errorEngine' };
  if (e.kind === 'invalid') return { key: 'optionChain.errorResponse' };
  return { key: 'optionChain.errorHttp', status: e.status };
}

const DAY_MS = 86_400_000;

/** UTC midnight of a `YYYY-MM-DD` day in epoch milliseconds, or null when it is not a day. */
export function expiryMs(expiry: string): number | null {
  if (!EXPIRY.test(expiry)) return null;
  const [year, month, day] = expiry.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? ms : null;
}

/** Whole calendar days from today (UTC) to the expiry day: 0 is today, negative is past. */
export function daysToExpiry(expiry: string, nowMs: number): number | null {
  const ms = expiryMs(expiry);
  if (ms === null || !Number.isFinite(nowMs)) return null;
  return Math.round((ms - Math.floor(nowMs / DAY_MS) * DAY_MS) / DAY_MS);
}

/** How many decimals a number needs to be written exactly, at most six. */
export function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = value.toFixed(6).replace(/0+$/, '');
  return text.length - text.indexOf('.') - 1;
}

/** The decimals every strike of a series is written with: the most any of them needs. */
export function strikeDecimals(strikes: readonly OptionStrike[]): number {
  let most = 0;
  for (const row of strikes) most = Math.max(most, decimalsOf(row.strike));
  return most;
}

/**
 * The decimals a contract's bid, ask and theoretical price are written with: as many as the
 * finest quote of the series states, never fewer than two and at most six. A series without
 * a single bid or ask (the source lists some that way) is measured on its theoretical prices,
 * at most four, because those are a model's output and not a tick.
 */
export function premiumDecimals(strikes: readonly OptionStrike[]): number {
  let quoted = -1;
  let modelled = -1;
  for (const row of strikes) {
    for (const side of [row.call, row.put]) {
      if (side === null) continue;
      if (side.bid !== null) quoted = Math.max(quoted, decimalsOf(side.bid));
      if (side.ask !== null) quoted = Math.max(quoted, decimalsOf(side.ask));
      if (side.theo !== null) modelled = Math.max(modelled, decimalsOf(side.theo));
    }
  }
  if (quoted >= 0) return Math.min(6, Math.max(2, quoted));
  return Math.min(4, Math.max(2, modelled));
}

/**
 * The decimals one price is written with: the series' own, or more when the value would
 * otherwise be written as zero. A coin-denominated premium of 0.00001074 in a series quoted
 * to four decimals is a small price, not no price.
 */
export function visibleDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value === 0) return decimals;
  if (Math.abs(value) >= 0.5 * 10 ** -decimals) return decimals;
  return Math.min(12, Math.max(decimals, Math.ceil(-Math.log10(Math.abs(value))) + 2));
}

/** The decimals the chart price is written with: what it needs, between two and six. */
export function spotDecimals(spot: number): number {
  return Math.min(6, Math.max(2, decimalsOf(spot)));
}

/** True when any contract states a size, a last trade, a volume or an open interest. */
export function hasActivity(strikes: readonly OptionStrike[]): boolean {
  for (const row of strikes) {
    for (const side of [row.call, row.put]) {
      if (side === null) continue;
      if (side.bidSize !== null || side.askSize !== null || side.last !== null) return true;
      if (side.volume !== null || side.openInterest !== null) return true;
    }
  }
  return false;
}

/** Which price the table is marked with, and where it came from. */
export interface ReferencePrice {
  price: number;
  from: 'chart' | 'source';
}

/**
 * The price the strikes are measured against: the chart's own, unless the chart has none or
 * is plainly not the option's underlying (more than a fifth away from the price the source
 * states for it: a coin charted against another coin, say). Then the source's price is used,
 * and the dialog says so. Null when neither states a price.
 */
export function referencePrice(chart: number | null, source: number | null): ReferencePrice | null {
  const usable = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;
  if (usable(chart) && usable(source)) {
    return Math.abs(chart - source) / source > 0.2 ? { price: source, from: 'source' } : { price: chart, from: 'chart' };
  }
  if (usable(chart)) return { price: chart, from: 'chart' };
  if (usable(source)) return { price: source, from: 'source' };
  return null;
}

/** The listed strike nearest to `spot` (the lower one on a tie), or null without a spot. */
export function atmStrike(strikes: readonly OptionStrike[], spot: number | null): number | null {
  if (spot === null || !Number.isFinite(spot) || spot <= 0) return null;
  let best: number | null = null;
  for (const row of strikes) {
    const gap = Math.abs(row.strike - spot);
    const bestGap = best === null ? Infinity : Math.abs(best - spot);
    if (gap < bestGap || (gap === bestGap && best !== null && row.strike < best)) best = row.strike;
  }
  return best;
}

/**
 * Where a price sits among the strikes: how many lie below it, how many above, and which is
 * nearest. Two prices in the same band mark and tint the table the same way, so the table is
 * redrawn only when the band changes, not on every tick. Null without a price.
 */
export function moneyBand(strikes: readonly OptionStrike[], spot: number | null): string | null {
  const atm = atmStrike(strikes, spot);
  if (spot === null || atm === null) return null;
  let below = 0;
  let above = 0;
  for (const row of strikes) {
    if (row.strike < spot) below += 1;
    else if (row.strike > spot) above += 1;
  }
  return `${below}|${atm}|${above}`;
}

/**
 * The strike the chain is centred on when the chart has no price: the one whose call delta
 * is nearest to one half (or whose put delta is nearest to minus one half when no call
 * states a delta). It only decides what is scrolled into view; nothing is marked with it.
 */
export function midDeltaStrike(strikes: readonly OptionStrike[]): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const side of ['call', 'put'] as const) {
    const target = side === 'call' ? 0.5 : -0.5;
    for (const row of strikes) {
      const delta = row[side]?.delta ?? null;
      if (delta === null) continue;
      const gap = Math.abs(delta - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = row.strike;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * The price on the chart right now: the newest print, or the middle of the best bid and ask
 * when nothing has printed. Null when the stream has stated neither.
 */
export function chartPrice(snapshot: Pick<BookSnapshot, 'bbo' | 'trades'>): number | null {
  const last = snapshot.trades[0]?.price;
  if (last !== undefined && Number.isFinite(last) && last > 0) return last;
  const bbo = snapshot.bbo;
  if (bbo !== null && Number.isFinite(bbo.bidPx) && Number.isFinite(bbo.askPx) && bbo.bidPx > 0 && bbo.askPx > 0) {
    return (bbo.bidPx + bbo.askPx) / 2;
  }
  return null;
}
