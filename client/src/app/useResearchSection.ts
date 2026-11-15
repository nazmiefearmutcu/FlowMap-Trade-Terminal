/**
 * Loads one Research section for the drawer. The request runs only while the
 * section is enabled (the visible tab, with the drawer open) and is aborted when
 * any argument changes or the component unmounts.
 *
 * A module-level cache keeps each answer for the section's keep time, so
 * reopening a tab does not ask the server again. Only answers that carry data or
 * a reason the server is sure of are kept: `unavailable` answers are asked again
 * next time, because a source that was down may be back. A failed refresh keeps
 * the last result on screen and sets `errorCode`.
 *
 * `house-trades` is read in the background while the House reports are still
 * being parsed (`coverage.parsed < coverage.total`): it is asked again every
 * 30 s, past the cache, while the section is mounted and enabled.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchResearch,
  ResearchFetchError,
  type HouseTradesData,
  type MarketFor,
  type ResearchResult,
  type ResearchSection,
  type SectionDataMap,
} from '../net/researchApi';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a kept answer is reused, per section (ms). */
export const RESEARCH_KEEP_MS: Readonly<Record<ResearchSection, number>> = {
  'risk-factors': 6 * HOUR_MS,
  language: 6 * HOUR_MS,
  contracts: 6 * HOUR_MS,
  'house-trades': MINUTE_MS,
  gex: 15 * MINUTE_MS,
  'short-volume': HOUR_MS,
  hiring: 12 * HOUR_MS,
  derivatives: MINUTE_MS,
  options: 15 * MINUTE_MS,
  market: 10 * MINUTE_MS,
  sentiment: HOUR_MS,
};

/** Re-read interval for House trades while the report parsing is incomplete. */
export const HOUSE_POLL_MS = 30_000;
/** Re-read interval while the House disclosure index is still loading. */
export const INDEX_RETRY_MS = 15_000;

export type ResearchLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseResearchSectionOptions {
  enabled: boolean;
  /** The user's SEC contact e-mail; '' when not set. */
  secContact: string;
}

export interface ResearchSectionState<S extends ResearchSection> {
  state: ResearchLoadState;
  /** The current answer, or the last one kept when a refresh failed. */
  result: ResearchResult<SectionDataMap[S]> | null;
  /** The failure's short code (`http_403`, `network`, ...) after an error, else null. */
  errorCode: string | null;
  /** Asks the server again now, bypassing the cache. */
  refresh: () => void;
}

interface CacheEntry {
  at: number;
  result: ResearchResult<unknown>;
}

/**
 * Most answers kept at once. Each one holds up to 100 items per array, so the
 * cache is capped; when it is full the oldest entry (first inserted) goes.
 */
export const RESEARCH_CACHE_LIMIT = 200;

const cache = new Map<string, CacheEntry>();

