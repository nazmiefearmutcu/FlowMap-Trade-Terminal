/**
 * The interface style: `normal` or `pixel`.
 *
 * One setting drives both the chart renderer and the window chrome. The renderer
 * takes it through `setChartStyle`; the chrome reads `data-ui-style` on the root
 * element, which theme/pixel.css keys off. This module is the single writer of
 * that attribute.
 */

import type { ChartStyle } from '../gl/heatmapMath';

export const UI_STYLE_ATTRIBUTE = 'data-ui-style';

/** Stamp the style on the root element. Idempotent. */
export function applyUiStyle(style: ChartStyle, root: HTMLElement = document.documentElement): void {
  if (root.getAttribute(UI_STYLE_ATTRIBUTE) !== style) root.setAttribute(UI_STYLE_ATTRIBUTE, style);
}
