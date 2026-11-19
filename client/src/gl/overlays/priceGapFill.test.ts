import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridMap } from './coords';
import { coveringCloses, PriceGapFill } from './priceGapFill';
import { visiblePriceBridges } from './priceLine';
import { traceRuns } from './traceRuns';

const closes = [[1_999, 110], [2_999, 105], [3_999, 112]];

afterEach(() => vi.unstubAllGlobals());

describe('price history across a recording break', () => {
  it('prioritises the widest visible break and bounds requests in dense archive views', () => {
    const points = Array.from({ length: 24 }, (_, i) =>
      [{ x: i * 6, y: 50, xCol: i, t0: BigInt(i) * 3_000_000_000n }]);
    points.unshift([{ x: -2, y: 50, xCol: -1, t0: -3_000_000_000n }]);
    points.push([{ x: 240, y: 50, xCol: 24, t0: 72_000_000_000n }]);
    const candidates = visiblePriceBridges(points, 200);
    expect(candidates).toHaveLength(16);
    expect(candidates[0]).toMatchObject({ visibleWidth: 62, right: { x: 240 } });
    expect(candidates.every(gap => gap.left.x >= 0)).toBe(true);
  });

  it('requests a short restart break but joins clock-aligned minute closes', () => {
    const points = [1_000_000_000n, 60_000_000_000n, 120_000_000_000n].map((t0, col) => ({ col, t0, x: col, y: col, xCol: col }));
    expect(traceRuns(points).map(run => run.length)).toEqual([1, 2]);
    expect(traceRuns(points, { anchorSeq: 0, anchorT0Ns: 1_000_000_000n, dtNs: 1_000_000_000 },
      [1.5]).map(run => run.length)).toEqual([1, 1, 1]);
  });

  it('requires real, contiguous closes between the two recorded prices', () => {
    expect(coveringCloses({ step_ms: 1000, points: closes }, 1000, 4000)).toEqual(closes);
    expect(coveringCloses({ step_ms: 1000, points: [closes[0], closes[2]] }, 1000, 4000)).toEqual([]);
    expect(coveringCloses({ step_ms: 1000, points: closes }, 1000, 5500)).toEqual([]);
  });

  it('fills the same gap once, with candle prices on the chart clock and untouched endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ step_ms: 1000, points: closes }) });
    vi.stubGlobal('fetch', fetcher);
    const fill = new PriceGapFill();
    fill.setSymbol('BTCUSDT');
    const gm = new GridMap(
      { colOffset: 0, colScale: 2, rowOffset: 0, rowScale: 100 },
      { cssW: 200, cssH: 200, drawW: 200, drawH: 200 },
      { anchorSeq: 0, anchorT0Ns: 1_000_000_000n, dtNs: 3_000_000_000,
        priceGaps: [{ left: .25, right: 1.2, leftNs: 1_000_000_000n, rightNs: 4_000_000_000n, minuteRun: true }] },
      { p0: 90, step: 1 },
    );
    const left = { x: 25, y: 170, xCol: .25, t0: 1_000_000_000n };
    const right = { x: 125, y: 150, xCol: 1.25, t0: 4_000_000_000n };
    const changed = vi.fn();
    expect(fill.path(gm, left, right, changed)).toBeNull();
    expect(fill.path(gm, left, right)).toBeNull();
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledOnce(); });
    expect(fetcher).toHaveBeenCalledOnce();
    const path = fill.path(gm, left, right)!;
    expect(path[0]).toBe(left);
    expect(path[4]).toBe(right);
    expect(path[1].x).toBeCloseTo(33.3);
    expect(path[1].y).toBeCloseTo(gm.cssY(gm.priceEventToRow(110)));
    expect(fill.path(gm, left, { ...right, t0: 4_500_000_000n })).toHaveLength(5);
    expect(fill.path(gm, { ...left, t0: 0n }, right)).toBeNull();
    expect(fill.path(gm, left, { ...right, t0: 9_000_000_000n })).toBeNull();
    expect(fill.path(gm, { ...left, x: 50, xCol: .5 }, right)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    fill.setSymbol('ETHUSDT');
    expect(fill.path(gm, left, right)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('warms exchange closes before the archive draws and can render them without recorded endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ step_ms: 1000, points: closes }) });
    vi.stubGlobal('fetch', fetcher);
    const gap = { left: 0, right: 3, leftNs: 1_000_000_000n, rightNs: 4_000_000_000n };
    const gm = new GridMap(
      { colOffset: .5, colScale: 2, rowOffset: 0, rowScale: 100 },
      { cssW: 200, cssH: 200, drawW: 200, drawH: 200 },
      { anchorSeq: 0, anchorT0Ns: gap.leftNs, dtNs: 1_000_000_000 },
      { p0: 90, step: 1 },
    );
    const fill = new PriceGapFill();
    fill.setSymbol('BTCUSDT');
    const changed = vi.fn();
    expect(fill.warm([gap], changed)).toBe(false);
    expect(fill.hasCloses(gap)).toBe(false);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(fill.warm([gap], changed)).toBe(true);
    expect(fill.hasCloses(gap)).toBe(true);
    expect(fill.priceRange([gap], 1_500_000_000n, 4_000_000_000n)).toEqual({ low: 105, high: 112 });
    expect(fill.priceRange([gap], 2_000_000_000n, 3_000_000_000n)).toEqual({ low: 105, high: 105 });
    expect(fill.gapPath(gm, gap)).toEqual(closes.map(([at, price]) => ({
      x: gm.cssX(gm.tsToCol(BigInt(at) * 1_000_000n)), y: gm.cssY(gm.priceEventToRow(price)),
    })));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('spreads every recovered candle across the real time of a long, compressed outage', async () => {
    const minute = 60_000;
    const candles = Array.from({ length: 5 }, (_, i) => [(i + 1) * minute - 1, 110 + i]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ step_ms: minute, points: candles }) }));
    const gap = { left: 1, right: 3, leftNs: 0n, rightNs: 300_000_000_000n };
    const gm = new GridMap(
      { colOffset: 0, colScale: 4, rowOffset: 0, rowScale: 100 },
      { cssW: 200, cssH: 200, drawW: 200, drawH: 200 },
      { anchorSeq: 4, anchorT0Ns: 300_250_000_000n, dtNs: 250_000_000 },
      { p0: 90, step: 1 },
    );
    const fill = new PriceGapFill();
    fill.setSymbol('ETHUSDT');
    const refreshed = vi.fn();
    expect(fill.warm([gap], refreshed)).toBe(false);
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(fill.gapPath(gm, gap)?.map(point => Math.round(point.x))).toEqual([70, 90, 110, 130, 150]);
  });
});
