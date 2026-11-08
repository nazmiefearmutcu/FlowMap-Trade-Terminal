/**
 * Token discipline for the owned stylesheets.
 *
 * ESLint does not parse CSS, so the TypeScript `no-restricted-syntax` gate
 * (eslint.config.js) cannot see `font-size: 9px` or `color: #fff` in a stylesheet.
 * This test is the CSS half of the same gate:
 *
 *   - no owned stylesheet may set a literal font size below the 11px floor
 *     (the smallest size the shell uses; the `--fs-2xs` token);
 *   - literal px font sizes and literal colours may only SHRINK: each file's count
 *     may not exceed the ratchet recorded here. Lower the number as sites move onto
 *     theme tokens; never raise it;
 *   - a `font-family` may only be `inherit` or the bundled `--font-ui` / `--font-mono`
 *     token (fonts.css), so no panel falls back to a per-machine system stack.
 *
 * Token definitions (ui/theme.css, theme/themes.css, theme/fonts.css) are the one
 * place literals belong, so they are not scanned.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(process.cwd(), 'src');

/** Stylesheets held to the token discipline rules below. */
const OWNED_CSS = [
  'App.css',
  'ui/features.css',
  'ui/Crosshair.css',
  'ui/Desk.css',
  'ui/MarketStrip.css',
  'ui/TradingPanels.css',
  'watchlist/watchlist.css',
  'theme/shell.css',
] as const;

/**
 * Every stylesheet the font rule covers: the owned ones above plus the rest of the
 * chrome sheets. Each must use a bundled font token or `inherit`.
 */
const FONT_RULE_CSS = [
  ...OWNED_CSS,
  'drawings/drawings.css',
  'ui/AppNotices.css',
  'ui/ChartLegend.css',
  'ui/ChartStartupGate.css',
  'ui/IntelligenceDrawer.css',
  'ui/ReplayPicker.css',
] as const;

/** Smallest font size the shell may use (the `--fs-2xs` token, 11px in every theme). */
export const FONT_FLOOR_PX = 11;

/**
 * Ratchet: the literal px font sizes and literal colours each owned file may still
 * carry. Counts only go down. Each remaining site is a candidate for a token.
 */
export const LITERAL_RATCHET: Readonly<Record<string, { fontPx: number; colours: number }>> = {
  'App.css': { fontPx: 0, colours: 37 },
  'ui/features.css': { fontPx: 0, colours: 0 },
  'ui/Crosshair.css': { fontPx: 0, colours: 0 },
  'ui/Desk.css': { fontPx: 0, colours: 0 },
  'ui/MarketStrip.css': { fontPx: 0, colours: 0 },
  'ui/TradingPanels.css': { fontPx: 0, colours: 0 },
  'watchlist/watchlist.css': { fontPx: 0, colours: 0 },
  'theme/shell.css': { fontPx: 0, colours: 0 },
};

/** CSS with block comments removed, so prose such as "#1 pick" never counts. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Literal px sizes of font declarations. In a `font:` shorthand the size is the
 * px token NOT preceded by `/` (a `/` marks the line-height that follows it).
 * `var(...)` fallbacks are stripped first: the token is the source of truth.
 */
export function literalFontSizesPx(css: string): number[] {
  const sizes: number[] = [];
  const declarations = code(css).replace(/var\([^)]*\)/g, 'var()').matchAll(/\bfont(?:-size)?\s*:\s*([^;}]*)/g);
  for (const match of declarations) {
    for (const px of match[1].matchAll(/(?<![/\d.])(\d+(?:\.\d+)?)px\b/g)) {
      sizes.push(Number(px[1]));
    }
  }
  return sizes;
}

/** Literal colours: hex, rgb()/rgba(), hsl()/hsla() outside comments. */
export function literalColours(css: string): string[] {
  return code(css).match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
}

/**
 * Literal colours in a surface declaration: `box-shadow` and `background*`. A
 * `var(...)` fallback is stripped first, since the token is the source of truth.
 * Themes restyle every shadow and ground through tokens, so a raw colour here
 * renders the same heavy black plate on the cream and white chart grounds.
 */
export function literalSurfaceColours(css: string): string[] {
  const colours: string[] = [];
  const stripped = code(css).replace(/var\([^)]*\)/g, 'var()');
  for (const match of stripped.matchAll(/\b(box-shadow|background(?:-color|-image)?)\s*:\s*([^;}]*)/g)) {
    colours.push(...(match[2].match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []));
  }
  return colours;
}

/**
 * `font-family` values that are not `inherit` or exactly a bundled token. A literal
 * stack (`ui-monospace, Menlo, monospace`) or a token with a stack fallback
 * (`var(--font-mono, monospace)`) both count: the token alone is the contract.
 */
export function literalFontFamilies(css: string): string[] {
  return [...code(css).matchAll(/\bfont-family\s*:\s*([^;}]*)/g)]
    .map((match) => match[1].trim())
    .filter((value) => !/^(inherit|var\(--font-(ui|mono)\))$/.test(value));
}

/**
 * Literal px corner radii. `var(...)` fallbacks are stripped first, and a `999px` pill
 * is a shape rather than a step of the radius scale, so it is not counted.
 */
