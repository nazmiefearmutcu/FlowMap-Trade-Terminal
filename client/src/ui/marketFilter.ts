/**
 * Which markets the user has switched off (Settings → Markets).
 *
 * A switched-off market is left out of the symbol palette (its venue row, its
 * directory rows and its recent picks) and of the market map, so the app asks for
 * none of its data. The chart already open on such a market stays open: switching
 * a market off never takes the screen away from the user.
 *
 * The stored list holds market strings (`world-xist`, `binance-usdm`) and whole
 * groups (`group:world`). A group entry also covers the markets of that group a
 * later version adds, which a list of today's markets could not.
 */

import { useSyncExternalStore } from 'react';

/** The groups the Settings list shows, in order. */
export const MARKET_GROUPS = ['crypto', 'us', 'world', 'futures', 'forex', 'indices', 'bonds', 'sim'] as const;
export type MarketGroup = (typeof MARKET_GROUPS)[number];

const GROUP_PREFIX = 'group:';
/** Longest stored list; a list past it is cut (every real market fits many times over). */
const HIDDEN_MAX = 4000;
/** A market string as the wire spells it, or a group entry. */
const ENTRY_SHAPE = /^(group:[a-z]+|[a-z0-9][a-z0-9_.-]{0,63})$/;

/** The group a market string belongs to. */
export function marketGroupOf(market: string): MarketGroup {
  const m = market.toLowerCase();
  if (m === 'sim') return 'sim';
  if (m === 'equity' || m === 'stock' || m === 'us-equity') return 'us';
  if (m.startsWith('world-')) return 'world';
  if (m.startsWith('futures-') || m === 'futures') return 'futures';
  if (m === 'forex' || m === 'indices' || m === 'bonds') return m;
  return 'crypto';
}

export function groupEntry(group: MarketGroup): string {
  return `${GROUP_PREFIX}${group}`;
}

/** The stored list, cleaned: lowercase, known shapes only, no duplicates, bounded. */
export function normalizeHiddenMarkets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const entry = item.trim().toLowerCase();
    if (!ENTRY_SHAPE.test(entry)) continue;
    if (entry.startsWith(GROUP_PREFIX) && !(MARKET_GROUPS as readonly string[]).includes(entry.slice(GROUP_PREFIX.length))) {
      continue;
    }
    out.add(entry);
    if (out.size >= HIDDEN_MAX) break;
  }
  return [...out];
}

/** A fast membership test over a stored list. */
export interface MarketFilter {
  isVisible(market: string): boolean;
  isGroupHidden(group: MarketGroup): boolean;
}

export function marketFilter(hidden: readonly string[]): MarketFilter {
  const set = new Set(hidden);
  return {
    isVisible(market: string): boolean {
      const m = market.toLowerCase();
      if (set.size === 0 || m === 'all') return true;
      return !set.has(m) && !set.has(groupEntry(marketGroupOf(m)));
    },
    isGroupHidden(group: MarketGroup): boolean {
      return set.has(groupEntry(group));
    },
  };
}

/** Switch one market on or off. Turning on a market of a hidden group turns the group on
 * with every other market of it (`others`) left off, so only the one market appears. */
export function setMarketVisible(
  hidden: readonly string[],
  market: string,
  visible: boolean,
  others: readonly string[] = [],
): string[] {
  const m = market.toLowerCase();
  const group = groupEntry(marketGroupOf(m));
  const next = new Set(hidden);
  if (visible) {
    next.delete(m);
    if (next.has(group)) {
      next.delete(group);
      for (const other of others) {
        const o = other.toLowerCase();
        if (o !== m) next.add(o);
      }
    }
  } else if (!next.has(group)) {
    next.add(m);
  }
  return normalizeHiddenMarkets([...next]);
}

/** Switch a whole group on or off. Either way the group's single entries are dropped:
 * on shows every market of it, off is said once by the group entry. */
export function setGroupVisible(hidden: readonly string[], group: MarketGroup, visible: boolean): string[] {
  const kept = hidden.filter((entry) => entry !== groupEntry(group) && (entry.startsWith(GROUP_PREFIX) || marketGroupOf(entry) !== group));
  return visible ? kept : normalizeHiddenMarkets([...kept, groupEntry(group)]);
}

/** How much of a group is on: every market, some, or none. */
export function groupState(filter: MarketFilter, group: MarketGroup, markets: readonly string[]): 'all' | 'some' | 'none' {
  if (filter.isGroupHidden(group)) return 'none';
  const on = markets.filter((market) => filter.isVisible(market)).length;
  if (markets.length === 0 || on === markets.length) return 'all';
  return on === 0 ? 'none' : 'some';
}

// The current list, shared by the palette and the market map. App writes it from the
// settings; components read it with `useMarketFilter`.
let current: readonly string[] = [];
let currentFilter = marketFilter(current);
const listeners = new Set<() => void>();

export function setHiddenMarkets(hidden: readonly string[]): void {
  if (hidden.length === current.length && hidden.every((entry, i) => entry === current[i])) return;
  current = [...hidden];
  currentFilter = marketFilter(current);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): MarketFilter {
  return currentFilter;
}

/** The filter for the markets switched off now; re-renders when the list changes. */
export function useMarketFilter(): MarketFilter {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
