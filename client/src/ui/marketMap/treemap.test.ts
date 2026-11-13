import { describe, expect, it } from 'vitest';

import { layoutTreemap, squarify, type Rect, type TreemapGroup, type TreemapGroupLayout } from './treemap';

const PAPER_VALUES = [6, 6, 4, 3, 2, 2, 1];
const PAPER_BOUNDS: Rect = { x: 0, y: 0, w: 6, h: 4 };

function area(r: Rect): number {
  return r.w * r.h;
}

function inside(r: Rect, b: Rect, eps = 1e-9): boolean {
  return (
    r.x >= b.x - eps &&
    r.y >= b.y - eps &&
    r.x + r.w <= b.x + b.w + eps &&
    r.y + r.h <= b.y + b.h + eps
  );
}

/** Overlap area of two rectangles; zero when they only touch. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Distance between two rectangles that do not overlap, measured along the axis where they are apart. */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
  return Math.max(dx, dy);
}

function aspect(r: Rect): number {
  const long = Math.max(r.w, r.h);
  const short = Math.min(r.w, r.h);
  return long / short;
}

function groupOf(id: string, layouts: TreemapGroupLayout[]): TreemapGroupLayout {
  const found = layouts.find((g) => g.id === id);
  if (!found) throw new Error(`no group ${id}`);
  return found;
}