/** Keeps an answer, moving its key to the newest place and dropping the oldest over the limit. */
function cacheStore(key: string, result: ResearchResult<unknown>, now: number): void {
  cache.delete(key);
  cache.set(key, { at: now, result });
  while (cache.size > RESEARCH_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Forgets every kept answer. For tests. */
export function clearResearchCache(): void {
  cache.clear();
}

/** The cache key of one request. The contact flag is part of it, so a new contact asks again. */
export function researchCacheKey(
  market: string,
  section: string,
  symbol: string,
  secContact: string,
): string {
  return `${market}/${section}/${symbol}/${secContact ? 'c' : '-'}`;
}

function readFresh(key: string, section: ResearchSection, now: number): ResearchResult<unknown> | null {
  const entry = cache.get(key);
  if (!entry || now - entry.at >= RESEARCH_KEEP_MS[section]) return null;
  return entry.result;
}

function errorCodeOf(error: unknown): string {
  return error instanceof ResearchFetchError ? error.code : 'failed';
}

/** The last trigger for the effect: a user refresh, a background poll, or none. */
type Trigger = 'manual' | 'poll' | null;

interface View {
  key: string;
  phase: 'loading' | 'ready' | 'error';
  result: ResearchResult<unknown> | null;
  errorCode: string | null;
}

export function useResearchSection<S extends ResearchSection>(
  market: MarketFor<S>,
  section: S,
  symbol: string,
  { enabled, secContact }: UseResearchSectionOptions,
): ResearchSectionState<S> {
  const key = researchCacheKey(market, section, symbol, secContact);
  const [view, setView] = useState<View>({ key: '', phase: 'loading', result: null, errorCode: null });
  const [round, setRound] = useState(0);
  const triggerRef = useRef<Trigger>(null);

  useEffect(() => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (!enabled) return undefined;

    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    // A partly read House trades answer is asked again every 30 s, whether it came
    // from the cache or from the network.
    const armPoll = (result: ResearchResult<unknown>): void => {
      const delay = section === 'house-trades' ? pollDelayMs(result) : null;
      if (delay === null) return;
      pollTimer = setTimeout(() => {
        triggerRef.current = 'poll';
        setRound((n) => n + 1);
      }, delay);
    };

    // A refresh or a house-trades poll asks the server again, past the cache.
    const fresh = trigger !== null ? null : readFresh(key, section, Date.now());
    if (fresh) {
      setView({ key, phase: 'ready', result: fresh, errorCode: null });
      armPoll(fresh);
      return () => {
        if (pollTimer !== undefined) clearTimeout(pollTimer);
      };
    }
    if (trigger === 'manual') {
      setView((prev) => (prev.key === key ? { ...prev, phase: 'loading', errorCode: null } : prev));
    }

    const controller = new AbortController();

    fetchResearch(market, section, symbol, { signal: controller.signal, secContact })
      .then((result) => {
        if (controller.signal.aborted) return;
        const answer = result as ResearchResult<unknown>;
        if (result.status !== 'unavailable') cacheStore(key, answer, Date.now());
        setView({ key, phase: 'ready', result: answer, errorCode: null });
        armPoll(answer);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setView((prev) => ({
          key,
          phase: 'error',
          result: prev.key === key ? prev.result : null,
          errorCode: errorCodeOf(error),
        }));
      });

    return () => {
      controller.abort();
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
  }, [enabled, key, market, section, symbol, secContact, round]);

  const refresh = useCallback(() => {
    triggerRef.current = 'manual';
    setRound((n) => n + 1);
  }, []);

  if (!enabled) {
    return { state: 'idle', result: viewResult<S>(view, key), errorCode: null, refresh };
  }
  if (view.key === key) {
    return {
      state: view.phase,
      result: viewResult<S>(view, key),
      errorCode: view.errorCode,
      refresh,
    };
  }
  const cached = readFresh(key, section, Date.now());
  if (cached) {
    return { state: 'ready', result: cached as ResearchResult<SectionDataMap[S]>, errorCode: null, refresh };
  }
  return { state: 'loading', result: null, errorCode: null, refresh };
}

function viewResult<S extends ResearchSection>(view: View, key: string): ResearchResult<SectionDataMap[S]> | null {
  return view.key === key ? (view.result as ResearchResult<SectionDataMap[S]> | null) : null;
}

/** True while the House reports are only partly read. */
function housePending(data: HouseTradesData | null): boolean {
  const { parsed, total } = data?.coverage ?? { parsed: null, total: null };
  return parsed !== null && total !== null && parsed < total;
}

/**
 * When a House trades answer is read again by itself: 15 s while the House index
 * is still loading, 30 s while the reports are partly read. Null for any other
 * answer. Other unavailable reasons are not retried by themselves: the reader uses
 * Try again for those.
 */
export function pollDelayMs(result: ResearchResult<unknown>): number | null {
  if (result.status === 'unavailable' && result.reason === 'index_loading') return INDEX_RETRY_MS;
  return housePending(result.data as HouseTradesData | null) ? HOUSE_POLL_MS : null;
}
