/**
 * Axis draw-glue tests.
 *
 * Pins the surgical Bookmap-class tunings plus the pre-existing contracts the
 * tunings must not disturb:
 * - label precision at LARGE prices: labels keep the venue tick's decimals and
 *     are never rounded to fit the gutter, so ticks stay distinct; the
 *     width-free path stays byte-identical (`toFixed(step decimals)`);
 *   - tick marks: 6 px majors at AXIS_TICK_ALPHA for BOTH axes (subtle guides,
 *     dimmer than the labels they serve);
 *   - time-axis typography: AXIS_TIME_LABEL_SIZE / AXIS_LABEL_WEIGHT, ms-precision
 *     strings, first/last labels clamped inward so they can never be half-clipped;
 * - gridline-coverage contract: the string-free position helpers return EXACTLY
 *     the labeled ticks (no minor tick may draw a line the axis does not label).
 */

import { describe, expect, it } from 'vitest';

import {
  AXIS_LABEL_SIZE,
  AXIS_LABEL_WEIGHT,
  AXIS_TICK_ALPHA,
  AXIS_TICK_LEN,
  AXIS_TIME_LABEL_SIZE,
  drawGridlines,
  drawPriceAxis,
  drawTimeAxis,
  priceAxisModel,
  priceTickPositions,
  snapToPixelBlock,
  timeAxisLabelFormatter,
  timeAxisModel,
  timeTickPositions,
  type TimeAxisClock,
} from './axes';
import { GridMap, type PriceMap, type TimeMap } from './coords';
import { PIXEL_BLOCK_CSS } from '../heatmap';
import type { TextLayer } from '../textLayer';
import { makeHybrid } from '../priceScale';
import { priceFrame } from '../camera';
import { fractionRow } from '../priceProjection';
import { timeLabelFormatter, timeTickModel } from './axisTicks';

const DIMS = { drawW: 800, drawH: 400, cssW: 800, cssH: 400 };
/** Session-relative affine: col 5 == 1.25 s, 250 ms per column. */
const TIME: TimeMap = { anchorSeq: 5, anchorT0Ns: 1_250_000_000n, dtNs: 250_000_000 };
const VIEW = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 };

function gm(price: PriceMap, rowScale = VIEW.rowScale): GridMap {
  return new GridMap({ ...VIEW, rowScale }, DIMS, TIME, price);
}

interface LineCall {
  x0: number; y0: number; x1: number; y1: number; color: string; width: number; alpha: number;
}
interface TextCall { x: number; y: number; str: string; opts: Record<string, unknown> }

/** A TextLayer stub that records calls instead of painting (no canvas). */
function stubLayer(width: number, height: number): { layer: TextLayer; lines: LineCall[]; texts: TextCall[] } {
  const lines: LineCall[] = [];
  const texts: TextCall[] = [];
  const layer = {
    width,
    height,
    clear: () => {},
    line: (x0: number, y0: number, x1: number, y1: number, color: string, w = 1, a = 1) => {
      lines.push({ x0, y0, x1, y1, color, width: w, alpha: a });
    },
    text: (x: number, y: number, str: string, opts: Record<string, unknown>) => {
      texts.push({ x, y, str, opts });
    },
    badge: () => {},
  } as unknown as TextLayer;
  return { layer, lines, texts };
}

