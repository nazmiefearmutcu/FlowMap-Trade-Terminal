/**
 * Client for the Research sections, `GET /api/research/{market}/{section}?symbol=`.
 * The server answers every source with the same envelope: a status (`ok`,
 * `empty`, `unavailable`, `not_applicable`), a short reason token, the publisher
 * name and the data for that section. This module checks the envelope and keeps
 * only the well-typed fields of each section's data, so the drawer never has to
 * defend against junk. Numbers are finite or null, strings are strings or null,
 * and every array holds at most {@link MAX_ITEMS} items. Unknown keys are dropped.
 *
 * Nothing here turns a missing value into a guess: a null stays null.
 */

import { sidecarFetch } from './serverBase';

export type ResearchMarket = 'us' | 'crypto';
export type UsSection =
  | 'risk-factors'
  | 'language'
  | 'contracts'
  | 'house-trades'
  | 'gex'
  | 'short-volume'
  | 'hiring';
export type CryptoSection = 'derivatives' | 'options' | 'market' | 'sentiment';
export type ResearchSection = UsSection | CryptoSection;
export type ResearchStatus = 'ok' | 'empty' | 'unavailable' | 'not_applicable';

/** The market a section belongs to, so a call pairs them correctly. */
export type MarketFor<S extends ResearchSection> = S extends UsSection ? 'us' : 'crypto';

/** Sections whose request carries the SEC contact header. */
const SEC_SECTIONS: ReadonlySet<string> = new Set(['us/risk-factors', 'us/language']);

/** Upper bound for every array in a section's data. */
export const MAX_ITEMS = 100;

/** One section's answer, as the drawer reads it. */
export interface ResearchResult<D> {
  section: ResearchSection;
  symbol: string;
  status: ResearchStatus;
  /** A short machine token (`no_awards`, `http_403`, ...); null when there is none. */
  reason: string | null;
  /** The publisher's name, e.g. `SEC EDGAR`. */
  source: string;
  /** ISO date of the observation, or null. */
  asOf: string | null;
  /** Server time of the read, in epoch milliseconds. */
  fetchedAt: number;
  /** True when a refresh failed and this is the last good answer. */
  stale: boolean;
  data: D | null;
}

// ---- section data (the `data` keys of the server's samples) ----

export interface RiskFactorsData {
  form: string | null;
  filedDate: string | null;
  previousForm: string | null;
  previousFiledDate: string | null;
  /** The filing's index page on sec.gov. */
  url: string | null;
  previousUrl: string | null;
  /** Paragraphs in the new Item 1A that were not in the previous one (capped by the server). */
  added: string[];
  /** Paragraphs in the previous Item 1A that are gone from the new one (capped by the server). */
  removed: string[];
  addedCount: number | null;
  removedCount: number | null;
  modifiedCount: number | null;
  /** Fixed trigger words found in the added text, e.g. `going concern`. */
  triggers: string[];
}

export interface TopTerm {
  term: string | null;
  count: number | null;
}

export interface ManagementLanguageData {
  filedDate: string | null;
  previousFiledDate: string | null;
  /** The earnings-release exhibit (text), not audio. */
  url: string | null;
  words: number | null;
  /** Hedging words per 1000 words of the newest release. */
  hedgingPer1k: number | null;
  uncertaintyPer1k: number | null;
  previousHedgingPer1k: number | null;
  previousUncertaintyPer1k: number | null;
  hedgingChange: number | null;
  uncertaintyChange: number | null;
  topTerms: TopTerm[];
}

export interface ContractAward {
  awardId: string | null;
  recipient: string | null;
  agency: string | null;
  subAgency: string | null;
  amount: number | null;
  startDate: string | null;
  description: string | null;
  url: string | null;
}

export interface ContractsData {
  query: string | null;
  windowDays: number | null;
  /** Sum of all matching awards in the window (dollars). */
  listedTotal: number | null;
  matchedCount: number | null;
  awards: ContractAward[];
  source: string | null;
}

export interface HouseTrade {
  ticker: string | null;
  assetType: string | null;
  /** e.g. `Purchase`, `Sale`, `Exchange`. */
  type: string | null;
  transactionDate: string | null;
  notificationDate: string | null;
  /** The disclosed range as text, e.g. `$1,001 - $15,000`. */
  amount: string | null;
  member: string | null;
  state: string | null;
  district: number | null;
  filedDate: string | null;
  reportUrl: string | null;
  committees: string[];
}

export interface HouseCoverage {
  /** Reports read so far. */
  parsed: number | null;
  /** Reports in the index. */
  total: number | null;
  /** Reports that had no readable text (scanned paper filings). */
  unreadable: number | null;
}

