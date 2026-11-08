/**
 * Theme system barrel.
 *
 * Consumers:
 *   - `import { initTheme, attachThemeKey, getCanvasPalette } from './theme'`
 *     — boot (main.tsx), the `T` shortcut (App.tsx), canvas overlay colors.
 *   - `import { useTheme } from './theme'` — React components.
 *   - CSS: main.tsx imports themes.css after ui/theme.css, so theme blocks win
 *     the cascade (they also out-specify `:root`, but keep order tidy).
 */
// Bundled UI typography: Inter and JetBrains Mono ship with the app.
import './fonts.css';

export {
  CANVAS_VAR_FOR,
  DEFAULT_THEME_ID,
  THEME_IDS,
  THEMES,
  isThemeId,
  nextTheme,
  overlayHalo,
  resolveCanvasPalette,
} from './registry';
export { DRAWING_INK_DEFAULT, DRAWING_INK_SWATCHES } from './drawInks';
export type { CanvasPalette, ThemeId, ThemeMeta } from './registry';
export {
  THEME_STORAGE_KEY,
  attachThemeKey,
  cycleTheme,
  getCanvasPalette,
  getTheme,
  initTheme,
  resetThemeStoreForTest,
  setTheme,
  subscribeTheme,
  useTheme,
} from './useTheme';
