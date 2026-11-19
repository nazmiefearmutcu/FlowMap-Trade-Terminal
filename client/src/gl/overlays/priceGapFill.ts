import { sidecarFetch } from '../../net/serverBase';
import type { ClockGap } from '../gapProjection';
import type { Pt } from '../textLayer';
import type { GridMap } from './coords';

const MS_NS = 1_000_000n;
const RETRY_MS = 20_000;
const CACHE_SIZE = 48;
const MAX_REQUESTS = 3;
const PROJECTED_GAP_NS = 90_000_000_000n;
type Close = [timeMs: number, price: number];
type CacheEntry = { points: Close[] | null; stepMs?: number; retryAt: number; controller?: AbortController };

export interface PricePoint extends Pt {
  t0?: bigint;
  xCol: number;
}

/** A provider hole must stay a hole. Endpoints come from recorded price. */
export function coveringCloses(raw: unknown, start: number, end: number): Close[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const { step_ms: step, points } = raw as { step_ms?: number; points?: unknown[] };
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 1 || !Array.isArray(points) || points.length > 1000) return [];
  const closes: Close[] = [];
  let prior = start;
  for (const value of points) {
    if (!Array.isArray(value) || value.length !== 2) return [];
    const [at, price] = value;
    if (!Number.isSafeInteger(at) || at <= prior || at >= end || at - prior > step
      || !Number.isFinite(price) || price <= 0) return [];
    closes.push([at, price]);
    prior = at;
  }
  // Boundaries can fall between exchange milliseconds and the grid's ns clock.
  return end - prior <= step + 1 ? closes : [];
}