export interface HouseTradesData {
  trades: HouseTrade[];
  tradeCount: number | null;
  coverage: HouseCoverage;
  years: number[];
  ownerKnown: boolean;
}

/**
 * The GEX model's levels for one underlying (`gex` for US stocks, `options` for
 * BTC and ETH). `netGex` is in USD: the model's dollar gamma per unit relative
 * move (gamma x open interest x contract size x spot squared, summed over the
 * chain), kept as the server sends it. Its sign gives the dealer-positioning side.
 * `gammaFlip` is null when the curve has no sign change.
 */
export interface GexData {
  spot: number | null;
  netGex: number | null;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  putCallOiRatio: number | null;
  contracts: number | null;
  expiries: number | null;
  maxPain: number | null;
  maxPainExpiry: string | null;
  currency: string | null;
}

export type OptionsData = GexData;

export interface ShortVolumeDay {
  date: string | null;
  shortRatio: number | null;
}

export interface ShortVolumeData {
  date: string | null;
  shortVolume: number | null;
  /** Short-exempt volume (shares); not the same as the OTC non-ATS figure. */
  shortExemptVolume: number | null;
  totalVolume: number | null;
  shortRatio: number | null;
  avgShortRatio5d: number | null;
  days: ShortVolumeDay[];
}

export type HiringTrend = 'expanding' | 'slowing' | 'steady';

export interface HiringData {
  provider: string | null;
  board: string | null;
  boardName: string | null;
  boardUrl: string | null;
  totalOpenings: number | null;
  rdOpenings: number | null;
  newLast30d: number | null;
  newPrior30d: number | null;
  changePct: number | null;
  /** The server's trend label; null when it sent none it recognises. */
  status: HiringTrend | null;
}

export interface DerivativesData {
  pair: string | null;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  fundingRateAnnualPct: number | null;
  /** Epoch milliseconds. */
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestUsd: number | null;
  longShortAccountRatio: number | null;
  longAccountPct: number | null;
  shortAccountPct: number | null;
  takerBuySellRatio: number | null;
}

export interface MarketData {
  coinId: string | null;
  name: string | null;
  rank: number | null;
  price: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  change30dPct: number | null;
  marketCap: number | null;
  volume24h: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  ath: number | null;
  athChangePct: number | null;
  athDate: string | null;
  tvl: number | null;
  tvlSource: string | null;
  tvlReason: string | null;
}

export interface SentimentPoint {
  date: string | null;
  value: number | null;
}

export interface SentimentData {
  value: number | null;
  label: string | null;
  avg7d: number | null;
  avg30d: number | null;
  history: SentimentPoint[];
}

/** The data type of each section, by its name. */
export interface SectionDataMap {
  'risk-factors': RiskFactorsData;
  language: ManagementLanguageData;
  contracts: ContractsData;
  'house-trades': HouseTradesData;
  gex: GexData;
  'short-volume': ShortVolumeData;
  hiring: HiringData;
  derivatives: DerivativesData;
  options: OptionsData;
  market: MarketData;
  sentiment: SentimentData;
}

// ---- validation helpers ----

type Raw = Record<string, unknown>;

const STATUSES: readonly ResearchStatus[] = ['ok', 'empty', 'unavailable', 'not_applicable'];
const HIRING_TRENDS: readonly HiringTrend[] = ['expanding', 'slowing', 'steady'];

function record(value: unknown): Raw | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A link from the server, kept only when it is an https address. The drawer
 * opens these in a new tab, so a `javascript:` or plain `http:` value is dropped.
 */
function httpsUrl(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The first {@link MAX_ITEMS} entries of an array, each mapped by `item`; non-objects are dropped. */
function objects<T>(value: unknown, item: (raw: Raw) => T): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const raw = record(entry);
    if (raw !== null) out.push(item(raw));
  }
  return out;
}

/** Strings from an array, at most {@link MAX_ITEMS}. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).filter((entry): entry is string => typeof entry === 'string');
}

/** Finite numbers from an array, at most {@link MAX_ITEMS}. */
function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).filter((entry): entry is number => num(entry) !== null);
}

function trend(value: unknown): HiringTrend | null {
  return HIRING_TRENDS.find((known) => known === value) ?? null;
}

// ---- per-section validators ----

function riskFactors(r: Raw): RiskFactorsData {
  return {
    form: str(r.form),
    filedDate: str(r.filedDate),
    previousForm: str(r.previousForm),
    previousFiledDate: str(r.previousFiledDate),
    url: httpsUrl(r.url),
    previousUrl: httpsUrl(r.previousUrl),
    added: strings(r.added),
    removed: strings(r.removed),
    addedCount: num(r.addedCount),
    removedCount: num(r.removedCount),
    modifiedCount: num(r.modifiedCount),
    triggers: strings(r.triggers),
  };
}