describe('priceAxisModel — label fit at large prices', () => {
  it('labels the fitted BTC range with a uniform dollar ladder', () => {
    const scale = makeHybrid({ mid: 85505, rows: 4096, coreRows: 2048, coreStep: 0.01, upMult: 11, dnFloor: 0.01 })!;
    const frame = priceFrame(scale.dnRows, scale.dnRows + scale.coreRows - 1, scale.rows, 0.08, 3, scale);
    const g = new GridMap({ ...VIEW, rowOffset: frame.rowBottom, rowScale: frame.rowSpan }, DIMS, TIME,
      { p0: scale.coreP0, step: scale.coreStep, scale });
    const labels = priceAxisModel(g, DIMS.cssH, 56);
    const core = labels.filter(l => Number(l.label) > 85490 && Number(l.label) < 85520);
    expect(core.length).toBeGreaterThanOrEqual(4);
    const positions = labels.map(l => l.pos).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) expect(positions[i] - positions[i - 1]).toBeGreaterThanOrEqual(22);
    expect(priceTickPositions(g, DIMS.cssH)).toEqual(labels.map(l => l.pos));
    for (const label of core) {
      const row = fractionRow(g.view, scale, 1 - label.pos / DIMS.cssH);
      expect(Number(label.label)).toBeCloseTo(g.rowToPrice(row), 5);
    }
  });

  it('never rounds big-price labels below the venue tick precision', () => {
    // Deep zoom on a large price: a 0.01 tick prints "12345.01" (8 chars), wider
    // than the 48 px gutter. The labels stay exact at two decimals; they are not
    // rounded to fit, because rounding merges distinct ticks.
    const g = gm({ p0: 12345, step: 0.01 }, 8);
    const labels = priceAxisModel(g, DIMS.cssH, 48);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l.label).toMatch(/^12345\.\d{2}$/);
    expect(new Set(labels.map((l) => l.label)).size).toBe(labels.length);
  });

  it('keeps 0.05-tick labels distinct on a 5-digit price in a narrow gutter', () => {
    // Regression: the width fit dropped the ladder to one decimal, printing
    // 12345.0 | 12345.1 | 12345.1 for the 0.05 ticks 12345.05, .10, .15.
    const g = gm({ p0: 12345, step: 0.05 }, 8);
    const labels = priceAxisModel(g, DIMS.cssH, 48);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l.label).toMatch(/^12345\.\d{2}$/);
    expect(new Set(labels.map((l) => l.label)).size).toBe(labels.length);
    const byPrice = labels.map((l) => Number(l.label));
    for (let i = 1; i < byPrice.length; i++) expect(byPrice[i]).toBeGreaterThan(byPrice[i - 1]);
  });

  it('keeps the width-free path byte-identical (historical toFixed)', () => {
    const g = gm({ p0: 12345, step: 0.01 }, 8);
    const labels = priceAxisModel(g, DIMS.cssH);
    expect(labels.length).toBeGreaterThan(2);
    expect(labels[0].label).toBe('12345.00');
    for (const l of labels) expect(l.label).toMatch(/^12345\.\d{2}$/);
  });

  it('fits 7-char integer prices (1.2M-scale asset) exactly in the budget', () => {
    const g = gm({ p0: 1_234_500, step: 1 }, 700);
    const labels = priceAxisModel(g, DIMS.cssH, 48);
    expect(labels.length).toBeGreaterThan(4);
    for (const l of labels) {
      expect(l.label.length).toBeLessThanOrEqual(7);
      // 7 chars × 11 px × 0.6 em advance = 46.2 px ≤ the 48 px label box.
      expect(l.label.length * AXIS_LABEL_SIZE * 0.6).toBeLessThanOrEqual(48);
    }
  });
});

describe('drawPriceAxis — tick marks and label styling', () => {
  it('draws 6 px majors at AXIS_TICK_ALPHA and 11 px/500 labels right-aligned at cssW-6', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const { layer, lines, texts } = stubLayer(62, DIMS.cssH);
    drawPriceAxis(layer, g, null);

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.length).toBe(texts.length); // exactly one labeled tick per line
    for (const ln of lines) {
      expect(ln.x0).toBe(0);
      expect(ln.y0).toBe(ln.y1);
      expect(ln.x1).toBe(AXIS_TICK_LEN);
      expect(ln.width).toBe(1);
      expect(ln.alpha).toBe(AXIS_TICK_ALPHA);
    }
    for (const t of texts) {
      expect(t.x).toBe(62 - 6);
      expect(t.opts.align).toBe('right');
      expect(t.opts.baseline).toBe('middle');
      expect(t.opts.size).toBe(AXIS_LABEL_SIZE);
      expect(t.opts.weight).toBe(AXIS_LABEL_WEIGHT);
    }
  });
});

