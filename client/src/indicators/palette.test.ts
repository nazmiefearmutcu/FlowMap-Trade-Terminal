/**
 * Series palette contract: every indicator colour token clears WCAG 1.4.11 (3:1)
 * against every theme's chart ground and sub-pane chip. themes.css is parsed, so
 * a theme that drops a series token, or a new theme that forgets one, fails here
 * rather than in a screenshot review.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FALLBACK_COLORS } from '../ui/IndicatorOverlayCanvas';
import { toHex6 } from './palette';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const themesCss = stripComments(readFileSync(resolve(here, '../theme/themes.css'), 'utf8'));

type Rgb = [number, number, number];

/** Every `selector { declarations }` rule: the selector text and its --token declarations. */
function rules(css: string): { selector: string; tokens: Record<string, string> }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const tokens: Record<string, string> = {};
    for (const decl of m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[decl[1]] = decl[2].trim();
    return { selector: m[1].trim(), tokens };
  });
}

const THEME_NAMES = [...themesCss.matchAll(/:root\[data-theme='([a-z-]+)'\]\s*\{/g)].map((m) => m[1]);

/** The --indi-* tokens each theme block of themes.css declares (no inheritance between themes). */
function seriesTokensByTheme(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const rule of rules(themesCss)) {
    const m = /data-theme='([a-z-]+)'/.exec(rule.selector);
    if (m === null) continue;
    out[m[1]] = Object.fromEntries(Object.entries(rule.tokens).filter(([k]) => k.startsWith('indi-')));
  }
  return out;
}

/** A theme's chart tokens (ground and sub-pane chip) from themes.css. */
function chartGrounds(): Record<string, { bg: string; chip: string }> {
  const out: Record<string, { bg: string; chip: string }> = {};
  for (const rule of rules(themesCss)) {
    const m = /data-theme='([a-z-]+)'/.exec(rule.selector);
    if (m === null) continue;
    out[m[1]] = { bg: rule.tokens['chart-bg'], chip: rule.tokens['chart-chip-bg'] };
  }
  return out;
}

function hexToRgb(hex: string): Rgb {
  const h = toHex6(hex);
  if (h === null) throw new Error(`not a hex colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SERIES = ['--indi-c1', '--indi-c2', '--indi-c3', '--indi-c4', '--indi-c5', '--indi-c6'] as const;

describe('indicator series palette — contrast per theme', () => {
  const tokens = seriesTokensByTheme();
  const grounds = chartGrounds();

  it('finds every theme block and all six series tokens for it', () => {
    expect(THEME_NAMES.length).toBeGreaterThanOrEqual(7);
    for (const name of SERIES) expect(FALLBACK_COLORS[name], name).toBeDefined();
    for (const name of THEME_NAMES) {
      expect(Object.keys(tokens[name]).sort(), name).toEqual(SERIES.map((s) => s.slice(2)).sort());
    }
  });

  it.each(THEME_NAMES)('%s: every series token is at least 3:1 on the chart ground', (name) => {
    for (const token of SERIES) {
      const value = tokens[name][token.slice(2)];
      expect(toHex6(value), `${name} ${token} is hex`).not.toBeNull();
      expect(contrast(value, grounds[name].bg), `${name} ${token} on chart-bg`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEME_NAMES)('%s: every series token is at least 3:1 on the sub-pane chip', (name) => {
    for (const token of SERIES) {
      const value = tokens[name][token.slice(2)];
      expect(contrast(value, grounds[name].chip), `${name} ${token} on chart-chip-bg`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the literal fallbacks equal to the midnight (default) theme', () => {
    for (const token of SERIES) {
      expect(FALLBACK_COLORS[token]).toBe(tokens.midnight[token.slice(2)].toLowerCase());
    }
  });
});

describe('toHex6', () => {
  it('normalises #rrggbb and #rgb to lower-case #rrggbb', () => {
    expect(toHex6('#4CC2B5')).toBe('#4cc2b5');
    expect(toHex6('#fa0')).toBe('#ffaa00');
  });

  it('rejects anything an <input type="color"> cannot take', () => {
    expect(toHex6('rgb(1, 2, 3)')).toBeNull();
    expect(toHex6('#12345')).toBeNull();
    expect(toHex6('')).toBeNull();
  });
});
