import type { HeatmapView } from './heatmapMath';
import { chartColumn, chartTimestamp, type TimeMap, type TimeSlots } from './overlays/coords';

export interface ClockGap {
  left: number;
  right: number;
  leftNs: bigint;
  rightNs: bigint;
  minuteRun?: boolean;
}

interface Segment {
  from: number;
  to: number;
  x0: number;
  x1: number;
  empty: boolean;
  gapNs?: number;
  clock?: { start: bigint; duration: number };
}

export interface GapProjection {
  readonly segments: readonly Segment[];
  fractionAt(col: number): number;
  columnAt(fraction: number): number;
  emptyAt(fraction: number): boolean;
}

export type ChartView = HeatmapView & { timeProjection?: GapProjection };

const MIN_GAP_NS = 90e9;
const MINUTE_NS = 60_000_000_000n;

function minuteStep(gap: ClockGap): boolean {
  return gap.leftNs % MINUTE_NS === 0n && gap.rightNs - gap.leftNs === MINUTE_NS;
}

/** On the Binance quarter-second stream, consecutive aligned minute slots
 * are restored prices. Keep their whole no-book interval on the clock. */
export function mergeRestoredMinutes(ordered: readonly ClockGap[]): ClockGap[] {
  const spans: ClockGap[] = [];
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    let minutes = Number(minuteStep(ordered[start]));
    while (end < ordered.length && ordered[end - 1].rightNs === ordered[end].leftNs) {
      minutes += Number(minuteStep(ordered[end++]));
    }
    if (minutes >= 2) {
      const first = ordered[start];
      const last = ordered[end - 1];
      spans.push({ ...first, right: last.right, rightNs: last.rightNs, minuteRun: true });
    } else {
      for (let i = start; i < end; i++) if (!minuteStep(ordered[i])) spans.push(ordered[i]);
    }
    start = end;
  }
  return spans;
}

/** Give each outage a clock knot after the last recorded sample's centre. */
export function recordingClock(slots: TimeSlots, dtNs: number, restoredMinutes = false): { slots: TimeSlots; gaps: ClockGap[] } {
  const gaps: ClockGap[] = [];
  const knots: ClockGap[] = [];
  const { t0, startSeq, stride = 1 } = slots;
  for (let i = 1; i < t0.length; i++) {
    const elapsed = t0[i] - t0[i - 1];
    const isLong = elapsed > Math.max(MIN_GAP_NS, 2 * dtNs);
    if (!Number.isFinite(elapsed) || (!isLong && !(restoredMinutes && elapsed === Number(MINUTE_NS)))) continue;
    const right = startSeq + i * stride;
    const gap = { left: right - stride / 2, right, leftNs: BigInt(t0[i - 1]), rightNs: BigInt(t0[i]) };
    if (isLong) knots.push(gap);
    if (isLong || minuteStep(gap)) gaps.push(gap);
  }
  const joined = restoredMinutes ? mergeRestoredMinutes(gaps) : gaps;
  if (!knots.length) return { slots, gaps: joined };

  const times = new Float64Array(t0.length + knots.length);
  const cols = new Float64Array(times.length);
  let gapIndex = 0;
  for (let i = 0; i < t0.length; i++) {
    const col = startSeq + i * stride;
    const gap = knots[gapIndex];
    if (gap?.right === col) {
      times[i + gapIndex] = Number(gap.leftNs) + dtNs / 2;
      cols[i + gapIndex] = gap.left;
      gapIndex++;
    }
    times[i + gapIndex] = t0[i];
    cols[i + gapIndex] = col;
  }
  return { slots: { startSeq, t0: times, cols }, gaps: joined };
}

/** Expand the longest visible clock gaps without stretching recorded depth. */
export function gapProjection(view: HeatmapView, gaps: readonly ClockGap[], dtNs: number, quoteStartX?: number, time?: TimeMap): GapProjection | undefined {
  const left = view.colOffset;
  const right = left + view.colScale;
  const dataFraction = quoteStartX === undefined ? 1 : (quoteStartX + 1) / 2;
  const dataRight = left + view.colScale * dataFraction;
  const visible = gaps.flatMap(gap => {
    const from = Math.max(left, gap.left);
    const to = Math.min(dataRight, gap.right);
    const duration = Number(gap.rightNs - gap.leftNs);
    if (to <= from || duration <= MIN_GAP_NS) return [];
    const start = gap.minuteRun && time ? chartTimestamp(time, from) : null;
    const clockDuration = start !== null && time ? Number(chartTimestamp(time, to) - start) : 0;
    const clock = start !== null && clockDuration > 0 ? { start, duration: clockDuration } : undefined;
    return [{ from, to, duration: clock?.duration ?? duration * (to - from) / (gap.right - gap.left), gapNs: duration, clock }];
  }).sort((a, b) => b.duration - a.duration).slice(0, 4).sort((a, b) => a.from - b.from);
  if (!visible.length) return undefined;

  const totalGap = visible.reduce((sum, gap) => sum + gap.duration, 0);
  const dataSpan = dataRight - left;
  const extra = Math.min(dataSpan, totalGap / dtNs);
  const scale = dataFraction / (dataSpan + extra);
  const segments: Segment[] = [];
  let col = left;
  let x = 0;
  const add = (to: number, width: number, gapNs?: number, clock?: Segment['clock']): void => {
    if (to <= col) return;
    segments.push({ from: col, to, x0: x, x1: x + width, empty: gapNs !== undefined, gapNs, clock });
    col = to;
    x += width;
  };
  for (const gap of visible) {
    add(gap.from, (gap.from - col) * scale);
    add(gap.to, (gap.to - gap.from + extra * gap.duration / totalGap) * scale, gap.gapNs, gap.clock);
  }
  add(dataRight, (dataRight - col) * scale);
  add(right, 1 - dataFraction);
  const last = segments[segments.length - 1];
  const byColumn = (value: number): Segment => segments.find(segment => value <= segment.to) ?? last;
  const byFraction = (value: number): Segment => segments.find(segment => value <= segment.x1) ?? last;
  return {
    segments,
    fractionAt(value) {
      const s = byColumn(value);
      const local = s.clock && time
        ? Number(chartTimestamp(time, value) - s.clock.start) / s.clock.duration
        : (value - s.from) / (s.to - s.from);
      return s.x0 + local * (s.x1 - s.x0);
    },
    columnAt(value) {
      const s = byFraction(value);
      const local = (value - s.x0) / (s.x1 - s.x0);
      return s.clock && time
        ? chartColumn(time, s.clock.start + BigInt(Math.round(local * s.clock.duration)))
        : s.from + local * (s.to - s.from);
    },
    emptyAt: value => byFraction(value).empty,
  };
}

/** Draw depth with the same piecewise x-coordinate used for price and probes. */
export function drawProjectedDepth(gl: WebGL2RenderingContext, view: ChartView, draw: (view: HeatmapView) => void): void {
  if (!view.timeProjection) {
    draw(view);
    return;
  }
  gl.enable(gl.SCISSOR_TEST);
  try {
    for (const { from, to, x0, x1, empty } of view.timeProjection.segments) {
      const start = Math.round(x0 * gl.drawingBufferWidth);
      const end = Math.round(x1 * gl.drawingBufferWidth);
      if (end <= start) continue;
      gl.scissor(start, 0, end - start, gl.drawingBufferHeight);
      const span = (to - from) / (x1 - x0);
      draw({ ...view, colOffset: empty ? -2 : from - x0 * span, colScale: empty ? 1 : span });
    }
  } finally {
    gl.disable(gl.SCISSOR_TEST);
  }
}