describe('drawTimeAxis — typography, ticks, edge clamping', () => {
  it.each([220, 1033])('keeps projected labels apart at width %s, including a large timestamp gap', cssW => {
    const hour = 3_600_000_000_000n;
    const time: TimeMap = { anchorSeq: 1000, anchorT0Ns: 25n * hour, dtNs: 250_000_000,
      slots: { startSeq: 0, cols: Float64Array.of(0, 300, 304, 1000),
        t0: Float64Array.of(0, Number(3n * hour), Number(23n * hour), Number(25n * hour)) } };
    const g = new GridMap({ ...VIEW, colScale: 1000 }, { ...DIMS, cssW, drawW: cssW }, time, { p0: 100, step: .5 });
    const model = timeAxisModel(g, cssW);
    const { layer, texts, lines } = stubLayer(cssW, 22);
    drawTimeAxis(layer, g);
    expect(model.length).toBeGreaterThan(0);
    expect(model.length).toBeLessThanOrEqual(8);
    expect(timeTickPositions(g, cssW)).toEqual(model.map(t => t.pos));
    const candidates = timeTickModel(0n, 25n * hour, 7);
    const fmt = timeLabelFormatter(candidates.step);
    for (let i = 0; i < model.length; i++) {
      expect(candidates.ticks.some(t => fmt(t) === model[i].label && Math.abs(g.cssX(g.tsToCol(t)) - model[i].pos) < 1e-8)).toBe(true);
      expect(lines[i].x0).toBe(model[i].pos); // Tick location remains authoritative.
    }
    const boxes = texts.map(t => {
      const width = t.str.length * AXIS_TIME_LABEL_SIZE * .6;
      const left = t.opts.align === 'right' ? t.x - width : t.opts.align === 'center' ? t.x - width / 2 : t.x;
      return { left, right: left + width };
    });
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].left).toBeGreaterThanOrEqual(2 - 1e-8);
      expect(boxes[i].right).toBeLessThanOrEqual(cssW - 2 + 1e-8);
      if (i > 0) expect(boxes[i].left - boxes[i - 1].right).toBeGreaterThanOrEqual(8 - 1e-8);
    }
  });

  it('draws 6 px majors at AXIS_TICK_ALPHA and clamps the first/last label inward', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const model = timeAxisModel(g, 800);
    expect(model.length).toBeGreaterThan(2);
    const { layer, lines, texts } = stubLayer(800, 22);
    drawTimeAxis(layer, g);

    expect(lines.length).toBe(model.length);
    for (const ln of lines) {
      expect(ln.x0).toBe(ln.x1);
      expect(ln.y0).toBe(0);
      expect(ln.y1).toBe(AXIS_TICK_LEN);
      expect(ln.alpha).toBe(AXIS_TICK_ALPHA);
    }
    expect(texts.length).toBe(model.length);
    for (const t of texts) {
      expect(t.opts.size).toBe(AXIS_TIME_LABEL_SIZE);
      expect(t.opts.weight).toBe(AXIS_LABEL_WEIGHT);
      expect(t.y).toBe(15);
    }
    // First label anchors left at x=2; the last anchors right inside the gutter.
    expect(texts[0].opts.align).toBe('left');
    expect(texts[0].x).toBe(2);
    expect(texts[texts.length - 1].opts.align).toBe('right');
    expect(texts[texts.length - 1].x).toBe(800 - 2);
    // ...while the tick marks themselves stay on the true tick positions.
    expect(lines[lines.length - 1].x0).toBe(model[model.length - 1].pos);
  });
});

