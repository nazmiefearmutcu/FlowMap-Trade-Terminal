/**
 * Where the market map's detail card sits. A pointer hover places the card just
 * off the pointer, so it never covers the tile under the cursor; keyboard focus
 * places it beside the focused tile. Both flip to the other side when the body
 * edge would cut them off, and clamp inside the body.
 */

import type { Rect } from './treemap';

/** Width and height the detail card is laid out in. */
export const CARD_W_PX = 220;
export const CARD_H_PX = 132;
/** Distance from the pointer to the card. */
export const POINTER_GAP_PX = 14;
/** Distance from a focused tile to the card. */
export const TILE_GAP_PX = 8;

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  w: number;
  h: number;
}

export interface CardPosition {
  left: number;
  top: number;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

/** The card's top-left corner for a pointer at `pointer`, in body coordinates. */
export function pointerCardPosition(pointer: Point, bounds: Bounds): CardPosition {
  let left = pointer.x + POINTER_GAP_PX;
  if (left + CARD_W_PX > bounds.w) left = pointer.x - POINTER_GAP_PX - CARD_W_PX;
  let top = pointer.y + POINTER_GAP_PX;
  if (top + CARD_H_PX > bounds.h) top = pointer.y - POINTER_GAP_PX - CARD_H_PX;
  return {
    left: Math.round(clamp(left, bounds.w - CARD_W_PX)),
    top: Math.round(clamp(top, bounds.h - CARD_H_PX)),
  };
}

/** The card's top-left corner beside a focused tile's rectangle. */
export function tileCardPosition(rect: Rect, bounds: Bounds): CardPosition {
  let left = rect.x + rect.w + TILE_GAP_PX;
  if (left + CARD_W_PX > bounds.w) left = rect.x - CARD_W_PX - TILE_GAP_PX;
  return {
    left: Math.round(clamp(left, bounds.w - CARD_W_PX)),
    top: Math.round(clamp(rect.y, bounds.h - CARD_H_PX)),
  };
}
