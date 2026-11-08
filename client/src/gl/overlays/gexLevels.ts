/**
 * Gamma Exposure (GEX) levels overlay (FLOW <GO>).
 *
 * Visualizes key option-implied market microstructure boundaries on the price grid:
 * - Call Wall (Green): Highest call gamma strike (volatility dampener / ceiling).
 * - Put Wall (Red): Highest put gamma strike (volatility floor / crash trigger).
 * - Gamma Flip (Cyan): Inflection level where dealer gamma flips from stabilizing to accelerating.
 *
 * Visibility is the manager's job (`visibility.gex`); this class has no switch of
 * its own, so there is one place that decides whether the overlay draws.
 */

import { t } from '../../i18n';
import { formatPrice } from '../../i18n/format';
import { quoteDecimals } from './axisTicks';
import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import { addUnderStrokedSegments } from './underStroke';
import type { GexLevelUpdate } from '../../proto/types';

/** CSS-px width of a GEX level line (its contrast under-stroke is added on draw). */
const GEX_LINE_WIDTH_PX = 1.8;

/**
 * Minimum vertical gap, in css px, between two right-edge badges. A size-10 badge
 * is about 12 px tall, so anything closer would overprint its neighbour.
 */
export const BADGE_PITCH_PX = 12;

/**
 * Spread badge anchors that sit closer than `pitch` apart (the
 * three walls often land within a few pixels of each other).
 *
 * `ys` are the badge anchors' css-y values, already sorted ascending. The result
 * keeps that order, each anchor at least `pitch` below the previous one. When the
 * stack would run past `bottom` it is anchored to the bottom edge and pushed up
 * instead, and a run past `top` is pushed back down. Only labels move: the level
 * lines stay on their true rows.
 */
export function stackBadgeY(ys: readonly number[], pitch: number, top: number, bottom: number): number[] {
  const out = ys.slice();
  if (out.length === 0) return out;
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + pitch);
  if (out[out.length - 1] > bottom) {
    out[out.length - 1] = bottom;
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - pitch);
  }
  if (out[0] < top) {
    out[0] = top;
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + pitch);
  }
  return out;
}

type RGBA = readonly [number, number, number, number];

interface LevelDraw {
  readonly price: number;
  readonly y: number;
  readonly cy: number;
  readonly colorGl: RGBA;
  readonly colorCss: string;
  readonly label: string;
  labelY: number;
}

export class GexOverlay {
  private current: GexLevelUpdate | null = null;

  set(state: GexLevelUpdate | null): void {
    this.current = state;
  }

  get(): GexLevelUpdate | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }

  draw(frame: OverlayFrame): void {
    if (this.current === null) return;
    const { gm, solid, text } = frame;
    if (gm.price === null) return;

    const gex = this.current;
    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    // Venue-tick precision (as bbo.ts does): a 0.25 tick keeps two decimals, so a
    // wall at 5234.25 prints '5234.25', not the step-rounded '5234.3'.
    const decimals = quoteDecimals(gm.price.tick ?? gm.price.step);

    // Collect the levels on screen first: badges are spread against each other,
    // which needs every visible anchor at once.
    const levels: LevelDraw[] = [];
    const collect = (
      price: number,
      colorGl: RGBA,
      colorCss: string,
      label: string,
    ): void => {
      if (!Number.isFinite(price) || price <= 0) return;
      const rowf = gm.priceEventToRow(price);
      const y = gm.clipY(rowf);
      if (y < -1.02 || y > 1.02) return;
      levels.push({ price, y, cy: gm.cssY(rowf), colorGl, colorCss, label, labelY: 0 });
    };

    // Ceiling / floor / regime change keep their green / red / cyan meaning.
    if (gex.call_wall > 0) collect(gex.call_wall, OVERLAY.gexCall.gl, OVERLAY.gexCall.css, t('gl.gexCallWall'));
    if (gex.put_wall > 0) collect(gex.put_wall, OVERLAY.gexPut.gl, OVERLAY.gexPut.css, t('gl.gexPutWall'));
    if (gex.gamma_flip > 0) collect(gex.gamma_flip, OVERLAY.gexGamma.gl, OVERLAY.gexGamma.css, t('gl.gexGammaFlip'));
    if (levels.length === 0) return;

    const order = levels.map((_, i) => i).sort((a, b) => levels[a].cy - levels[b].cy);
    const stacked = stackBadgeY(order.map((i) => levels[i].cy), BADGE_PITCH_PX, 0, cssH);
    order.forEach((levelIndex, k) => {
      levels[levelIndex].labelY = stacked[k];
    });

    for (const level of levels) {
      solid.begin();
      addUnderStrokedSegments(solid, [{ x0: -1, y0: level.y, x1: 1, y1: level.y }], GEX_LINE_WIDTH_PX, level.colorGl, cssW, cssH);
      solid.flush();

      // Right-edge badge on text layer, at its stacked anchor (the line stays on the true row).
      text.badge(cssW - 4, level.labelY, `${level.label} ${formatPrice(level.price, decimals)}`, {
        align: 'right',
        color: level.colorCss,
        size: 10,
      });
    }
  }
}
