/**
 * Pure rules for the market map: which periods each market offers, how a percent
 * change becomes a stepped tone, how tiles are grouped for the layout, and which
 * text fits a tile. No DOM and no React, so each rule is unit-tested on its own.
 */

import { formatFixed } from '../../i18n/format';
import type { MapItem, MapMarket } from './marketMapApi';
import type { Rect, TreemapGroup, TreemapItem } from './treemap';

/** Periods each market offers, in the order the period switch shows them. */
export const PERIODS: Record<MapMarket, readonly string[]> = {
  us: ['1d'],
  crypto: ['1h', '24h', '7d'],
};

/** The period a market opens on. */
export const DEFAULT_PERIOD: Record<MapMarket, string> = {
  us: '1d',
  crypto: '24h',
};

/** The change, in percent, that reads as the full colour for each period. */
export const CLAMP_PERCENT: Record<string, number> = {
  '1d': 3,
  '1h': 2,
  '24h': 10,
  '7d': 20,
};

export type TileSide = 'up' | 'down' | 'flat' | 'unknown';

export interface TileTone {
  side: TileSide;
  /** 0 for flat or unknown, otherwise one of 0.2, 0.4, 0.6, 0.8, 1. */
  strength: number;
}

/** Changes smaller than this (as a level) read as flat. */
const FLAT_LEVEL = 0.02;
/** Number of colour steps on each side of zero. */
const STEPS = 5;

/**
 * The change as a level from -1 to 1: the percent divided by the period's clamp.
 * Null when the change is unknown or the period has no clamp.
 */
export function changeLevel(percent: number | undefined, period: string): number | null {
  const clamp = CLAMP_PERCENT[period];
  if (percent === undefined || !Number.isFinite(percent) || clamp === undefined) return null;
  return Math.min(1, Math.max(-1, percent / clamp));
}

/**
 * The colour of a tile for a level. The strength rounds the magnitude UP to a
 * step, so any move past the threshold shows at least the first step.
 */
export function tileTone(level: number | null): TileTone {
  if (level === null) return { side: 'unknown', strength: 0 };
  const magnitude = Math.abs(level);
  if (magnitude < FLAT_LEVEL) return { side: 'flat', strength: 0 };
  // A small tolerance keeps a value such as 0.6 * 5 from rounding up one step too far.
  const step = Math.min(STEPS, Math.ceil(magnitude * STEPS - 1e-9));
  return { side: level > 0 ? 'up' : 'down', strength: step / STEPS };
}

/** One treemap group per sector; each item is a tile sized by its market value. */
export function toGroups(items: readonly MapItem[]): TreemapGroup[] {
  const byGroup = new Map<string, { id: string; items: TreemapItem[] }>();
  for (const item of items) {
    let group = byGroup.get(item.group);
    if (group === undefined) {
      group = { id: item.group, items: [] };
      byGroup.set(item.group, group);
    }
    group.items.push({ id: item.symbol, value: item.marketCap });
  }
  return [...byGroup.values()];
}

/** Which text a tile can hold at its size: nothing, the symbol, or the symbol and change. */
export function labelFor(rect: Rect): 'none' | 'symbol' | 'symbol+change' {
  if (rect.w < 28 || rect.h < 14) return 'none';
  if (rect.w < 44 || rect.h < 30) return 'symbol';
  return 'symbol+change';
}

/** A percent change with a sign, one decimal and a real minus sign: `+1.2%`, `−3.4%`. */
export function formatChange(percent: number): string {
  const magnitude = formatFixed(Math.abs(percent), 1);
  if (percent < 0 && Number(magnitude.replace(',', '.')) !== 0) return `\u2212${magnitude}%`;
  if (percent > 0) return `+${magnitude}%`;
  return `${magnitude}%`;
}

const COMPACT_TIERS: readonly (readonly [number, string])[] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * A large quantity in a short form, e.g. `3.9T` for a market value or `9.4M` for a
 * volume. The rounding happens first, so 999.96B reads as 1T and not as 1000B.
 */
export function formatCompact(value: number): string {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '\u2212' : '';
  if (magnitude < 1e3) return `${sign}${formatFixed(magnitude, 0)}`;
  let index = COMPACT_TIERS.findIndex(([div]) => magnitude >= div);
  if (index > 0 && Number((magnitude / COMPACT_TIERS[index][0]).toFixed(1)) >= 1000) index -= 1;
  const [div, suffix] = COMPACT_TIERS[index];
  const text = formatFixed(magnitude / div, 1).replace(/[.,]0$/, '');
  return `${sign}${text}${suffix}`;
}
