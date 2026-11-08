/**
 * The drawing ink palette: the fixed hexes a user's drawing keeps across theme
 * switches. A drawing is user-authored canvas content, not chrome, so these do not
 * follow the theme tokens. Each ink must clear 3:1 (WCAG 1.4.11) against the chart
 * ground of every theme, so a new drawing stays visible on all seven grounds.
 * themeTokens.test.ts measures every ink against the parsed `--chart-bg` tokens.
 */

/** The ink a new drawing starts with: teal, the accent hue of the dark themes. */
export const DRAWING_INK_DEFAULT = '#2A8F7E';

/** The swatch row, in display order. The default ink leads the row. */
export const DRAWING_INK_SWATCHES: readonly string[] = [
  DRAWING_INK_DEFAULT,
  '#3F7FD1', // blue
  '#8A5CD6', // violet
  '#4A8F3A', // green
  '#B5651D', // amber
  '#6B7280', // neutral grey, readable on light and dark grounds alike
];
