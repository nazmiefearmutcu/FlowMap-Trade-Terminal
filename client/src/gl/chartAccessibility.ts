/**
 * Machine-readable key summary and fallback role for the chart canvas (WCAG 4.1.2).
 *
 * The canvas is the chart's one focus stop. App.tsx owns its accessible name
 * (it knows the instrument and re-renders on a locale change) and points
 * aria-describedby at the visually hidden key help. This module only
 * adds what React does not set: `aria-keyshortcuts` for the keys
 * input/gestures.ts and gl/renderer.ts handle, plus a role and tab stop when the
 * page has not provided them.
 */

/** The keys the chart handles while its canvas has focus. */
export const CHART_KEYSHORTCUTS = 'ArrowLeft ArrowRight ArrowUp ArrowDown + - [ ] F P R';

/**
 * Give `canvas` its key summary, and a role and tab stop if the page has not
 * set them. The attributes live on the canvas itself, so nothing needs undoing.
 */
export function applyChartAccessibility(canvas: HTMLCanvasElement): void {
  if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-keyshortcuts', CHART_KEYSHORTCUTS);
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
}
