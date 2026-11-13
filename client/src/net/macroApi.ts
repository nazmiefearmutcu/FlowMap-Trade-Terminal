/**
 * Client for the macro endpoint, `GET /api/macro`. The server reads public
 * sources, so any figure can be missing. This module keeps a figure only when it
 * is a finite number and a date or status only when it is a non-empty string; a
 * missing figure stays null, so the view shows it as missing and never guesses.
 */

import { sidecarFetch } from './serverBase';

export interface MacroReadingData {
  /** SOFR in percent, or null when the New York Fed gave no value. */
  sofr: number | null;
  sofrDate: string | null;
  /** The 10Y minus 2Y Treasury spread in percent, or null. */
  yield10y2y: number | null;
  curveDate: string | null;
  /** The ICE BofA high-yield option-adjusted spread in percent, or null without a FRED key. */
  hySpread: number | null;
  hyDate: string | null;
  /** Null unless both the high-yield spread and the curve are present. */
  stressScore: number | null;
  /** NORMAL_LIQUIDITY, ELEVATED or SEVERE_STRESS, or null with no stress score. */
  status: string | null;
  /** Per series: "ok", or the short reason it has no value. */
  sourceStatus: Record<string, string>;
  /** Per series: the publisher's name. */
  sources: Record<string, string>;
  /** When the server fetched the reading, in ms since the epoch. */
  asOf: number;
  /** True when the server is serving an earlier reading after a failed refresh. */
  stale: boolean;
}

/** The message shown when the server gives no usable reason. */
export const MACRO_LOAD_FAILED_MESSAGE = 'The macro data could not be loaded.';

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function textMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** The reading from a response body, or null when the body is not an object. */
export function parseMacroReading(raw: unknown): MacroReadingData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    sofr: finiteOrNull(r.sofr),
    sofrDate: textOrNull(r.sofrDate),
    yield10y2y: finiteOrNull(r.yield10y2y),
    curveDate: textOrNull(r.curveDate),
    hySpread: finiteOrNull(r.hySpread),
    hyDate: textOrNull(r.hyDate),
    stressScore: finiteOrNull(r.stressScore),
    status: textOrNull(r.status),
    sourceStatus: textMap(r.sourceStatus),
    sources: textMap(r.sources),
    asOf: finiteOrNull(r.asOf) ?? Date.now(),
    stale: r.stale === true,
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
 * Loads the macro reading. Rejects with the server's reason on a non-2xx status,
 * and with the abort reason when `signal` aborts.
 */
export async function fetchMacro(signal?: AbortSignal): Promise<MacroReadingData> {
  const response = await sidecarFetch('/api/macro', { signal });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new Error(errorReason(body) ?? `${MACRO_LOAD_FAILED_MESSAGE} (HTTP ${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(MACRO_LOAD_FAILED_MESSAGE);
  }
  const reading = parseMacroReading(body);
  if (reading === null) throw new Error(MACRO_LOAD_FAILED_MESSAGE);
  return reading;
}
