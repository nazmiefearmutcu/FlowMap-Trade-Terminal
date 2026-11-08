/**
 * Pure helpers shared by the symbol palette and its parts: the venue and group
 * labels, the result-row shape, the preview payload guard, the network fetch
 * wrapper and the keyboard chord hint.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { sidecarFetch } from '../net/serverBase';
import { safeLocalStorage } from '../state/safeStorage';
import type { PreviewQuote } from './previewQuotes';
import { ALL_VENUES, type SymbolEntry, type Translate } from './symbols';

/** Translation keys for the venue group chips (crypto / equity / sim / all). */
const GROUP_KEY: Record<string, string> = {
  crypto: 'search.group.crypto',
  equity: 'search.group.equity',
  sim: 'search.group.sim',
  all: 'search.group.all',
};

/** A venue group's chip text in the UI locale; an unknown group id shows as-is. */
export function groupText(t: (key: string) => string, group: string): string {
  const key = GROUP_KEY[group];
  return key === undefined ? group : t(key);
}

/** The "all venues" scope is the one venue whose label is not a market id. */
export function venueText(t: (key: string) => string, venue: { market: string; label: string }): string {
  return venue.market === ALL_VENUES ? t('search.allMarkets') : venue.label;
}

/** Visible chip text for the English tokens that have a Turkish reading. */
const CHIP_LABEL_KEY: Record<string, string> = {
  'RECORDED DENSITY': 'chip.recordedDensity',
  'SIDE INFERRED': 'chip.sideInferred',
  'SIDE NA': 'chip.sideNone',
  'TAPE POLL': 'chip.tapePoll',
  'N/A': 'chip.none',
  UNKNOWN: 'chip.unknown',
};

/**
 * The text a capability chip shows. The English token is the chip's React key and
 * its CSS class; only the visible words are translated, so a Turkish session does
 * not read "RECORDED DENSITY" or "SIDE INFERRED" in English. Tokens without a
 * translation (L2, L1, SYNTH, SIM, ...) show as they are.
 */
export function capabilityChipLabel(chip: string, t: Translate): string {
  const key = CHIP_LABEL_KEY[chip];
  return key === undefined ? chip : t(key);
}

/** Live venue enumeration is uncapped-ish; the server clamps `limit` at 1000. */
export const VENUE_LIMIT = 1000;

/**
 * How long an EMPTY venue listing is trusted. A 200 with no rows is usually a
 * real empty venue, but the server also degrades an unreachable venue to an
 * empty body, so an empty answer is remembered only briefly. A non-empty listing
 * is kept for the session.
 */
export const EMPTY_LISTING_TTL_MS = 30_000;

/** A single search result: a directory entry, optionally enriched with a quote. */
export interface Row {
  entry: SymbolEntry;
  quote?: PreviewQuote;
}

/** How far the server's preview warm-up has progressed. */
export interface PreviewWarmup {
  total: number;
  completed: number;
  ready: number;
  warming: boolean;
}

/** One poll answer from `/api/previews`: the warm-up counters plus new quotes. */
export interface PreviewSnapshot extends PreviewWarmup {
  quotes: PreviewQuote[];
  revision: number;
  generation: string;
}

/** Shape guard for an untrusted `/api/previews` body. */
export function validPreviewSnapshot(value: PreviewSnapshot | null): value is PreviewSnapshot {
  return value !== null && Array.isArray(value.quotes)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 64
    && typeof value.warming === 'boolean'
    && Number.isInteger(value.total) && value.total >= 0 && value.total <= 512
    && Number.isInteger(value.completed) && value.completed >= 0 && value.completed <= value.total
    && Number.isInteger(value.ready) && value.ready >= 0 && value.ready <= value.total;
}

/**
 * Where the current scope's symbol list stands. `idle` = the bundled `all` scope.
 *
 * `empty` and `failed` are DIFFERENT facts and must never collapse into one:
 * `empty` is a 200 that listed no symbols (a reachable venue with nothing to
 * offer), `failed` is a request that never produced an answer at all.
 */
export type ScopeState = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/** GET a palette endpoint. Null on any non-2xx, network error or abort. */
export async function getJson<T>(path: string, signal: AbortSignal): Promise<T | null> {
  try {
    // Through sidecarFetch so the packaged app's session token rides on every palette call.
    const r = await sidecarFetch(path, { signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.warn('[flowmap] palette fetch failed', path, err);
    }
    return null;
  }
}

/** The browser localStorage for the preview cache, or null when it is unreadable. */
export function previewStorage(): Storage | null {
  return safeLocalStorage();
}

/**
 * The palette chord as this keyboard spells it: ⌘K on Apple platforms, Ctrl K
 * elsewhere. The keys themselves accept both (input/keys.ts).
 */
export function searchChord(): string {
  const hint = typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(hint) ? '⌘K' : 'Ctrl K';
}

/**
 * Keeps Tab and Shift+Tab inside the palette (the same contract as the settings
 * drawer and the shortcuts overlay). Without it, Tab past the last focusable
 * lands on the page behind the modal backdrop and focus is lost out of the dialog.
 */
export function trapFocusKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Tab') return;
  const panel = e.currentTarget;
  const focusable = panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !panel.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    e.preventDefault();
    first.focus();
  }
}
