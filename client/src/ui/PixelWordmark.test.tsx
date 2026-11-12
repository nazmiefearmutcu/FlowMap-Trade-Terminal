import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyUiStyle, UI_STYLE_ATTRIBUTE } from '../theme/uiStyle';
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
  it('stamps the style on the root element and replaces the previous one', () => {
    const root = document.createElement('html');
    applyUiStyle('pixel', root);
    expect(root.getAttribute(UI_STYLE_ATTRIBUTE)).toBe('pixel');
    applyUiStyle('normal', root);
    expect(root.getAttribute(UI_STYLE_ATTRIBUTE)).toBe('normal');
  });
});

describe('pixel stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/theme/pixel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('touches the normal style only to place the two wordmarks', () => {
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) => m[2].split(',').map((s) => s.trim()));
    const unscoped = selectors.filter((s) => s !== '' && !s.startsWith("html:root[data-ui-style='pixel']"));
    expect(unscoped.sort()).toEqual(['.wordmark', '.wordmark--pixel', '.wordmark__heat']);
  });

  it('sets no colour of its own: every colour is a theme token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