describe('time axis zone label', () => {
  const UTC_CLOCK: TimeAxisClock = { pref: 'utc', exchangeZone: 'UTC' };

  it('prints the zone abbreviation at the right end of the strip on a clock', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const { layer, texts } = stubLayer(800, 22);
    drawTimeAxis(layer, g, UTC_CLOCK);
    const zone = texts.filter(t => t.str === 'UTC');
    expect(zone).toHaveLength(1);
    expect(zone[0].x).toBe(800 - 2);
    expect(zone[0].opts.align).toBe('right');
    expect(zone[0].y).toBe(15);
  });

  it('keeps the session-relative axis free of a zone label', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const { layer, texts } = stubLayer(800, 22);
    drawTimeAxis(layer, g, null);
    expect(texts.some(t => t.str === 'UTC')).toBe(false);
  });

  it('lays the time labels out in the width the zone label leaves', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const clockModel = timeAxisModel(g, 800, UTC_CLOCK);
    const reserve = 'UTC'.length * AXIS_TIME_LABEL_SIZE * 0.6 + 8;
    expect(clockModel.length).toBeGreaterThan(0);
    for (const label of clockModel) expect(label.pos).toBeLessThanOrEqual(800 - reserve + 1 + 1e-8);
  });
});

describe('pixel chart style — axes snap to the block grid', () => {
  it('snapToPixelBlock is the identity outside pixel style', () => {
    expect(snapToPixelBlock(100.4, false)).toBe(100.4);
    expect(snapToPixelBlock(100.4, undefined)).toBe(100.4);
  });

  it('snapToPixelBlock centres a position on its block of PIXEL_BLOCK_CSS', () => {
    const block = PIXEL_BLOCK_CSS;
    for (const pos of [0.2, 5.9, 6.0, 100.4, 317.7]) {
      const snapped = snapToPixelBlock(pos, true);
      expect(Math.floor(snapped / block)).toBe(Math.floor(pos / block));
      expect(snapped % block).toBe(block / 2);
    }
  });

  it('draws price ticks, labels and the time strip on block centres', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const { layer, lines, texts } = stubLayer(62, DIMS.cssH);
    drawPriceAxis(layer, g, null, { pixel: true });
    expect(lines.length).toBeGreaterThan(3);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i].y0 % PIXEL_BLOCK_CSS).toBe(PIXEL_BLOCK_CSS / 2);
      expect(texts[i].y).toBe(lines[i].y0);
    }
    const timeLayer = stubLayer(800, 22);
    drawTimeAxis(timeLayer.layer, g, null, { pixel: true });
    for (const ln of timeLayer.lines) expect(ln.x0 % PIXEL_BLOCK_CSS).toBe(PIXEL_BLOCK_CSS / 2);
  });

  it('snaps gridlines to block centres and keeps one line per block', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const lines: LineCall[] = [];
    const text = { width: 800, height: 400, line: (x0: number, y0: number, x1: number, y1: number, color: string, w = 1) => {
      lines.push({ x0, y0, x1, y1, color, width: w, alpha: 1 });
    } } as unknown as TextLayer;
    drawGridlines(text, g, { pixel: true });
    expect(lines.length).toBeGreaterThan(0);
    for (const ln of lines) {
      const pos = ln.y0 === ln.y1 ? ln.y0 : ln.x0;
      expect(pos % PIXEL_BLOCK_CSS).toBe(PIXEL_BLOCK_CSS / 2);
    }
  });
});

describe('gridline coverage contract — positions == labeled ticks', () => {
  it('priceTickPositions is exactly the labeled price ladder', () => {
    const g = gm({ p0: 77000, step: 1 }, 800);
    const model = priceAxisModel(g, DIMS.cssH);
    expect(model.length).toBeGreaterThan(4);
    expect(priceTickPositions(g, DIMS.cssH)).toEqual(model.map((l) => l.pos));
  });

  it('timeTickPositions is exactly the labeled time ladder', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const model = timeAxisModel(g, 800);
    expect(model.length).toBeGreaterThan(2);
    expect(timeTickPositions(g, 800)).toEqual(model.map((l) => l.pos));
  });
});

