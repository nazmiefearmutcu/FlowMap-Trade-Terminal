/**
 * FlowMap shell i18n.
 *
 * Tiny dependency-free lookup: `t('key', vars)` resolves the active locale's
 * table, falls back to the ENGLISH string (a missing TR entry must never
 * render raw key garbage), and falls back to the key itself only when the
 * key is unknown to every table. `{name}` placeholders interpolate from
 * `vars`; unknown placeholders pass through untouched.
 *
 * Locale is persisted in localStorage `flowmap.locale` ('en' | 'tr').
 * `useT()` (useT.ts) is the React binding that re-renders on change.
 *
 * Scope: every user-facing client string — shell chrome, banners, the chart
 * overlays' labels, the tape, watchlist, drawings, measure tool and keyboard
 * reference. Data identifiers (market ids, symbols, theme ids) are never
 * translated. Components call `t()` (or `useT()` to re-render on a locale
 * change); see MIGRATION.md for any surface still to be migrated.
 */

import { en } from './en';
import { tr } from './tr';

export type Locale = 'en' | 'tr';

export const LOCALES: readonly Locale[] = ['en', 'tr'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'flowmap.locale';

/** Locale name as it should appear in a picker row. */
export function localeLabel(l: Locale): string {
  return l === 'tr' ? 'Türkçe' : 'English';
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'tr';
}

const TABLES: Record<Locale, Record<string, string>> = { en, tr };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

/**
 * Keep `<html lang>` in step with the UI locale: screen readers pick
 * their pronunciation rules from it, and CSS `text-transform: uppercase` maps
 * Turkish `i` to `İ` only under `lang="tr"`. Guarded for non-DOM test runs.
 */
function syncDocumentLang(locale: Locale): void {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = locale;
    }
  } catch {
    /* no DOM (or a sandboxed document) — the locale still applies */
  }
}

/**
 * Placeholders whose value is computed from other data (for example the theme
 * names listed by the keyboard reference), resolved per locale when a call does
 * not pass them explicitly. Registered by the module that owns the data.
 */
const DYNAMIC_VARS = new Map<string, (locale: Locale) => string>();

/**
 * Register a computed `{name}` placeholder. An explicit `vars` entry always
 * wins; the resolver runs only for placeholders the call did not supply.
 */
export function registerTextVar(name: string, resolve: (locale: Locale) => string): void {
  DYNAMIC_VARS.set(name, resolve);
}

/**
 * Singular variant of a count key. A `<key>.one` entry is used when the call's
 * `count` is exactly 1 and its `total`, if the call passes one, is 0 or 1 (a set
 * of at most one item). So "1 symbol" and "1 of 1 venue" read correctly while
 * "1 of 3 venues" keeps the plural. Values are compared as printed, so a locale's
 * grouping ("1.000") never reads as 1. A locale without a `.one` entry uses the key.
 */
function countVariant(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  if (vars === undefined || vars.count === undefined || String(vars.count) !== '1') return key;
  if (vars.total !== undefined && String(vars.total) !== '0' && String(vars.total) !== '1') return key;
  const one = `${key}.one`;
  return TABLES[locale][one] !== undefined || TABLES.en[one] !== undefined ? one : key;
}

/** Look a key up for a specific locale with EN fallback, then key. */
export function tFor(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const resolved = countVariant(locale, key, vars);
  const raw = TABLES[locale][resolved] ?? TABLES.en[resolved];
  const text = raw ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (vars !== undefined && Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    const resolve = DYNAMIC_VARS.get(name);
    return resolve ? resolve(locale) : match;
  });
}

/** Translate into the CURRENT locale (re-read after every setLocale). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return tFor(current, key, vars);
}

export function getLocale(): Locale {
  return current;
}

/** Switch locale, persist, and notify subscribers. */
export function setLocale(locale: Locale): void {
  const next = isLocale(locale) ? locale : DEFAULT_LOCALE;
  if (next !== current) {
    current = next;
    syncDocumentLang(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* quota / private mode — locale stays session-local */
    }
    notify();
  }
}

/**
 * Boot call: restore the persisted locale. Safe to call repeatedly.
 * (No navigator sniffing: the app starts in English until the user picks a
 * language in Settings, which calls setLocale.)
 */
export function initLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) {
      current = stored;
      notify();
    }
  } catch {
    /* storage unavailable — keep default */
  }
  syncDocumentLang(current);
  return current;
}

/** Subscribe to locale changes; returns an unsubscriber. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
