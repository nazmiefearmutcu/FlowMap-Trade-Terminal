/**
 * Shared polling feed for display-only `/api/quote` snapshots, consumed by the
 * watchlist and the alert monitor.
 *
 * The server exposes `GET /api/quote?market=..&symbol=..` returning
 * `{price, changePct, spark, stale, reachable}` behind a 15 s TTL cache with
 * per-key single-flight (api/market_cache.py). This module is the client half:
 *
 *   - `subscribeQuotes(keys, cb, opts?) => unsubscribe` with `market:symbol`
 *     keys (the same key format the alerts store persists).
 *   - 10 s default cadence, visibility-gated: while `document.hidden` or the
 *     page is otherwise hidden polling PAUSES, and on visible it resumes with an
 *     immediate refresh (never a stale slot until the next tick).
 *   - SINGLE in-flight fetch per key across all subscribers; one response fans
 *     out to every subscriber of that key, so two panels polling the same
 *     symbol cost one request per cycle.
 *   - Duplicate keys in one call collapse; malformed keys are skipped.
 *   - AbortController per fetch, aborted after {@link QUOTE_TIMEOUT_MS} so one
 *     hung request cannot silence its key; unsubscribing the LAST subscriber for
 *     a key aborts its in-flight request.
 *   - Egress: each poll is answered by the sidecar from its own upstream (venue
 *     klines for crypto, the Yahoo chart API for equities). It needs no stream
 *     subscription, so watchlist rows and alert symbols reach those hosts whenever
 *     the app runs.
 *   - Honest passthrough: a successful response reaches the callback as the
 *     server sent it, unmodified. A failed request (non-2xx, network error,
 *     timeout, unparsable body) is reported as an UNREACHABLE quote: the last
 *     good quote for the key relabelled `stale: true, reachable: false`, or an
 *     empty `price: null` quote when none was ever received. It never invents a
 *     price, and consumers that skip `reachable === false` (the alert monitor)
 *     never fire on it. The next cycle retries.
 *
 * React-free by design (the alertsStore/bookStore pattern) so it is unit
 * testable with fake timers and an injected visibility source.
 */

import { apiBase, withSessionHeader } from '../net/serverBase';

/** The `/api/quote` response subset consumers see (camelCase, server-verbatim). */
export interface Quote {
  market: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  spark: number[];
  /** Wall-clock UTC ns of the freshest datum (optional for hand-rolled doubles). */
  asOf?: number;
  /** True for market-closed / last-good-on-error data. */
  stale?: boolean;
  /** False when the provider could not be reached at all. */
  reachable?: boolean;
}

/** Injectable page-visibility source; the default reads `document`. */
export interface VisibilitySource {
  isHidden(): boolean;
  /** Register a change listener; returns the deregister fn. */
  onChange(cb: () => void): () => void;
}

