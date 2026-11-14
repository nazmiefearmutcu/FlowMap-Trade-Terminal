/**
 * The interface style.
 *
 * The window is always drawn in the pixel style: index.html stamps
 * `data-ui-style="pixel"` on the root element before the first paint, and
 * theme/pixel.css keys off it. There is no setting. The chart keeps the smooth
 * style (pixel.css exempts the chart parts; the renderer is never switched).
 */

export const UI_STYLE_ATTRIBUTE = 'data-ui-style';
export const UI_STYLE = 'pixel';
