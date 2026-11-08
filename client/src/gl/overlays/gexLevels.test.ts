import { describe, expect, it } from 'vitest';
import { BADGE_PITCH_PX, GexOverlay, stackBadgeY } from './gexLevels';
import { t } from '../../i18n';
import type { OverlayFrame } from './frame';
import { MsgType, type GexLevelUpdate } from '../../proto/types';

function makeFrame() {
  const lineCalls: Array<{ y: number; color: readonly [number, number, number, number] }> = [];
  const textCalls: Array<{ x: number; y: number; text: string }> = [];
  const gm = {
    price: { p0: 100, step: 0.5 },
    dims: { cssW: 1000, cssH: 800 },
    priceToRow: (p: number) => (p - 100) / 0.5,
    // A nonlinear event projection distinct from affine priceToRow.
    priceEventToRow: (p: number) => Math.log2(p / 100) * 100,
    clipY: (row: number) => row / 800,
    cssY: (row: number) => 800 - row,
  };
  const frame = {
    gm,
    solid: {
      begin() {},
      addThickLine(_x0: number, y0: number, _x1: number, _y1: number, _width: number, color: readonly [number, number, number, number]) {
        lineCalls.push({ y: y0, color });
      },
      flush() {},
    },
    text: {
      text(x: number, y: number, text: string) {
        textCalls.push({ x, y, text });
      },
      badge(x: number, y: number, text: string) {
        textCalls.push({ x, y, text });
      },
    },
  } as unknown as OverlayFrame;

  return { frame, lineCalls, textCalls };
}

describe('stackBadgeY', () => {
  it('keeps anchors that already clear the pitch where they are', () => {
    expect(stackBadgeY([100, 130, 200], 12, 0, 400)).toEqual([100, 130, 200]);
  });

  it('pushes a crowded anchor down to the pitch, preserving order', () => {
    expect(stackBadgeY([100, 101, 102], 12, 0, 400)).toEqual([100, 112, 124]);
  });

  it('anchors to the bottom edge and pushes up when the stack would overflow', () => {
    const out = stackBadgeY([395, 396, 397], 12, 0, 400);
    expect(out).toEqual([376, 388, 400]);
  });

  it('returns an empty list for no anchors', () => {
    expect(stackBadgeY([], 12, 0, 400)).toEqual([]);
  });
});

describe('GexOverlay (FLOW <GO>)', () => {
  it('initializes empty and draws nothing when unset', () => {
    const overlay = new GexOverlay();
    expect(overlay.get()).toBeNull();
    const { frame, lineCalls, textCalls } = makeFrame();
    overlay.draw(frame);
    expect(lineCalls.length).toBe(0);
    expect(textCalls.length).toBe(0);
  });

  it('draws Call Wall, Put Wall, and Gamma Flip when set', () => {
    const overlay = new GexOverlay();
    const sample: GexLevelUpdate = {
      type: MsgType.GEX_UPDATE,
      symbol: 'SPY',
      spot_price: 500,
      net_gex: 1250000000,
      call_wall: 510,
      put_wall: 490,
      gamma_flip: 498,
    };
    overlay.set(sample);
    expect(overlay.get()).toEqual(sample);

    const { frame, lineCalls, textCalls } = makeFrame();
    overlay.draw(frame);

    // A contrast halo and a core line per level.
    expect(lineCalls.length).toBe(6);
    expect(textCalls.length).toBe(3);
    expect(textCalls.some((c) => c.text.includes(t('gl.gexCallWall')))).toBe(true);
    expect(textCalls.some((c) => c.text.includes(t('gl.gexPutWall')))).toBe(true);
    expect(textCalls.some((c) => c.text.includes(t('gl.gexGammaFlip')))).toBe(true);
    // Badge and GL line must use the same projected row, not the affine row.
    const callRow = Math.log2(sample.call_wall / 100) * 100;
    expect(lineCalls[0].y).toBeCloseTo(callRow / 800);
    expect(textCalls[0].y).toBeCloseTo(800 - callRow);
  });

  it('spreads badges that would overprint, but keeps every line on its true row', () => {
    const overlay = new GexOverlay();
    // 510 / 490 / 498 on this grid land within 6 css px of each other.
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'SPY',
      spot_price: 500,
      net_gex: 1250000000,
      call_wall: 510,
      put_wall: 490,
      gamma_flip: 498,
    });
    const { frame, lineCalls, textCalls } = makeFrame();
    overlay.draw(frame);

    // Lines: one per level, at the projected row (clipY = row / 800 in this fixture).
    const trueYs = [510, 490, 498].map((p) => Math.log2(p / 100) * 100 / 800);
    // A halo and a core line per level, all on the projected row; the cores are the odd entries.
    expect(lineCalls.length).toBe(6);
    lineCalls.forEach((c, i) => expect(c.y).toBeCloseTo(trueYs[Math.floor(i / 2)]));
    // Badges: strictly at least the pitch apart, in order of their rows.
    const badgeYs = textCalls.map((c) => c.y).sort((a, b) => a - b);
    for (let i = 1; i < badgeYs.length; i++) {
      expect(badgeYs[i] - badgeYs[i - 1]).toBeGreaterThanOrEqual(BADGE_PITCH_PX - 1e-9);
    }
  });

  it('leaves a single badge exactly on its row', () => {
    const overlay = new GexOverlay();
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'AAPL',
      spot_price: 220,
      net_gex: 5000000,
      call_wall: 225,
      put_wall: 0,
      gamma_flip: 0,
    });
    const { frame, textCalls } = makeFrame();
    overlay.draw(frame);
    expect(textCalls.length).toBe(1);
    expect(textCalls[0].y).toBeCloseTo(800 - Math.log2(2.25) * 100);
  });

  it('clears state on reset()', () => {
    const overlay = new GexOverlay();
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'NVDA',
      spot_price: 130,
      net_gex: 8500000,
      call_wall: 135,
      put_wall: 120,
      gamma_flip: 128,
    });
    overlay.reset();
    expect(overlay.get()).toBeNull();
  });

  it('prints a quarter-tick wall at two decimals, never step-rounded', () => {
    const overlay = new GexOverlay();
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'ES',
      spot_price: 5234,
      net_gex: 1,
      call_wall: 5234.25,
      put_wall: 5230.75,
      gamma_flip: 5232,
    });
    const { frame, textCalls } = makeFrame();
    // Grid step 0.25 with the venue tick 0.25: the old step-derived precision printed '5234.3'.
    (frame.gm as unknown as { price: { p0: number; step: number; tick: number } }).price = { p0: 100, step: 0.25, tick: 0.25 };
    overlay.draw(frame);
    expect(textCalls.some((t) => t.text.endsWith('5234.25'))).toBe(true);
    expect(textCalls.some((t) => t.text.endsWith('5230.75'))).toBe(true);
    expect(textCalls.some((t) => t.text.endsWith('5234.3'))).toBe(false);
  });
});
