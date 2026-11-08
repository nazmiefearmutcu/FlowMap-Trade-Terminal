/**
 * The keyboard reference, shared by the settings drawer's "Keyboard" section and
 * the `?` shortcuts overlay. One source of truth so the two surfaces can never
 * drift: every entry is a binding that actually exists in code — input/keys.ts
 * (global), input/gestures.ts (canvas focused), the App-level `?` toggle, the
 * theme key (`T`, theme/useTheme.ts), and the self-listened feature keys (`D`
 * DrawToolbar, `I` IndicatorPicker, and the drawings edit chords) — no
 * aspirational ones. Rows that name a bare character key are the ones the
 * single-key switch (input/shortcutPrefs) turns off: see isBareKeyRow.
 */

import { tFor, registerTextVar, type Locale } from '../i18n';
import { THEME_IDS } from '../theme/registry';

/**
 * `{themes}` in `keysheet.theme` is the arrow-joined list of the theme names as
 * the settings drawer shows them: generated from the theme registry, so a
 * rename in the `theme.<id>.name` keys reaches the shortcut sentence too.
 */
export function themeNamesLine(locale: Locale): string {
  return THEME_IDS.map((id) => tFor(locale, `theme.${id}.name`)).join(' → ');
}

registerTextVar('themes', themeNamesLine);

export type KeysheetEntry = Readonly<{
  keys: string;
  actionKey: string;
}>;

export const KEYSHEET: readonly KeysheetEntry[] = [
  { keys: 'Space', actionKey: 'keysheet.space' },
  { keys: '/', actionKey: 'keysheet.slash' },
  { keys: '⌘K / Ctrl+K', actionKey: 'keysheet.chord' },
  { keys: 'E', actionKey: 'keysheet.export' },
  { keys: 'M', actionKey: 'keysheet.measure' },
  { keys: 'A', actionKey: 'keysheet.alert' },
  { keys: 'H', actionKey: 'keysheet.hud' },
  { keys: 'C', actionKey: 'keysheet.channel' },
  { keys: 'T', actionKey: 'keysheet.theme' },
  { keys: 'D', actionKey: 'keysheet.draw' },
  { keys: 'I', actionKey: 'keysheet.indicator' },
  { keys: 'J', actionKey: 'keysheet.intel' },
  { keys: 'Del', actionKey: 'keysheet.delete' },
  { keys: 'Ctrl+Z', actionKey: 'keysheet.undo' },
  { keys: '?', actionKey: 'keysheet.help' },
  { keys: '← → ↑ ↓', actionKey: 'keysheet.pan' },
  { keys: '+ / −', actionKey: 'keysheet.zoom' },
  { keys: '] / [', actionKey: 'keysheet.priceZoom' },
  { keys: 'F', actionKey: 'keysheet.follow' },
  { keys: 'P', actionKey: 'keysheet.priceTrack' },
  { keys: 'Shift+P', actionKey: 'keysheet.shiftP' },
  { keys: 'R', actionKey: 'keysheet.liveEdge' },
  { keys: 'Esc', actionKey: 'keysheet.escape' },
  { keys: 'axis wheel / drag', actionKey: 'keysheet.axis' },
] as const;

/** Target classification subset needed to judge a help toggle (mirrors input/keys.ts). */
export interface HelpKeyContext {
  /** A text-entry surface: `?` is a legitimate typed character (e.g. in the palette). */
  editable: boolean;
  /** Inside a modal dialog: the dialog owns the keyboard. */
  dialog: boolean;
}

/**
 * Pure routing decision for the `?` shortcuts toggle. `?` is Shift+`/`, so it is
 * handled at the App level next to the global keys — but it must never fire while
 * the user is typing (a '?' typed into search is a search character) or while a
 * dialog is open (the dialog owns Escape and everything else; the overlay itself
 * handles its own Escape).
 */
export function isHelpToggle(key: string, ctx: HelpKeyContext): boolean {
  if (key !== '?') return false;
  if (ctx.editable || ctx.dialog) return false;
  return true;
}
