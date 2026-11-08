/**
 * i18n integrity gates: a Turkish string must use the same
 * {placeholders} as its English source, and every `t('key')` literal in the
 * shell source must exist in the English table. Without these, a dropped
 * {count} renders wrong in Turkish and a typo'd key shows as raw identifier
 * text (the raw-key fallback hides it).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHART_STYLES } from '../gl/heatmap';
import { COLORMAP_CATALOG } from '../theme/colormaps';
import { THEME_IDS } from '../theme';
import { FEED_KEY } from '../ui/MarketStrip';
import { STATUS_KEY } from '../ui/TopBar';
import {
  DEPTH_CHANNEL_HINT_KEY,
  DEPTH_CHANNEL_LABEL_KEY,
  DEPTH_CHANNELS,
  HISTORY_DEPTH_LABEL_KEY,
  HISTORY_DEPTHS,
  PRICE_BAND_HINT_KEY,
  PRICE_BAND_LABEL_KEY,
  PRICE_BANDS,
} from '../ui/settings';
import { en } from './en';
import { TIME_ZONE_PREFS } from './format';
import { tr } from './tr';

const SRC_ROOT = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    // The tables themselves are the source of keys, not consumers of them.
    if (dir === join(SRC_ROOT, 'i18n') && /^(en|tr)\.ts$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

function placeholders(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

describe('translation tables keep their placeholders', () => {
  it('every Turkish string uses the same {name} placeholders as English', () => {
    const mismatched = Object.keys(tr)
      .filter((key) => en[key] !== undefined && placeholders(tr[key]) !== placeholders(en[key]))
      .map((key) => `${key}: en={${placeholders(en[key])}} tr={${placeholders(tr[key])}}`);
    expect(mismatched).toEqual([]);
  });
});

describe('every t() literal in the shell resolves to an English key', () => {
  it('finds no call site whose key is missing from en.ts', () => {
    const missing = new Set<string>();
    const literal = /\bt\(\s*['"]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"]/g;
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(literal)) {
        if (en[match[1]] === undefined) missing.add(`${file.slice(SRC_ROOT.length)}: ${match[1]}`);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});

describe('keys built at run time resolve in English', () => {
  // The literal scan above cannot see a key built from a variable, so these lists stand in for it.
  // OverlayToggles and DeskToolbar keep these lists private, so they are mirrored here.
  // The settings drawer's label maps are exported from ui/settings.ts and read directly.
  const OVERLAY_KEYS = ['price', 'bubbles', 'volume', 'bbo', 'vwap', 'cvd', 'profile', 'gex', 'markers', 'axes'];
  const DESK_LAYOUTS = ['orderflow', 'analysis', 'focus'];
  const dynamicKeys = [
    ...THEME_IDS.flatMap((id) => [`theme.${id}.name`, `theme.${id}.hint`]),
    ...TIME_ZONE_PREFS.map((pref) => `settings.tz.${pref}`),
    ...CHART_STYLES.map((style) => `settings.chartStyle.${style}`),
    ...COLORMAP_CATALOG.map((colormap) => `palette.${colormap.hint}`),
    ...COLORMAP_CATALOG.flatMap((colormap) => (colormap.nameKey ? [colormap.nameKey] : [])),
    // Trade side labels are chosen by a ternary in IntelligenceDrawerPanes.tsx, which the literal scan cannot see.
    'intel.trade.purchase',
    'intel.trade.sale',
    ...Object.values(STATUS_KEY),
    ...Object.values(FEED_KEY),
    ...OVERLAY_KEYS.flatMap((key) => [`overlay.${key}.label`, `overlay.${key}.hint`]),
    ...DESK_LAYOUTS.map((layout) => `desk.${layout}`),
    ...DEPTH_CHANNELS.map((channel) => `desk.channel.${channel}`),
    ...PRICE_BANDS.flatMap((band) => [PRICE_BAND_LABEL_KEY[band], PRICE_BAND_HINT_KEY[band]]),
    ...DEPTH_CHANNELS.flatMap((channel) => [DEPTH_CHANNEL_LABEL_KEY[channel], DEPTH_CHANNEL_HINT_KEY[channel]]),
    ...HISTORY_DEPTHS.map((depth) => HISTORY_DEPTH_LABEL_KEY[depth]),
  ];

  it('finds every built key in the English table', () => {
    expect(dynamicKeys.filter((key) => en[key] === undefined)).toEqual([]);
  });
});
