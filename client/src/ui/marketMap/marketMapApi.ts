/**
 * Client for the market map endpoint, `GET /api/market-map`. The server reads a
 * public screener, so each response can be partly unusable: this module keeps
 * only the items it can draw (a symbol and a positive market value) and only the
 * finite change figures, so the view never has to defend against junk.
 */

import { sidecarFetch } from '../../net/serverBase';

export type MapMarket = 'us' | 'crypto';

export interface MapItem {
  symbol: string;
  name: string;
  group: string;
  marketCap: number;
  price: number;
  /** Price change in percent, keyed by period (`1d`, `1h`, `24h`, `7d`). */
  change: Record<string, number>;
  volume: number | null;
  /** Where a click opens the chart, or null when the instrument has no chart. */
  chart: { market: string; symbol: string } | null;
}

export interface MarketMapData {
  market: MapMarket;
  asOf: number;
  source: string;
  stale: boolean;
  items: MapItem[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseChange(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [period, value] of Object.entries(raw)) {
    if (isFiniteNumber(value)) out[period] = value;
  }
  return out;
}

function parseChart(raw: unknown): MapItem['chart'] {
  if (typeof raw !== 'object' || raw === null) return null;
  const { market, symbol } = raw as Record<string, unknown>;
  if (typeof market !== 'string' || typeof symbol !== 'string') return null;
  return { market, symbol };
}

function parseItem(raw: unknown): MapItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.symbol !== 'string' || r.symbol === '') return null;
  if (!isFiniteNumber(r.marketCap) || r.marketCap <= 0) return null;
  return {
    symbol: r.symbol,
    name: typeof r.name === 'string' && r.name !== '' ? r.name : r.symbol,
    group: typeof r.group === 'string' && r.group !== '' ? r.group : 'Other',
    marketCap: r.marketCap,
    price: isFiniteNumber(r.price) ? r.price : Number.NaN,
    change: parseChange(r.change),
    volume: isFiniteNumber(r.volume) ? r.volume : null,
    chart: parseChart(r.chart),
  };
}

function parseResponse(raw: unknown, market: MapMarket): MarketMapData {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(r.items)
    ? r.items.map(parseItem).filter((item): item is MapItem => item !== null)
    : [];
  return {
    market,
    asOf: isFiniteNumber(r.asOf) ? r.asOf : Date.now(),
    source: typeof r.source === 'string' ? r.source : '',
    stale: r.stale === true,
    items,
  };
}

/** The server's reason from an error body (`{"error": {"message": ...}}`), or null. */
function errorReason(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const error = (raw as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : null;
}

/**
 * Loads one market's map. Rejects with the server's reason on a non-2xx status,
 * and with the abort reason when `signal` aborts.
 */
export async function fetchMarketMap(market: MapMarket, signal?: AbortSignal): Promise<MarketMapData> {
  const response = await sidecarFetch(`/api/market-map?market=${encodeURIComponent(market)}`, { signal });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new Error(errorReason(body) ?? `The market map request failed (HTTP ${response.status}).`);
  }
  return parseResponse(await response.json(), market);
}
