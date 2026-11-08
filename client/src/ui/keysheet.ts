/**
 * The keyboard reference, shared by the settings drawer's "Keyboard" section and
 * the `?` shortcuts overlay. One source of truth so the two surfaces can never
 * drift: every entry is a binding that actually exists in code — input/keys.ts
 * (global), input/gestures.ts (canvas focused), the App-level `?` toggle, the
 * theme key (`T`, theme/useTheme.ts), and the self-listened feature keys (`D`
 * DrawToolbar, `I` IndicatorPicker, and the drawings edit chords) — no
 * aspirational ones.
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
  /**
   * A bare character key. The single-key switch (input/shortcutPrefs, WCAG 2.1.4)
   * turns these off, so the reference drops them while the switch is off.
   */
  singleKey?: true;
}>;

export const KEYSHEET: readonly KeysheetEntry[] = [
  { keys: 'Space', actionKey: 'keysheet.space', singleKey: true },
  { keys: '/', actionKey: 'keysheet.slash', singleKey: true },
  { keys: '⌘K / Ctrl+K', actionKey: 'keysheet.chord' },
  { keys: 'E', actionKey: 'keysheet.export', singleKey: true },
  { keys: 'M', actionKey: 'keysheet.measure', singleKey: true },
  { keys: 'A', actionKey: 'keysheet.alert', singleKey: true },
  { keys: 'H', actionKey: 'keysheet.hud', singleKey: true },
  { keys: 'C', actionKey: 'keysheet.channel', singleKey: true },
  { keys: 'T', actionKey: 'keysheet.theme', singleKey: true },
  { keys: 'D', actionKey: 'keysheet.draw', singleKey: true },
  { keys: 'I', actionKey: 'keysheet.indicator', singleKey: true },
  { keys: 'J', actionKey: 'keysheet.intel', singleKey: true },
  { keys: 'Del', actionKey: 'keysheet.delete' },
  { keys: 'Ctrl+Z', actionKey: 'keysheet.undo' },
  { keys: '?', actionKey: 'keysheet.help', singleKey: true },
  { keys: '← → ↑ ↓', actionKey: 'keysheet.pan' },
  { keys: '+ / −', actionKey: 'keysheet.zoom', singleKey: true },
  { keys: '] / [', actionKey: 'keysheet.priceZoom', singleKey: true },
  { keys: 'F', actionKey: 'keysheet.follow', singleKey: true },
  { keys: 'P', actionKey: 'keysheet.priceTrack', singleKey: true },
  { keys: 'Shift+P', actionKey: 'keysheet.shiftP', singleKey: true },
  { keys: 'R', actionKey: 'keysheet.liveEdge', singleKey: true },
  { keys: 'Esc', actionKey: 'keysheet.escape' },
  { keys: 'axis wheel / drag', actionKey: 'keysheet.axis' },
] as const;

/**
 * The rows that work while the single-key switch is in the given state. With the
 * switch off, a bare-key row would promise a shortcut that no handler acts on,
 * so the reference lists only the chords and pointer gestures.
 */
export function keysheetRows(singleKeys: boolean): readonly KeysheetEntry[] {
  return singleKeys ? KEYSHEET : KEYSHEET.filter((entry) => entry.singleKey !== true);
}

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
