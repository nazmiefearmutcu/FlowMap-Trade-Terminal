import { describe, expect, it } from 'vitest';

import {
  CARD_H_PX,
  CARD_W_PX,
  POINTER_GAP_PX,
  TILE_GAP_PX,
  pointerCardPosition,
  tileCardPosition,
} from './marketMapCard';

const BODY = { w: 800, h: 500 };

describe('pointerCardPosition', () => {
  it('sits to the lower right of the pointer by the gap', () => {
    expect(pointerCardPosition({ x: 100, y: 50 }, BODY)).toEqual({
      left: 100 + POINTER_GAP_PX,
      top: 50 + POINTER_GAP_PX,
    });
  });

  it('flips to the left of the pointer at the right edge', () => {
    const at = pointerCardPosition({ x: 790, y: 50 }, BODY);
    expect(at.left).toBe(790 - POINTER_GAP_PX - CARD_W_PX);
    expect(at.top).toBe(50 + POINTER_GAP_PX);
  });

  it('flips above the pointer at the bottom edge', () => {
    const at = pointerCardPosition({ x: 100, y: 490 }, BODY);
    expect(at.top).toBe(490 - POINTER_GAP_PX - CARD_H_PX);
    expect(at.left).toBe(100 + POINTER_GAP_PX);
  });

  it('flips both ways in the corner and never leaves the body', () => {
    const at = pointerCardPosition({ x: 799, y: 499 }, BODY);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.left + CARD_W_PX).toBeLessThanOrEqual(BODY.w);
    expect(at.top + CARD_H_PX).toBeLessThanOrEqual(BODY.h);
  });

  it('clamps inside a body narrower than the card', () => {
    const at = pointerCardPosition({ x: 10, y: 10 }, { w: 100, h: 100 });
    expect(at.left).toBe(0);
    expect(at.top).toBe(0);
  });
});

describe('tileCardPosition', () => {
  it('sits to the right of a focused tile', () => {
    const at = tileCardPosition({ x: 0, y: 40, w: 200, h: 100 }, BODY);
    expect(at).toEqual({ left: 200 + TILE_GAP_PX, top: 40 });
  });

  it('flips to the left of a tile at the right edge', () => {
    const at = tileCardPosition({ x: 600, y: 40, w: 200, h: 100 }, BODY);
    expect(at.left).toBe(600 - CARD_W_PX - TILE_GAP_PX);
  });

  it('keeps the card inside the bottom edge', () => {
    const at = tileCardPosition({ x: 0, y: 450, w: 100, h: 50 }, BODY);
    expect(at.top).toBe(BODY.h - CARD_H_PX);
  });
});