function managementLanguage(r: Raw): ManagementLanguageData {
  return {
    filedDate: str(r.filedDate),
    previousFiledDate: str(r.previousFiledDate),
    url: httpsUrl(r.url),
    words: num(r.words),
    hedgingPer1k: num(r.hedgingPer1k),
    uncertaintyPer1k: num(r.uncertaintyPer1k),
    previousHedgingPer1k: num(r.previousHedgingPer1k),
    previousUncertaintyPer1k: num(r.previousUncertaintyPer1k),
    hedgingChange: num(r.hedgingChange),
    uncertaintyChange: num(r.uncertaintyChange),
    topTerms: objects(r.topTerms, (t): TopTerm => ({ term: str(t.term), count: num(t.count) })),
  };
}

function contracts(r: Raw): ContractsData {
  return {
    query: str(r.query),
    windowDays: num(r.windowDays),
    listedTotal: num(r.listedTotal),
    matchedCount: num(r.matchedCount),
    awards: objects(r.awards, (a): ContractAward => ({
      awardId: str(a.awardId),
      recipient: str(a.recipient),
      agency: str(a.agency),
      subAgency: str(a.subAgency),
      amount: num(a.amount),
      startDate: str(a.startDate),
      description: str(a.description),
      url: httpsUrl(a.url),
    })),
    source: str(r.source),
  };
}

function houseTrades(r: Raw): HouseTradesData {
  const coverage = record(r.coverage) ?? {};
  return {
    trades: objects(r.trades, (t): HouseTrade => ({
      ticker: str(t.ticker),
      assetType: str(t.assetType),
      type: str(t.type),
      transactionDate: str(t.transactionDate),
      notificationDate: str(t.notificationDate),
      amount: str(t.amount),
      member: str(t.member),
      state: str(t.state),
      district: num(t.district),
      filedDate: str(t.filedDate),
      reportUrl: httpsUrl(t.reportUrl),
      committees: strings(t.committees),
    })),
    tradeCount: num(r.tradeCount),
    coverage: {
      parsed: num(coverage.parsed),
      total: num(coverage.total),
      unreadable: num(coverage.unreadable),
    },
    years: numbers(r.years),
    ownerKnown: r.ownerKnown === true,
  };
}

function gex(r: Raw): GexData {
  return {
    spot: num(r.spot),
    netGex: num(r.netGex),
    callWall: num(r.callWall),
    putWall: num(r.putWall),
    gammaFlip: num(r.gammaFlip),
    putCallOiRatio: num(r.putCallOiRatio),
    contracts: num(r.contracts),
    expiries: num(r.expiries),
    maxPain: num(r.maxPain),
    maxPainExpiry: str(r.maxPainExpiry),
    currency: str(r.currency),
  };
}

function shortVolume(r: Raw): ShortVolumeData {
  return {
    date: str(r.date),
    shortVolume: num(r.shortVolume),
    shortExemptVolume: num(r.shortExemptVolume),
    totalVolume: num(r.totalVolume),
    shortRatio: num(r.shortRatio),
    avgShortRatio5d: num(r.avgShortRatio5d),
    days: objects(r.days, (d): ShortVolumeDay => ({ date: str(d.date), shortRatio: num(d.shortRatio) })),
  };
}

function hiring(r: Raw): HiringData {
  return {
    provider: str(r.provider),
    board: str(r.board),
    boardName: str(r.boardName),
    boardUrl: httpsUrl(r.boardUrl),
    totalOpenings: num(r.totalOpenings),
    rdOpenings: num(r.rdOpenings),
    newLast30d: num(r.newLast30d),
    newPrior30d: num(r.newPrior30d),
    changePct: num(r.changePct),
    status: trend(r.status),
  };
}

function derivatives(r: Raw): DerivativesData {
  return {
    pair: str(r.pair),
    markPrice: num(r.markPrice),
    indexPrice: num(r.indexPrice),
    fundingRate: num(r.fundingRate),
    fundingIntervalHours: num(r.fundingIntervalHours),
    fundingRateAnnualPct: num(r.fundingRateAnnualPct),
    nextFundingTime: num(r.nextFundingTime),
    openInterest: num(r.openInterest),
    openInterestUsd: num(r.openInterestUsd),
    longShortAccountRatio: num(r.longShortAccountRatio),
    longAccountPct: num(r.longAccountPct),
    shortAccountPct: num(r.shortAccountPct),
    takerBuySellRatio: num(r.takerBuySellRatio),
  };
}