export class PriceGapFill {
  private symbol = '';
  private readonly cache = new Map<string, CacheEntry>();

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    for (const entry of this.cache.values()) entry.controller?.abort();
    this.cache.clear();
    this.symbol = symbol;
  }

  /** Start verified exchange history before the archive is put on screen. */
  warm(gaps: readonly ClockGap[], changed: () => void): boolean {
    let ready = true;
    for (const gap of gaps) {
      const entry = this.entry(gap.leftNs, gap.rightNs, changed);
      if (!entry || entry.controller) ready = false;
    }
    return ready;
  }

  hasCloses(gap: ClockGap): boolean {
    return Boolean(this.cache.get(gapKey(gap.leftNs, gap.rightNs))?.points?.length);
  }

  priceRange(gaps: readonly ClockGap[], from: bigint, to: bigint): { low: number; high: number } | null {
    const start = Number(from / MS_NS);
    const end = Number(to / MS_NS);
    let low = Infinity;
    let high = -Infinity;
    for (const gap of gaps) {
      if (gap.rightNs < from || gap.leftNs > to) continue;
      const points = this.cache.get(gapKey(gap.leftNs, gap.rightNs))?.points;
      if (!points) continue;
      for (const [at, price] of points) {
        if (at < start || at > end) continue;
        low = Math.min(low, price);
        high = Math.max(high, price);
      }
    }
    return low <= high ? { low, high } : null;
  }

  /** The chart can be zoomed inside a gap, with neither recorded endpoint visible. */
  gapPath(gm: GridMap, gap: ClockGap, changed?: () => void): Pt[] | null {
    const points = this.entry(gap.leftNs, gap.rightNs, changed)?.points;
    if (!points?.length) return null;
    const projectedX = gapTimeProjection(gm, gap);
    return points.map(([at, price]) => ({
      x: projectedX?.(BigInt(at) * MS_NS) ?? gm.cssX(gm.tsToCol(BigInt(at) * MS_NS)),
      y: gm.cssY(gm.priceEventToRow(price)),
    }));
  }

  path(gm: GridMap, left: PricePoint, right: PricePoint, changed?: () => void): Pt[] | null {
    if (this.symbol === '' || left.t0 === undefined || right.t0 === undefined
      || right.t0 - left.t0 < 2_000_000_000n || left.x >= right.x
      || right.x < 0 || left.x > gm.dims.cssW) return null;
    const gaps = gm.time?.priceGaps?.filter(gap => gap.right > left.xCol && gap.left < right.xCol);
    // The closing price of a forming overview bucket moves. The archive
    // boundaries stay fixed as later trades in the bucket arrive.
    if (gaps && gaps.length > 1) return null; // cover each archive seam on its own clock
    const gap = gaps?.[0];
    if (gap && (left.xCol > gap.left || right.xCol < gap.right)) return null;
    if (!gap && (gm.time?.traceBreaks !== undefined || right.t0 - left.t0 >= PROJECTED_GAP_NS)) return null;
    const entry = this.entry(gap?.leftNs ?? left.t0, gap?.rightNs ?? right.t0, changed);
    const points = entry?.points;
    if (!points?.length) return null;
    const stepNs = BigInt(entry?.stepMs ?? 1) * MS_NS;
    const firstNs = BigInt(points[0][0]) * MS_NS;
    const lastNs = BigInt(points[points.length - 1][0]) * MS_NS;
    // An adjacent coarse bucket can close hours before a seam it shares.
    // Its endpoint cannot be joined to a candle series that does not reach it.
    if (firstNs < left.t0 || firstNs - left.t0 > stepNs
      || lastNs > right.t0 || right.t0 - lastNs > stepNs) return null;

    // Both traces share the same actual clock knots. Preserve the half-slot
    // centring used by recorded closes without moving either endpoint.
    const fromCol = gm.tsToCol(left.t0);
    const toCol = gm.tsToCol(right.t0);
    const projectedX = gap ? gapTimeProjection(gm, gap) : null;
    const path: Pt[] = [left];
    for (const [at, price] of points) {
      const col = gm.tsToCol(BigInt(at) * MS_NS);
      const fraction = Number(BigInt(at) * MS_NS - left.t0) / Number(right.t0 - left.t0);
      const centredCol = gap ? col : col + (left.xCol - fromCol) * (1 - fraction) + (right.xCol - toCol) * fraction;
      const mapped = projectedX?.(BigInt(at) * MS_NS) ?? gm.cssX(centredCol);
      if (mapped < path[path.length - 1].x - 1 || mapped > right.x + 1) return null;
      const x = Math.min(right.x, Math.max(path[path.length - 1].x, mapped));
      path.push({ x, y: gm.cssY(gm.priceEventToRow(price)) });
    }
    const edgeTolerance = Math.max(4, 2 * (right.x - left.x) / (points.length + 1));
    if (gap && (path[1].x - left.x > edgeTolerance || right.x - path[path.length - 1].x > edgeTolerance)) return null;
    path.push(right);
    return path;
  }

  private entry(from: bigint, to: bigint, changed?: () => void): CacheEntry | undefined {
    if (!this.symbol || to - from < 2_000_000_000n) return undefined;
    const start = Number(from / MS_NS);
    const end = Number(to / MS_NS);
    const key = gapKey(from, to);
    const cached = this.cache.get(key);
    if (!cached || (cached.points === null && !cached.controller && cached.retryAt <= Date.now())) {
      this.request(key, start, end, changed);
    }
    return this.cache.get(key);
  }

  private request(key: string, start: number, end: number, changed?: () => void): void {
    if ([...this.cache.values()].filter(entry => entry.controller !== undefined).length >= MAX_REQUESTS) return;
    for (const [old, entry] of this.cache) {
      if (this.cache.size < CACHE_SIZE) break;
      if (!entry.controller) this.cache.delete(old);
    }
    const controller = new AbortController();
    const entry: CacheEntry = { points: null, retryAt: Infinity, controller };
    this.cache.set(key, entry);
    const timeout = setTimeout(() => controller.abort(), 9_000);
    void sidecarFetch(`/api/price-history/${encodeURIComponent(this.symbol)}?start_ms=${start}&end_ms=${end}`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Price history unavailable');
        return response.json();
      })
      .then(value => {
        entry.points = coveringCloses(value, start, end);
        if (entry.points.length > 0) entry.stepMs = (value as { step_ms: number }).step_ms;
      })
      .catch(() => { entry.retryAt = Date.now() + RETRY_MS; })
      .finally(() => {
        clearTimeout(timeout);
        entry.controller = undefined;
        if (this.cache.get(key) === entry) changed?.();
      });
  }
}

function gapKey(from: bigint, to: bigint): string {
  return `${from / MS_NS}:${to / MS_NS}`;
}

/** Recorder buckets can omit or compress knots during an outage. Within a
 * projected gap, the two recorded boundary times own the candle's x position. */
function gapTimeProjection(gm: GridMap, gap: ClockGap): ((at: bigint) => number) | null {
  const elapsed = gap.rightNs - gap.leftNs;
  if (elapsed < PROJECTED_GAP_NS) return null;
  const left = gm.cssX(gap.left);
  const width = gm.cssX(gap.right) - left;
  return at => left + Number(at - gap.leftNs) / Number(elapsed) * width;
}