describe('quarter-tick instruments — label precision and row registration', () => {
  it('prints a 0.25-tick ladder with two decimals, never a step-rounded 0.3', () => {
    // 0.25 grid step: the old ceil(-log10(0.25)) = 1 decimal printed 5230.25 as '5230.3'.
    const g = gm({ p0: 5230, step: 0.25 }, 4);
    const labels = priceAxisModel(g, DIMS.cssH);
    expect(labels.map((l) => l.label)).toContain('5230.25');
    for (const l of labels) expect(l.label).toMatch(/^\d+\.\d{2}$/);
  });

  it('registers each tick on the event row the price line uses (cell centre)', () => {
    const g = gm({ p0: 5230, step: 0.25 }, 4);
    const labels = priceAxisModel(g, DIMS.cssH);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) {
      const price = Number(l.label);
      expect(l.pos).toBeCloseTo(g.cssY(g.priceEventToRow(price)), 6);
    }
    expect(priceTickPositions(g, DIMS.cssH)).toEqual(labels.map((l) => l.pos));
  });

  it('keeps the venue-tick decimals at a six-digit price, so a narrow gutter never prints duplicate ticks', () => {
    // 123456.00 / .25 / .50 / .75 with a 7-character limit: rounding to whole
    // dollars printed 123456 twice and 123457 twice.
    const g = gm({ p0: 123456, step: 0.25, tick: 0.25 }, 4);
    const labels = priceAxisModel(g, DIMS.cssH, 42).map((l) => l.label);
    expect(labels.length).toBeGreaterThan(2);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/^\d{6}\.\d{2}$/);
  });

  it('uses the venue tick as the decimal floor when the grid step is coarser', () => {
    // Grid step 1 (grouped) over a 0.25 venue tick still labels whole quarters.
    const g = new GridMap({ ...VIEW, rowScale: 8 }, DIMS, TIME, { p0: 5230, step: 1, tick: 0.25 });
    const labels = priceAxisModel(g, DIMS.cssH);
    for (const l of labels) expect(l.label).toMatch(/^\d+\.\d{2}$/);
  });

  it('prints a 0.025-tick ladder with three decimals (both axis and GEX share the venue tick)', () => {
    // Grid step 0.025 and venue tick 0.025: quoteDecimals gives 3, whatever the axis step is.
    const g = new GridMap({ ...VIEW, rowScale: 8 }, DIMS, TIME, { p0: 5230, step: 0.025, tick: 0.025 });
    const labels = priceAxisModel(g, DIMS.cssH);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.label).toMatch(/^\d+\.\d{3}$/);
  });
});

describe('time-axis clock', () => {
  it('keeps the session-relative T+ clock when no clock is given', () => {
    expect(timeAxisLabelFormatter(1_000_000_000n, null)(3_000_000_000n)).toBe('00:00:03');
  });

  it('reads wall time in the chosen zone when a clock is given', () => {
    // Epoch 0 is 00:00 UTC on 1 Jan 1970, which is 19:00 the evening before in New York.
    expect(timeAxisLabelFormatter(1_000_000_000n, { pref: 'utc', exchangeZone: 'America/New_York' })(0n)).toBe('00:00:00');
    expect(timeAxisLabelFormatter(1_000_000_000n, { pref: 'exchange', exchangeZone: 'America/New_York' })(0n)).toBe('19:00:00');
  });

  it('adds milliseconds on a sub-second step, as the session clock does', () => {
    expect(timeAxisLabelFormatter(250_000_000n, { pref: 'utc', exchangeZone: 'UTC' })(1_500_000_000n)).toBe('00:00:01.500');
  });
});