function market(r: Raw): MarketData {
  return {
    coinId: str(r.coinId),
    name: str(r.name),
    rank: num(r.rank),
    price: num(r.price),
    change24hPct: num(r.change24hPct),
    change7dPct: num(r.change7dPct),
    change30dPct: num(r.change30dPct),
    marketCap: num(r.marketCap),
    volume24h: num(r.volume24h),
    circulatingSupply: num(r.circulatingSupply),
    totalSupply: num(r.totalSupply),
    maxSupply: num(r.maxSupply),
    ath: num(r.ath),
    athChangePct: num(r.athChangePct),
    athDate: str(r.athDate),
    tvl: num(r.tvl),
    tvlSource: str(r.tvlSource),
    tvlReason: str(r.tvlReason),
  };
}

function sentiment(r: Raw): SentimentData {
  return {
    value: num(r.value),
    label: str(r.label),
    avg7d: num(r.avg7d),
    avg30d: num(r.avg30d),
    history: objects(r.history, (p): SentimentPoint => ({ date: str(p.date), value: num(p.value) })),
  };
}

const VALIDATORS: { [S in ResearchSection]: (raw: Raw) => SectionDataMap[S] } = {
  'risk-factors': riskFactors,
  language: managementLanguage,
  contracts,
  'house-trades': houseTrades,
  gex,
  'short-volume': shortVolume,
  hiring,
  derivatives,
  options: gex,
  market,
  sentiment,
};

// ---- envelope and transport ----

/** A failed read, with a short code: `http_<status>`, `network` or `invalid_reply`. */
export class ResearchFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`research request failed: ${code}`);
    this.name = 'ResearchFetchError';
    this.code = code;
  }
}

/**
 * The section's data, validated. `ok` is false when the reply has data of the
 * wrong shape, or none where an `ok` answer needs some.
 */
function parseData<S extends ResearchSection>(
  section: S,
  status: ResearchStatus,
  raw: unknown,
): { ok: true; data: SectionDataMap[S] | null } | { ok: false } {
  if (raw === null || raw === undefined) return status === 'ok' ? { ok: false } : { ok: true, data: null };
  const data = record(raw);
  if (data === null) return { ok: false };
  return { ok: true, data: VALIDATORS[section](data) };
}

function parseResult<S extends ResearchSection>(
  body: unknown,
  section: S,
  symbol: string,
): ResearchResult<SectionDataMap[S]> {
  const r = record(body);
  if (r === null) throw new ResearchFetchError('invalid_reply');
  const status = STATUSES.find((known) => known === r.status);
  if (status === undefined) throw new ResearchFetchError('invalid_reply');
  if (typeof r.fetchedAt !== 'number' || !Number.isFinite(r.fetchedAt)) throw new ResearchFetchError('invalid_reply');
  if (typeof r.stale !== 'boolean' || typeof r.source !== 'string') throw new ResearchFetchError('invalid_reply');

  const base = {
    section,
    symbol: str(r.symbol) ?? symbol,
    status,
    reason: str(r.reason),
    source: r.source,
    asOf: str(r.asOf),
    fetchedAt: r.fetchedAt,
    stale: r.stale,
  };
  const parsed = parseData(section, status, r.data);
  if (!parsed.ok) {
    return { ...base, status: 'unavailable', reason: 'invalid_reply', data: null };
  }
  return { ...base, data: parsed.data };
}

export interface FetchResearchOptions {
  signal?: AbortSignal;
  /** The user's SEC contact e-mail. Sent in a header, only on the two SEC sections. */
  secContact?: string;
}

/**
 * Loads one section for one symbol. Resolves with the envelope and validated data
 * (a data reply that fails validation becomes `unavailable` with `invalid_reply`).
 * Rejects with {@link ResearchFetchError} on a non-2xx status, a network failure or
 * an envelope that is not a research reply; rejects with the abort reason when
 * `signal` aborts.
 */
export async function fetchResearch<S extends ResearchSection>(
  market: MarketFor<S>,
  section: S,
  symbol: string,
  options: FetchResearchOptions = {},
): Promise<ResearchResult<SectionDataMap[S]>> {
  const { signal } = options;
  const headers: Record<string, string> = {};
  const contact = options.secContact?.trim() ?? '';
  if (contact !== '' && SEC_SECTIONS.has(`${market}/${section}`)) headers['X-SEC-Contact'] = contact;

  const path = `/api/research/${market}/${section}?symbol=${encodeURIComponent(symbol)}`;
  let response: Response;
  try {
    response = await sidecarFetch(path, { signal, headers });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new ResearchFetchError('network');
  }
  if (!response.ok) throw new ResearchFetchError(`http_${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new ResearchFetchError('invalid_reply');
  }
  return parseResult(body, section, symbol);
}
