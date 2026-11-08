/**
 * Token completeness and text contrast for every theme block in themes.css.
 * Parses the stylesheet itself, so a theme that forgets a token, or that drops a
 * text step back below AA, fails here rather than in a screenshot review.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DRAWING_INK_DEFAULT, DRAWING_INK_SWATCHES } from './drawInks';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'themes.css'), 'utf8');

type Rgb = [number, number, number];

function parseBlocks(source: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const block of source.matchAll(/:root\[data-theme='([a-z-]+)'\]\s*\{([\s\S]*?)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const decl of block[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[decl[1]] = decl[2].trim();
    out[block[1]] = tokens;
  }
  return out;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const themes = parseBlocks(css);
const THEME_NAMES = ['midnight', 'paper', 'swiss', 'amber', 'sea', 'paper-deut', 'contrast'];

describe('theme token completeness', () => {
  it('defines every theme in the registry', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_NAMES].sort());
  });

  it.each(THEME_NAMES)('%s defines the bid/ask bar tints (not only on :root)', (name) => {
    expect(themes[name]['bid-bar']).toBeTruthy();
    expect(themes[name]['ask-bar']).toBeTruthy();
  });

  it.each(THEME_NAMES)('%s gives text-2, text-3 and text-4 three distinct values', (name) => {
    const t = themes[name];
    const values = new Set([t['text-2'], t['text-3'], t['text-4']]);
    expect(values.size).toBe(3);
  });
});

describe('theme text contrast (AA, 4.5:1)', () => {
  const grounds = ['bg', 'bg-1', 'bg-2', 'bg-3'] as const;
  it.each(THEME_NAMES)('%s keeps every text step readable on every panel ground', (name) => {
    const t = themes[name];
    for (const step of ['text-2', 'text-3', 'text-4'] as const) {
      for (const ground of grounds) {
        const ratio = contrast(hexToRgb(t[step]), hexToRgb(t[ground]));
        expect(ratio, `${name} ${step} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEME_NAMES)('%s orders the steps: primary text is the strongest', (name) => {
    const t = themes[name];
    const primary = contrast(hexToRgb(t.text), hexToRgb(t['bg-1']));
    const secondary = contrast(hexToRgb(t['text-2']), hexToRgb(t['bg-1']));
    const tertiary = contrast(hexToRgb(t['text-3']), hexToRgb(t['bg-1']));
    expect(primary).toBeGreaterThan(secondary);
    expect(secondary).toBeGreaterThan(tertiary);
  });
});

const INDICATOR_TOKENS = ['indi-c1', 'indi-c2', 'indi-c3', 'indi-c4', 'indi-c5', 'indi-c6'] as const;

describe('non-text chart and control tokens clear 3:1 (WCAG 1.4.11)', () => {
  it.each(THEME_NAMES)('%s indicator series colours clear 3:1 on the chart ground', (name) => {
    const t = themes[name];
    for (const token of INDICATOR_TOKENS) {
      const ratio = contrast(hexToRgb(t[token]), hexToRgb(t['chart-bg']));
      expect(ratio, `${name} ${token} on chart-bg`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEME_NAMES)('%s indicator series colours are distinct', (name) => {
    const values = new Set(INDICATOR_TOKENS.map((token) => themes[name][token]));
    expect(values.size).toBe(INDICATOR_TOKENS.length);
  });

  it.each(THEME_NAMES)('%s control boundary clears 3:1 on the panel and inset grounds', (name) => {
    const t = themes[name];
    for (const ground of ['bg-1', 'bg-inset'] as const) {
      const ratio = contrast(hexToRgb(t['control-line']), hexToRgb(t[ground]));
      expect(ratio, `${name} control-line on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEME_NAMES)('%s equity venue dot clears 3:1 on the panel ground', (name) => {
    const ratio = contrast(hexToRgb(themes[name]['venue-equity']), hexToRgb(themes[name]['bg-1']));
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});

describe('scrims: light themes use a tinted scrim, dark themes keep the shared one', () => {
  it.each(['paper', 'swiss', 'paper-deut'])('%s scrim is not pure black', (name) => {
    expect(themes[name].scrim).not.toMatch(/^rgba\(0, 0, 0,/);
  });

  it.each(['midnight', 'amber', 'sea', 'contrast'])('%s dark theme keeps the shared dark scrim', (name) => {
    expect(themes[name].scrim).toBe('rgba(0, 0, 0, 0.55)');
  });
});

describe('drawing inks stay visible on every chart ground (WCAG 1.4.11)', () => {
  const inks = [DRAWING_INK_DEFAULT, ...DRAWING_INK_SWATCHES];

  it('the default ink is one of the swatches', () => {
    expect(DRAWING_INK_SWATCHES).toContain(DRAWING_INK_DEFAULT);
  });

  it('every swatch is a distinct ink', () => {
    expect(new Set(DRAWING_INK_SWATCHES).size).toBe(DRAWING_INK_SWATCHES.length);
  });

  it.each(THEME_NAMES)('every drawing ink clears 3:1 on the %s chart ground', (name) => {
    for (const ink of inks) {
      const ratio = contrast(hexToRgb(ink), hexToRgb(themes[name]['chart-bg']));
      expect(ratio, `${ink} on ${name} chart-bg`).toBeGreaterThanOrEqual(3);
    }
  });
});