export function literalRadiiPx(css: string): number[] {
  const radii: number[] = [];
  const stripped = code(css).replace(/var\([^)]*\)/g, 'var()');
  for (const match of stripped.matchAll(/\bborder(?:-[a-z]+)*-radius\s*:\s*([^;}]*)/g)) {
    for (const px of match[1].matchAll(/(?<![\d.])(\d+(?:\.\d+)?)px\b/g)) {
      if (Number(px[1]) !== 999) radii.push(Number(px[1]));
    }
  }
  return radii;
}

/** Stylesheets whose corner radii come from the radius tokens (--r-1..3, --r-dialog) or a pill. */
const RADIUS_CSS = [
  'App.css',
  'ui/features.css',
  'ui/Crosshair.css',
  'ui/Desk.css',
  'ui/MarketStrip.css',
  'ui/TradingPanels.css',
  'theme/shell.css',
  'drawings/drawings.css',
  'ui/AppNotices.css',
  'ui/ChartLegend.css',
  'ui/ChartStartupGate.css',
  'ui/IntelligenceDrawer.css',
  'ui/ReplayPicker.css',
] as const;

describe('owned stylesheets stay on theme tokens', () => {
  it.each(OWNED_CSS)('%s sets no literal font size below the 11px floor', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    const small = literalFontSizesPx(text).filter((px) => px < FONT_FLOOR_PX);
    expect(small, `${file} font sizes below ${FONT_FLOOR_PX}px`).toEqual([]);
  });

  it.each(OWNED_CSS)('%s literal font sizes and colours only shrink (ratchet)', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    const budget = LITERAL_RATCHET[file];
    expect(budget, `${file} has a ratchet entry`).toBeDefined();
    expect(literalFontSizesPx(text).length, `${file} literal px font sizes`).toBeLessThanOrEqual(budget.fontPx);
    expect(literalColours(text).length, `${file} literal colours`).toBeLessThanOrEqual(budget.colours);
  });

  it.each(FONT_RULE_CSS)('%s takes every font-family from the bundled tokens', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    expect(literalFontFamilies(text), `${file} literal font-family`).toEqual([]);
  });

  it.each(FONT_RULE_CSS)('%s draws no shadow or ground with a raw colour', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    expect(literalSurfaceColours(text), `${file} literal shadow or background colour`).toEqual([]);
  });

  it('keeps the typography floor token at 11px in every theme', () => {
    const themes = readFileSync(join(SRC_ROOT, 'theme/themes.css'), 'utf8');
    const floor = [...themes.matchAll(/--fs-2xs:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(floor).toHaveLength(7);
    expect(floor.every((px) => px === FONT_FLOOR_PX)).toBe(true);
  });

  it('reads the px font sizes and colours it is meant to see', () => {
    expect(literalFontSizesPx('.a{font:600 20px/24px var(--font-mono)} .b{font-size:var(--fs-xs,10px)}')).toEqual([20]);
    expect(literalFontSizesPx('.c{font-size: 9px} /* 8px */')).toEqual([9]);
    expect(literalColours('.d{color:#fff;background:rgba(0,0,0,.5)} /* #123 */')).toEqual(['#fff', 'rgba(']);
  });

  it('reads the literal surface colours it must catch, and not the token fallbacks', () => {
    expect(literalSurfaceColours('.a{box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45)}')).toEqual(['rgba(']);
    expect(literalSurfaceColours('.b{background: rgba(31, 182, 166, 0.08)}')).toEqual(['rgba(']);
    expect(literalSurfaceColours('.c{background: #fff; border-color: #000}')).toEqual(['#fff']);
    expect(literalSurfaceColours('.d{background: var(--chart-chip-bg, rgba(10, 12, 16, 0.92))}')).toEqual([]);
    expect(literalSurfaceColours('.e{box-shadow: 0 0 7px color-mix(in srgb, var(--sell, #e8635f) 70%, transparent)}')).toEqual([]);
    expect(literalSurfaceColours('.f{box-shadow: var(--shadow-pop)} /* box-shadow: 0 0 #000 */')).toEqual([]);
  });

  it.each(FONT_RULE_CSS)('%s sets no literal px font size at all', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    expect(literalFontSizesPx(text), `${file} literal px font sizes`).toEqual([]);
  });

  it.each(RADIUS_CSS)('%s corner radii come from the radius tokens', (file) => {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    expect(literalRadiiPx(text), `${file} literal px corner radii`).toEqual([]);
  });

  it('every theme block defines the dialog radius token', () => {
    const themes = readFileSync(join(SRC_ROOT, 'theme/themes.css'), 'utf8');
    const blocks = [...themes.matchAll(/:root\[data-theme='[a-z-]+'\]\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(7);
    for (const block of blocks) expect(block).toMatch(/--r-dialog:\s*12px;/);
  });

  it('reads the px corner radii it must catch, and not the tokens or pills', () => {
    expect(
      literalRadiiPx('.a{border-radius: 6px} .b{border-radius: 999px} .c{border-top-left-radius: var(--r-1, 4px)} .d{border-radius: 3px 0}'),
    ).toEqual([6, 3]);
  });

  it('reads the literal font stacks it must catch', () => {
    expect(literalFontFamilies('.a{font-family: ui-monospace, Menlo, monospace}')).toEqual([
      'ui-monospace, Menlo, monospace',
    ]);
    expect(literalFontFamilies('.b{font-family: var(--font-mono, monospace)} .c{font-family: inherit}')).toEqual([
      'var(--font-mono, monospace)',
    ]);
    expect(literalFontFamilies('.d{font-family: var(--font-ui)} /* font-family: Menlo */')).toEqual([]);
  });
});
