/**
 * First paint: the static background in index.html is painted before the theme
 * stylesheet loads, so it must match the default theme's `--bg` token. Otherwise
 * the window flashes a colour that belongs to no theme.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID } from './registry';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, '../../index.html'), 'utf8');
const themesCss = readFileSync(resolve(here, 'themes.css'), 'utf8');

function defaultThemeBg(): string | undefined {
  const block = new RegExp(`:root\\[data-theme='${DEFAULT_THEME_ID}'\\]\\s*\\{([^}]*)\\}`).exec(themesCss);
  return block?.[1].match(/--bg:\s*(#[0-9a-fA-F]{3,8})\s*;/)?.[1];
}

describe('first paint background', () => {
  it('index.html paints the default theme ground before the stylesheet loads', () => {
    const paint = /html,body\{background:\s*(#[0-9a-fA-F]{3,8})\s*\}/.exec(indexHtml)?.[1];
    expect(paint).toBeDefined();
    expect(defaultThemeBg()).toBeDefined();
    expect(paint?.toLowerCase()).toBe(defaultThemeBg()?.toLowerCase());
  });
});