export interface QuoteFeedOptions {
  /** Poll cadence in ms (default {@link DEFAULT_QUOTE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Test seam: visibility source (default: `document.hidden`). */
  visibility?: VisibilitySource;
  /** Test seam: fetch implementation (default: the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Default poll cadence — comfortably inside the server's 15 s quote TTL. */
export const DEFAULT_QUOTE_INTERVAL_MS = 10_000;
/** Per-request ceiling, kept below the poll cadence so a hung request ends before the next cycle. */
export const QUOTE_TIMEOUT_MS = 8_000;

interface ParsedKey {
  market: string;
  symbol: string;
}

interface Group {
  keys: Map<string, ParsedKey>;
  cb: (key: string, quote: Quote) => void;
  intervalMs: number;
  vis: VisibilitySource;
  fetchImpl: typeof fetch;
  timer: ReturnType<typeof setInterval> | null;
  visOff: () => void;
}

const groups = new Set<Group>();
/** Per-key subscriber count (across groups), for abort-on-last-unsubscribe. */
const keyRefs = new Map<string, number>();
/** At most one in-flight request per key at any moment. */
const inflight = new Map<string, AbortController>();
/** Last successful quote per key — the base of an unreachable (stale) report. */
const lastGood = new Map<string, Quote>();

function documentVisibility(): VisibilitySource {
  return {
    isHidden: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onChange: (cb) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
  };
}

function boundFetch(): typeof fetch {
  return (input, init) => globalThis.fetch(input, withSessionHeader(init));
}

/**
 * The quote reported when a request fails: the last good value, labelled stale
 * and unreachable (so a watchlist can keep the number and say it is not live),
 * or an empty unreachable quote when this key never produced one.
 */
function unreachableQuote(key: string, parsed: ParsedKey): Quote {
  const base = lastGood.get(key);
  if (base !== undefined) return { ...base, stale: true, reachable: false };
  return {
    market: parsed.market,
    symbol: parsed.symbol,
    price: null,
    changePct: null,
    spark: [],
    stale: true,
    reachable: false,
  };
}

/** Parse a `market:symbol` key; null for malformed keys (skipped honestly). */
function parseKey(key: string): ParsedKey | null {
  const i = key.indexOf(':');
  if (i <= 0 || i >= key.length - 1) return null;
  return { market: key.slice(0, i), symbol: key.slice(i + 1) };
}

function stopTimer(g: Group): void {
  if (g.timer === null) return;
  clearInterval(g.timer);
  g.timer = null;
}

function startTimer(g: Group): void {
  if (g.timer !== null || g.vis.isHidden()) return;
  g.timer = setInterval(() => pollGroup(g), g.intervalMs);
}

/** One poll cycle for a group: start one request per key (single-flight). */
function pollGroup(g: Group): void {
  if (g.vis.isHidden()) return;
  for (const [key, parsed] of g.keys) {
    if (inflight.has(key)) continue; // a shared request is already on the wire
    const ctrl = new AbortController();
    inflight.set(key, ctrl);
    void fetchQuote(g, key, parsed, ctrl);
  }
}

/**
 * Settle with `p`, or reject as soon as `signal` aborts. A real fetch already
 * rejects on abort; this also covers an injected fetch that ignores the signal,
 * so a hung request can never hold its key's single-flight slot forever.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('flowmap: quote request aborted'));
      return;
    }
    const onAbort = (): void => reject(new Error('flowmap: quote request aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Fan one quote out to every visible subscriber of `key`. */
function fanOut(key: string, quote: Quote): void {
  for (const other of groups) {
    if (!other.keys.has(key) || other.vis.isHidden()) continue;
    try {
      other.cb(key, quote);
    } catch (err) {
      // One misbehaving consumer must not break the others, but its failure is
      // still a bug to see in the console, not a silent drop.
      console.error('[flowmap] quote consumer failed', err);
    }
  }
}

async function fetchQuote(
  g: Group,
  key: string,
  parsed: ParsedKey,
  ctrl: AbortController,
): Promise<void> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, QUOTE_TIMEOUT_MS);
  try {
    const path = `/api/quote?market=${encodeURIComponent(parsed.market)}&symbol=${encodeURIComponent(parsed.symbol)}`;
    const r = await untilAborted(
      g.fetchImpl(`${apiBase()}${path}`, { signal: ctrl.signal }),
      ctrl.signal,
    );
    if (!r.ok) {
      fanOut(key, unreachableQuote(key, parsed));
      return;
    }
    const quote = await untilAborted(r.json() as Promise<Quote>, ctrl.signal);
    if (ctrl.signal.aborted) return;
    lastGood.set(key, quote);
    fanOut(key, quote);
  } catch {
    // A deliberate abort (last unsubscribe / reset) reports nothing: nobody is
    // listening. A timeout, a network error or an unparsable body is a real
    // failure the consumers must see.
    if (ctrl.signal.aborted && !timedOut) return;
    fanOut(key, unreachableQuote(key, parsed));
  } finally {
    clearTimeout(timer);
    if (inflight.get(key) === ctrl) inflight.delete(key);
  }
}

/**
 * Subscribe to live quotes for `keys` (`market:symbol` strings). `cb` is called
 * with the key and the server's verbatim quote, once per successful fetch —
 * immediately on subscribe while visible, then at the cadence. Returns the
 * unsubscribe fn (clears timers, deregisters visibility, aborts the key's
 * in-flight request when this was the last subscriber).
 */
export function subscribeQuotes(
  keys: readonly string[],
  cb: (key: string, quote: Quote) => void,
  opts: QuoteFeedOptions = {},
): () => void {
  const parsed = new Map<string, ParsedKey>();
  for (const key of keys) {
    if (parsed.has(key)) continue; // dedupe duplicate keys in one call
    const p = parseKey(key);
    if (p !== null) parsed.set(key, p);
  }
  const requested = opts.intervalMs;
  const intervalMs =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_QUOTE_INTERVAL_MS;
  const group: Group = {
    keys: parsed,
    cb,
    intervalMs,
    vis: opts.visibility ?? documentVisibility(),
    fetchImpl: opts.fetchImpl ?? boundFetch(),
    timer: null,
    visOff: () => {},
  };
  groups.add(group);
  for (const key of group.keys.keys()) keyRefs.set(key, (keyRefs.get(key) ?? 0) + 1);
  group.visOff = group.vis.onChange(() => {
    if (group.vis.isHidden()) {
      stopTimer(group);
    } else {
      startTimer(group);
      pollGroup(group); // immediate refresh on becoming visible
    }
  });
  // Immediate first refresh while visible (no 10 s blank row on mount).
  if (!group.vis.isHidden()) {
    startTimer(group);
    pollGroup(group);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    groups.delete(group);
    stopTimer(group);
    group.visOff();
    for (const key of group.keys.keys()) {
      const refs = (keyRefs.get(key) ?? 1) - 1;
      if (refs > 0) {
        keyRefs.set(key, refs);
        continue;
      }
      keyRefs.delete(key);
      inflight.get(key)?.abort();
      inflight.delete(key);
      lastGood.delete(key);
    }
  };
}

/** Test seam: unregister every group, timer, and in-flight request. */
export function resetQuoteFeedForTest(): void {
  for (const g of groups) {
    stopTimer(g);
    g.visOff();
  }
  groups.clear();
  keyRefs.clear();
  for (const ctrl of inflight.values()) ctrl.abort();
  inflight.clear();
  lastGood.clear();
}
