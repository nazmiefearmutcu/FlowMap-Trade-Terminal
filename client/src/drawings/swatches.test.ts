/**
 * Drawing colours on the chart. A drawing is painted in its literal hex on every
 * theme's chart ground, so each swatch (and the default new-drawing colour) must
 * clear WCAG 1.4.11 (3:1) against every theme's `--chart-bg`. themes.css is
 * parsed, so a new theme whose ground breaks the band fails here.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toHex6 } from '../indicators/palette';
import { DRAWING_INK_DEFAULT, DRAWING_INK_SWATCHES } from '../theme/drawInks';
import { DEFAULT_STYLE } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const themesCss = readFileSync(resolve(here, '../theme/themes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The `--chart-bg` each theme block declares, keyed by theme name. */
function chartGrounds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of themesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const theme = /data-theme='([a-z-]+)'/.exec(m[1]);
    const bg = /--chart-bg:\s*([^;]+);/.exec(m[2]);
    if (theme !== null && bg !== null) out[theme[1]] = bg[1].trim();
  }
  return out;
}

type Rgb = [number, number, number];

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

const GROUNDS = chartGrounds();

describe('drawing swatches vs chart grounds', () => {
  it('finds every theme block and a ground for each', () => {
    expect(Object.keys(GROUNDS).length).toBeGreaterThanOrEqual(7);
    for (const [name, bg] of Object.entries(GROUNDS)) expect(toHex6(bg), `${name} chart-bg`).not.toBeNull();
  });

  it('offers six distinct swatches, each a hex colour', () => {
    expect(DRAWING_INK_SWATCHES).toHaveLength(6);
    expect(new Set(DRAWING_INK_SWATCHES).size).toBe(DRAWING_INK_SWATCHES.length);
    for (const color of DRAWING_INK_SWATCHES) expect(toHex6(color), color).not.toBeNull();
  });

  it('starts new drawings in the default ink, which leads the swatch row', () => {
    expect(DEFAULT_STYLE.color).toBe(DRAWING_INK_DEFAULT);
    expect(DRAWING_INK_SWATCHES[0]).toBe(DRAWING_INK_DEFAULT);
  });

  it.each(Object.keys(GROUNDS))('%s: every swatch and the default reach 3:1 on the chart ground', (name) => {
    for (const color of [DEFAULT_STYLE.color, ...DRAWING_INK_SWATCHES]) {
      expect(contrast(color, GROUNDS[name]), `${color} on ${name} chart-bg`).toBeGreaterThanOrEqual(3);
    }
  });
});
