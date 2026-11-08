/**
 * First paint: index.html grounds each theme on its data-theme, and theme-boot.js stamps
 * the saved theme before the stylesheet loads. Both must match the --bg tokens in
 * themes.css, or the window flashes a colour that belongs to no theme.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID, THEME_IDS } from './registry';
import { THEME_STORAGE_KEY } from './useTheme';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const indexHtml = readFileSync(resolve(clientRoot, 'index.html'), 'utf8');
const bootScript = readFileSync(resolve(clientRoot, 'public/theme-boot.js'), 'utf8');
const themesCss = readFileSync(resolve(here, 'themes.css'), 'utf8');

/** The `--bg` token of one theme block in themes.css, lower-cased. */
function tokenGround(id: string): string | undefined {
  const block = new RegExp(`:root\\[data-theme='${id}'\\]\\s*\\{([^}]*)\\}`).exec(themesCss);
  return block?.[1].match(/--bg:\s*(#[0-9a-fA-F]{3,8})\s*;/)?.[1].toLowerCase();
}

/** The ground index.html paints for each `html[data-theme='...']` rule. */
function paintedGrounds(): Map<string, string> {
  const grounds = new Map<string, string>();
  for (const m of indexHtml.matchAll(/html\[data-theme='([a-z-]+)'\]\{background:(#[0-9a-fA-F]{3,8})\}/g)) {
    grounds.set(m[1], m[2].toLowerCase());
  }
  return grounds;
}

describe('first paint background', () => {
  it('index.html paints each theme ground on its data-theme', () => {
    const grounds = paintedGrounds();
    expect([...grounds.keys()].sort()).toEqual([...THEME_IDS].sort());
    for (const id of THEME_IDS) expect(grounds.get(id), id).toBe(tokenGround(id));
  });

  it('the unthemed ground is the default theme ground', () => {
    const unthemed = /<style>\s*html\{background:(#[0-9a-fA-F]{3,8})\}/.exec(indexHtml)?.[1];
    expect(unthemed?.toLowerCase()).toBe(tokenGround(DEFAULT_THEME_ID));
  });

  it('theme-boot.js runs before the app and reads the same storage key', () => {
    expect(indexHtml).toContain('<script src="/theme-boot.js"></script>');
    expect(indexHtml.indexOf('/theme-boot.js')).toBeLessThan(indexHtml.indexOf('/src/main.tsx'));
    expect(bootScript).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  it('theme-boot.js knows exactly the registry theme ids', () => {
    const list = /const FIRST_PAINT_THEMES = \[([^\]]*)\]/.exec(bootScript)?.[1] ?? '';
    const ids = [...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect([...ids].sort()).toEqual([...THEME_IDS].sort());
  });

  it('carries no inline script, which the desktop CSP (script-src self) would refuse', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});
