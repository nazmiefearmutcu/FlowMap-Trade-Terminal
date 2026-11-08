/**
 * Series colour helpers for the indicator series (`--indi-c1`..`--indi-c6`).
 *
 * The tokens live in theme/themes.css, one set per theme. The overlay canvas
 * resolves them at paint time, and the picker's colour swatch resolves the SAME
 * value, so the swatch never shows a colour the line is not drawn in. The
 * literal fallbacks sit with the canvas (`FALLBACK_COLORS`), passed in here as
 * arguments.
 */

/**
 * A series token's computed value on <html>, or `fallback` when the token is
 * not set (tests, exotic hosts).
 */
function computedSeriesToken(colorVar: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim();
  return raw.length > 0 ? raw : fallback;
}

/**
 * The `#rrggbb` form of a CSS hex colour (`#rgb` or `#rrggbb`), lower-cased, or
 * null for anything else. `<input type="color">` accepts nothing but `#rrggbb`.
 */
export function toHex6(color: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (m === null) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${digits.toLowerCase()}`;
}

/**
 * The swatch value for a series with no colour override: the theme's resolved
 * token as `#rrggbb`. `fallbackHex` (a `#rrggbb` literal) is used when the token
 * is unset or not a hex colour.
 */
export function themeSwatchHex(colorVar: string, fallbackHex: string): string {
  return toHex6(computedSeriesToken(colorVar, fallbackHex)) ?? fallbackHex;
}
