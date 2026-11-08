/**
 * Machine-readable key summary and fallback role for the chart canvas (WCAG 4.1.2).
 *
 * The canvas is the chart's one focus stop. App.tsx owns its accessible name
 * (it knows the instrument and re-renders on a locale change) and points
 * aria-describedby at the visually hidden key help. This module only
 * adds what React does not set: `aria-keyshortcuts` for the keys
 * input/gestures.ts handles, plus a role and tab stop when the page has not
 * provided them.
 *
 * The bare-character keys (+ - [ ] F P R) follow the single-key shortcut switch
 * (input/shortcutPrefs.ts), so the summary is rebuilt when the switch changes.
 */

import { isSingleKeyShortcutsEnabled, subscribeSingleKeyShortcuts } from '../input/shortcutPrefs';

/** Keys the chart handles while its canvas has focus, whatever the single-key switch says. */
const ALWAYS_ON_KEYS = 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown';

/** Single-character keys, handled only while the single-key switch is on. */
const SINGLE_CHARACTER_KEYS = '+ - [ ] F P R';

/** The `aria-keyshortcuts` value for the given state of the single-key switch. */
export function chartKeyshortcuts(singleKeys: boolean): string {
  return singleKeys ? `${ALWAYS_ON_KEYS} ${SINGLE_CHARACTER_KEYS}` : ALWAYS_ON_KEYS;
}

/** Chart canvases that carry the summary. Held weakly so a removed canvas is not kept alive. */
const tracked = new Set<WeakRef<HTMLCanvasElement>>();
let unsubscribe: (() => void) | null = null;

function refreshKeyshortcuts(): void {
  const keys = chartKeyshortcuts(isSingleKeyShortcutsEnabled());
  for (const ref of tracked) {
    const canvas = ref.deref();
    if (canvas === undefined) {
      tracked.delete(ref);
      continue;
    }
    canvas.setAttribute('aria-keyshortcuts', keys);
  }
}

function track(canvas: HTMLCanvasElement): void {
  for (const ref of tracked) {
    if (ref.deref() === canvas) return;
  }
  tracked.add(new WeakRef(canvas));
  unsubscribe ??= subscribeSingleKeyShortcuts(refreshKeyshortcuts);
}

/**
 * Give `canvas` its key summary, and a role and tab stop if the page has not
 * set them. The attributes live on the canvas itself, so nothing needs undoing.
 * The summary follows the single-key switch from then on.
 */
export function applyChartAccessibility(canvas: HTMLCanvasElement): void {
  if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-keyshortcuts', chartKeyshortcuts(isSingleKeyShortcutsEnabled()));
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
  track(canvas);
}