describe('squarify', () => {
  it('a single value fills the bounds exactly', () => {
    const bounds: Rect = { x: 3, y: 5, w: 10, h: 4 };
    const [rect] = squarify([7], bounds);
    expect(rect.x).toBeCloseTo(3, 9);
    expect(rect.y).toBeCloseTo(5, 9);
    expect(rect.w).toBeCloseTo(10, 9);
    expect(rect.h).toBeCloseTo(4, 9);
  });

  it('gives each rectangle an area proportional to its value, tiling the bounds', () => {
    const rects = squarify(PAPER_VALUES, PAPER_BOUNDS);
    const total = PAPER_VALUES.reduce((s, v) => s + v, 0);
    expect(total).toBe(24);

    rects.forEach((r, i) => {
      expect(area(r)).toBeCloseTo((PAPER_VALUES[i] / total) * 24, 9);
      expect(inside(r, PAPER_BOUNDS)).toBe(true);
    });

    const sumArea = rects.reduce((s, r) => s + area(r), 0);
    expect(sumArea).toBeCloseTo(24, 9);

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlapArea(rects[i], rects[j])).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('keeps every aspect ratio at most 3 on the paper example', () => {
    const rects = squarify(PAPER_VALUES, PAPER_BOUNDS);
    for (const r of rects) {
      expect(aspect(r)).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it('returns rectangles in the input order, not the sorted order', () => {
    const values = [1, 5, 2, 8, 3];
    const bounds: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const rects = squarify(values, bounds);
    const total = values.reduce((s, v) => s + v, 0);
    rects.forEach((r, i) => {
      expect(area(r)).toBeCloseTo((values[i] / total) * 100, 9);
    });
  });
});

describe('layoutTreemap', () => {
  const noGaps = { groupGap: 0, tileGap: 0, headerHeight: 0 };

  it('skips values that are zero, negative, NaN or infinite, and drops groups left empty', () => {
    const groups: TreemapGroup[] = [
      {
        id: 'tech',
        items: [
          { id: 'A', value: 10 },
          { id: 'B', value: 0 },
          { id: 'C', value: -4 },
          { id: 'D', value: Number.NaN },
          { id: 'E', value: Number.POSITIVE_INFINITY },
        ],
      },
      {
        id: 'empty',
        items: [
          { id: 'X', value: 0 },
          { id: 'Y', value: -1 },
        ],
      },
    ];
    const layouts = layoutTreemap(groups, 100, 100, noGaps);
    expect(layouts.map((g) => g.id)).toEqual(['tech']);
    expect(layouts[0].tiles.map((t) => t.id)).toEqual(['A']);
  });

  it('returns an empty array for no groups or non-positive bounds', () => {
    const groups: TreemapGroup[] = [{ id: 'g', items: [{ id: 'a', value: 1 }] }];
    expect(layoutTreemap([], 100, 100)).toEqual([]);
    expect(layoutTreemap(groups, 0, 100)).toEqual([]);
    expect(layoutTreemap(groups, 100, -1)).toEqual([]);
  });

  it('makes group areas proportional to group sums when gaps and headers are zero', () => {
    const groups: TreemapGroup[] = [
      { id: 'a', items: [{ id: 'a1', value: 3 }, { id: 'a2', value: 1 }] },
      { id: 'b', items: [{ id: 'b1', value: 2 }] },
      { id: 'c', items: [{ id: 'c1', value: 2 }, { id: 'c2', value: 2 }] },
    ];
    const W = 200;
    const H = 120;
    const layouts = layoutTreemap(groups, W, H, noGaps);
    const sums: Record<string, number> = { a: 4, b: 2, c: 4 };
    for (const g of layouts) {
      expect(area(g.rect)).toBeCloseTo((sums[g.id] / 10) * W * H, 6);
    }
  });

  it('keeps each tile inside its group, below the header, and the header is the top strip', () => {
    const groups: TreemapGroup[] = [
      {
        id: 'semis',
        items: [
          { id: 'NVDA', value: 50 },
          { id: 'AMD', value: 20 },
          { id: 'INTC', value: 5 },
          { id: 'QCOM', value: 4 },
        ],
      },
      {
        id: 'banks',
        items: [
          { id: 'JPM', value: 30 },
          { id: 'BAC', value: 12 },
        ],
      },
    ];
    const layouts = layoutTreemap(groups, 800, 500, { headerHeight: 18 });
    for (const g of layouts) {
      expect(g.header.y).toBeCloseTo(g.rect.y, 9);
      expect(g.header.h).toBe(18);
      expect(g.header.x).toBeCloseTo(g.rect.x, 9);
      expect(g.header.w).toBeCloseTo(g.rect.w, 9);
      for (const t of g.tiles) {
        expect(inside(t.rect, g.rect)).toBe(true);
        expect(t.rect.y).toBeGreaterThanOrEqual(g.header.y + g.header.h - 1e-9);
      }
    }
  });

  it('gives a group under twice the header height, or under 40 px wide, a header of height 0', () => {
    const groups: TreemapGroup[] = [
      { id: 'big', items: [{ id: 'b', value: 3 }] },
      { id: 'small', items: [{ id: 's', value: 1 }] },
    ];
    // The small group ends up 250 x 30 here, so its height is under 2 * 18.
    const flat = layoutTreemap(groups, 1000, 30, { groupGap: 0, tileGap: 0, headerHeight: 18 });
    expect(groupOf('small', flat).rect.h).toBeLessThan(36);
    expect(groupOf('small', flat).header.h).toBe(0);
    expect(groupOf('small', flat).tiles[0].rect).toEqual(groupOf('small', flat).rect);

    // Two equal groups in 30 x 400: each is 30 wide, under 40 px.
    const narrow = layoutTreemap(
      [
        { id: 'p', items: [{ id: 'p1', value: 1 }] },
        { id: 'q', items: [{ id: 'q1', value: 1 }] },
      ],
      30,
      400,
      { groupGap: 0, tileGap: 0, headerHeight: 18 },
    );
    for (const g of narrow) {
      expect(g.rect.w).toBeLessThan(40);
      expect(g.header.h).toBe(0);
    }
  });

  it('leaves at least tileGap px between adjacent tiles, with no negative size', () => {
    const groups: TreemapGroup[] = [
      {
        id: 'g',
        items: [
          { id: 'a', value: 9 },
          { id: 'b', value: 6 },
          { id: 'c', value: 4 },
          { id: 'd', value: 2 },
          { id: 'e', value: 1 },
        ],
      },
    ];
    const layouts = layoutTreemap(groups, 300, 200, { tileGap: 2, groupGap: 0, headerHeight: 0 });
    const tiles = layouts[0].tiles;
    for (const t of tiles) {
      expect(t.rect.w).toBeGreaterThanOrEqual(0);
      expect(t.rect.h).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i].rect;
        const b = tiles[j].rect;
        expect(overlapArea(a, b)).toBeLessThanOrEqual(1e-9);
        expect(gap(a, b)).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
  });

  it('separates neighbouring groups by groupGap', () => {
    const groups: TreemapGroup[] = [
      { id: 'x', items: [{ id: 'x1', value: 5 }] },
      { id: 'y', items: [{ id: 'y1', value: 5 }] },
    ];
    const layouts = layoutTreemap(groups, 200, 100, { groupGap: 4, tileGap: 0, headerHeight: 0 });
    const [a, b] = layouts;
    expect(gap(a.rect, b.rect)).toBeGreaterThanOrEqual(4 - 1e-9);
    for (const g of layouts) {
      expect(g.rect.w).toBeGreaterThanOrEqual(0);
      expect(g.rect.h).toBeGreaterThanOrEqual(0);
    }
  });

  it('orders groups by value descending and tiles by value descending, ties by id ascending', () => {
    const groups: TreemapGroup[] = [
      { id: 'small', items: [{ id: 'z', value: 1 }] },
      {
        id: 'big',
        items: [
          { id: 'q', value: 5 },
          { id: 'p', value: 5 },
          { id: 'r', value: 9 },
        ],
      },
    ];
    const layouts = layoutTreemap(groups, 400, 300, noGaps);
    expect(layouts.map((g) => g.id)).toEqual(['big', 'small']);
    expect(layouts[0].tiles.map((t) => t.id)).toEqual(['r', 'p', 'q']);
  });

  it('gives the same output for the same input in a different order', () => {
    const groups: TreemapGroup[] = [
      {
        id: 'alpha',
        items: [
          { id: 'A1', value: 7 },
          { id: 'A2', value: 3 },
          { id: 'A3', value: 3 },
        ],
      },
      { id: 'beta', items: [{ id: 'B1', value: 4 }, { id: 'B2', value: 8 }] },
      { id: 'gamma', items: [{ id: 'G1', value: 4 }] },
    ];
    const reordered: TreemapGroup[] = [
      { id: 'gamma', items: [{ id: 'G1', value: 4 }] },
      { id: 'beta', items: [{ id: 'B2', value: 8 }, { id: 'B1', value: 4 }] },
      {
        id: 'alpha',
        items: [
          { id: 'A3', value: 3 },
          { id: 'A1', value: 7 },
          { id: 'A2', value: 3 },
        ],
      },
    ];
    const first = JSON.stringify(layoutTreemap(groups, 640, 360));
    const second = JSON.stringify(layoutTreemap(reordered, 640, 360));
    expect(second).toBe(first);
  });

  it('lays out 500 items across 11 groups in under 50 ms without overlaps inside a group', () => {
    const groups: TreemapGroup[] = [];
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let g = 0; g < 11; g++) {
      const items: { id: string; value: number }[] = [];
      const n = Math.floor(500 / 11) + (g < 500 % 11 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        items.push({ id: `g${g}-i${i}`, value: 1 + Math.floor(rand() * 1000) });
      }
      groups.push({ id: `sector-${g}`, items });
    }
    const count = groups.reduce((s, g) => s + g.items.length, 0);
    expect(count).toBe(500);

    const started = performance.now();
    const layouts = layoutTreemap(groups, 1600, 900);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect(layouts).toHaveLength(11);

    for (const g of layouts) {
      const tiles = g.tiles;
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(overlapArea(tiles[i].rect, tiles[j].rect)).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });
});
