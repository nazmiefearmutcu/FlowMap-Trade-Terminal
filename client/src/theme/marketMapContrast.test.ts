/**
 * Market map tile text must reach WCAG AA (4.5:1) against the tile fill in every
 * theme, at every strength the tiles can take. The fill is the same sRGB mix
 * MarketMap.css draws (the up or down token over the neutral surface, at the
 * capped strength), and the ink is the one the shared rule picks for that strength.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fillShare, tileInk } from '../ui/marketMap/marketMapModel';
import { THEME_IDS } from './registry';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'themes.css'), 'utf8');

type Rgb = readonly [number, number, number];

function parseBlocks(source: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const block of source.matchAll(/:root\[data-theme='([a-z-]+)'\]\s*\{([\s\S]*?)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const decl of block[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[decl[1]] = decl[2].trim();
    out[block[1]] = tokens;
  }
  return out;
}

/** A theme token as RGB. Follows one level of `var(--name)` and rejects anything that is not hex. */
function tokenRgb(tokens: Record<string, string>, name: string): Rgb {
  let value = tokens[name];
  if (value === undefined) throw new Error(`token --${name} missing`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (ref) value = tokens[ref[1]];
  const hex = /^#([0-9a-f]{6})$/i.exec(value ?? '');
  if (!hex) throw new Error(`token --${name} is not a hex colour: ${value}`);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** color-mix(in srgb, colour share%, surface): the channel-wise sRGB blend the stylesheet uses. */
function mix(colour: Rgb, share: number, surface: Rgb): Rgb {
  return [0, 1, 2].map((i) => share * colour[i] + (1 - share) * surface[i]) as unknown as Rgb;
}

const themes = parseBlocks(css);
const STRENGTHS = [0.2, 0.4, 0.6, 0.8, 1];

describe('market map tile contrast', () => {
  it('reads every registry theme from themes.css', () => {
    for (const id of THEME_IDS) expect(themes[id], id).toBeDefined();
  });

  for (const id of THEME_IDS) {
    it(`${id}: up and down tiles pass 4.5:1 at every strength`, () => {
      const tokens = themes[id];
      const text = tokenRgb(tokens, 'text');
      const page = tokenRgb(tokens, 'bg');
      const surface = tokenRgb(tokens, 'bg-2');
      for (const [side, token] of [['up', 'accent'], ['down', 'sell']] as const) {
        const colour = tokenRgb(tokens, token);
        for (const strength of STRENGTHS) {
          const fill = mix(colour, fillShare(strength), surface);
          const ink = tileInk(strength) === 'on-fill' ? page : text;
          const ratio = contrast(fill, ink);
          expect(ratio, `${id} ${side} strength ${strength}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${id}: flat and unknown tiles pass 4.5:1 on the neutral surface`, () => {
      const tokens = themes[id];
      expect(contrast(tokenRgb(tokens, 'bg-2'), tokenRgb(tokens, 'text'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
