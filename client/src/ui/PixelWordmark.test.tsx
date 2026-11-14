import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UI_STYLE, UI_STYLE_ATTRIBUTE } from '../theme/uiStyle';
import { PIXEL_WORDMARK_HEIGHT, PIXEL_WORDMARK_WIDTH, pixelWordmarkPath } from './PixelWordmark';

describe('pixel wordmark', () => {
  it('spells FLOWMAP on a 5 by 7 grid, one cell apart', () => {
    expect(PIXEL_WORDMARK_HEIGHT).toBe(7);
    expect(PIXEL_WORDMARK_WIDTH).toBe(7 * 6 - 1);
  });

  it('draws only whole cells inside the grid', () => {
    const cells = [...pixelWordmarkPath().matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
    expect(cells.length).toBeGreaterThan(80);
    expect(cells.map((c) => c[0]).join('')).toBe(pixelWordmarkPath());
    for (const [, x, y] of cells) {
      expect(Number(x)).toBeLessThan(PIXEL_WORDMARK_WIDTH);
      expect(Number(y)).toBeLessThan(PIXEL_WORDMARK_HEIGHT);
    }
  });

  it('leaves the centre of the O empty for the accent cell', () => {
    expect(pixelWordmarkPath()).not.toContain('M14 3h1');
  });

  it('refuses a letter it has no glyph for', () => {
    expect(() => pixelWordmarkPath('FLOWMAPZ')).toThrow(/no glyph for Z/);
  });
});

describe('interface style attribute', () => {
  it('is stamped on the root element of the page before the first paint', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const rootTag = /<html\b[^>]*>/.exec(html)?.[0] ?? '';
    expect(rootTag).toContain(`${UI_STYLE_ATTRIBUTE}="${UI_STYLE}"`);
  });
});

/** Split a selector list at its top-level commas, leaving `:is(a, b)` whole. */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

const CHART_PARTS = [
  '.crosshair', '.price-axis', '.time-axis', '.cvd-pane', '.chart-legend', '.heat-legend',
  '.measure', '.alert-lines', '.draw-layer', '.indi-host',
];

describe('pixel stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/theme/pixel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) => splitSelectorList(m[2]));

  it('applies outside the pixel root only to place the two wordmarks', () => {
    const unscoped = selectors.filter(
      (s) => s !== '' && !s.startsWith("html:root[data-ui-style='pixel']") && !s.startsWith(":where(html:root[data-ui-style='pixel']"),
    );
    expect(unscoped.sort()).toEqual(['.wordmark', '.wordmark--pixel', '.wordmark__heat']);
  });

  it('leaves the chart parts out of the square-corner rule and gives them back the smooth face', () => {
    const square = /\*:not\(:is\(([^)]*)\), :is\(([^)]*)\) \*\)/.exec(css);
    expect(square).not.toBeNull();
    for (const part of CHART_PARTS) {
      expect(square?.[1]).toContain(part);
      expect(square?.[2]).toContain(part);
    }
    expect(square?.[1]).toContain('.gl-canvas');
    const restore = /:is\(([^)]*)\)\s*\{[^}]*--font-ui:\s*'Inter'/.exec(css);
    expect(restore).not.toBeNull();
    for (const part of CHART_PARTS) expect(restore?.[1]).toContain(part);
  });

  it('sets no colour of its own: every colour is a theme token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
