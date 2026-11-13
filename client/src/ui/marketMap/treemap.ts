/**
 * Squarified treemap layout (Bruls, Huizing and van Wijk, "Squarified Treemaps").
 * The market map sizes each tile by its market cap, so the layout is two levels: groups
 * (sectors) share the full area, and each group's items share the group's rectangle below
 * its header strip. Pure geometry with no DOM and no rounding: the caller rounds when it draws.
 */

export interface TreemapItem {
  id: string;
  value: number;
}

export interface TreemapGroup {
  id: string;
  items: readonly TreemapItem[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapTile {
  id: string;
  rect: Rect;
}

export interface TreemapGroupLayout {
  id: string;
  /** The whole group, header included. */
  rect: Rect;
  /** The strip at the top of the group that carries its name. Height 0 when the group is too small for one. */
  header: Rect;
  tiles: TreemapTile[];
}

export interface TreemapOptions {
  /** Height of each group's header strip in px. Default 18. */
  headerHeight?: number;
  /** Space left empty between neighbouring groups, in px. Default 2. */
  groupGap?: number;
  /** Space left empty between neighbouring tiles, in px. Default 1. */
  tileGap?: number;
}

/** A group narrower than this gets no header, whatever its height. */
const MIN_HEADER_WIDTH = 40;

/** Only finite values above zero take up space. */
function isWeight(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Largest value first, ties broken by id ascending so the output does not depend on input order. */
function compareItems(a: TreemapItem, b: TreemapItem): number {
  if (a.value !== b.value) return b.value - a.value;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Worst aspect ratio of the row `areas[start..end)` when laid along a side of length `side`.
 * The row is sorted descending, so its first entry is the largest and its last the smallest.
 */
function worstRatio(areas: readonly number[], start: number, end: number, side: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += areas[i];
  const largest = areas[start];
  const smallest = areas[end - 1];
  if (side <= 0 || sum <= 0 || smallest <= 0) return Number.POSITIVE_INFINITY;
  const s2 = side * side;
  const total2 = sum * sum;
  return Math.max((s2 * largest) / total2, total2 / (s2 * smallest));
}

/**
 * Places the row `areas[start..end)` against one side of `rect` and returns what is left.
 * The row lies along the shorter side: a column when the rectangle is wider than it is tall,
 * a strip otherwise. Rectangles go into `out` at the index each area came from.
 */
function placeRow(
  areas: readonly number[],
  start: number,
  end: number,
  order: readonly number[],
  rect: Rect,
  out: Rect[],
): Rect {
  let sum = 0;
  for (let i = start; i < end; i++) sum += areas[i];

  if (rect.w >= rect.h) {
    const columnWidth = rect.h > 0 ? sum / rect.h : 0;
    let y = rect.y;
    for (let i = start; i < end; i++) {
      const h = columnWidth > 0 ? areas[i] / columnWidth : 0;
      out[order[i]] = { x: rect.x, y, w: columnWidth, h };
      y += h;
    }
    return {
      x: rect.x + columnWidth,
      y: rect.y,
      w: Math.max(0, rect.w - columnWidth),
      h: rect.h,
    };
  }

  const rowHeight = rect.w > 0 ? sum / rect.w : 0;
  let x = rect.x;
  for (let i = start; i < end; i++) {
    const w = rowHeight > 0 ? areas[i] / rowHeight : 0;
    out[order[i]] = { x, y: rect.y, w, h: rowHeight };
    x += w;
  }
  return {
    x: rect.x,
    y: rect.y + rowHeight,
    w: rect.w,
    h: Math.max(0, rect.h - rowHeight),
  };
}

/** One level of squarify: rectangles for `values` inside `bounds`, in the order of `values`. */
export function squarify(values: readonly number[], bounds: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: bounds.x, y: bounds.y, w: 0, h: 0 }));
  const width = Math.max(0, bounds.w);
  const height = Math.max(0, bounds.h);

  const order: number[] = [];
  let total = 0;
  values.forEach((value, i) => {
    if (isWeight(value)) {
      order.push(i);
      total += value;
    }
  });
  if (order.length === 0 || total <= 0 || width <= 0 || height <= 0) return out;

  order.sort((i, j) => values[j] - values[i] || i - j);
  const scale = (width * height) / total;
  const areas = order.map((i) => values[i] * scale);

  let rect: Rect = { x: bounds.x, y: bounds.y, w: width, h: height };
  let rowStart = 0;
  for (let k = 0; k < areas.length; k++) {
    if (k > rowStart) {
      const side = Math.min(rect.w, rect.h);
      const withNext = worstRatio(areas, rowStart, k + 1, side);
      const without = worstRatio(areas, rowStart, k, side);
      if (withNext > without) {
        rect = placeRow(areas, rowStart, k, order, rect, out);
        rowStart = k;
      }
    }
  }
  placeRow(areas, rowStart, areas.length, order, rect, out);
  return out;
}

/** Shrinks a rectangle by half of `gap` on each side, so neighbours in a layout end up `gap` apart. */
function inset(r: Rect, gap: number): Rect {
  const half = gap / 2;
  return {
    x: r.x + half,
    y: r.y + half,
    w: Math.max(0, r.w - gap),
    h: Math.max(0, r.h - gap),
  };
}

/**
 * Lays out sector groups as a squarified treemap. Each group gets a header strip at its top
 * and its items as tiles below it. Groups and tiles come out largest first.
 */
export function layoutTreemap(
  groups: readonly TreemapGroup[],
  width: number,
  height: number,
  options: TreemapOptions = {},
): TreemapGroupLayout[] {
  const headerHeight = Math.max(0, options.headerHeight ?? 18);
  const groupGap = Math.max(0, options.groupGap ?? 2);
  const tileGap = Math.max(0, options.tileGap ?? 1);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];

  const prepared: { id: string; value: number; items: TreemapItem[] }[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => isWeight(item.value)).sort(compareItems);
    if (items.length === 0) continue;
    const value = items.reduce((sum, item) => sum + item.value, 0);
    prepared.push({ id: group.id, value, items });
  }
  if (prepared.length === 0) return [];

  prepared.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const groupRects = squarify(
    prepared.map((group) => group.value),
    { x: 0, y: 0, w: width, h: height },
  );

  return prepared.map((group, g) => {
    const rect = inset(groupRects[g], groupGap);
    const headerH = rect.w < MIN_HEADER_WIDTH || rect.h < 2 * headerHeight ? 0 : headerHeight;
    const header: Rect = { x: rect.x, y: rect.y, w: rect.w, h: headerH };
    const body: Rect = { x: rect.x, y: rect.y + headerH, w: rect.w, h: Math.max(0, rect.h - headerH) };

    const tileRects = squarify(
      group.items.map((item) => item.value),
      body,
    );
    const tiles: TreemapTile[] = group.items.map((item, i) => ({
      id: item.id,
      rect: inset(tileRects[i], tileGap),
    }));
    return { id: group.id, rect, header, tiles };
  });
}
