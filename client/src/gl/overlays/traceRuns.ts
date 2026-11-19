import type { Pt } from '../textLayer';
import { slotColToTsNs, type TimeMap } from './coords';

interface TimedPoint extends Pt {
  col: number;
  xCol: number;
  t0?: bigint;
}

/** Adjacent sequence slots may still straddle an offline timestamp gap. */
export function traceRuns<T extends TimedPoint>(points: readonly T[], time?: TimeMap | null, restoredBreaks: readonly number[] = []): T[][] {
  const runs: T[][] = [];
  let previous = -Infinity;
  let previousX = -Infinity;
  let previousTime: bigint | null = null;
  const sourceBreaks = time?.traceBreaks;
  const breaks = restoredBreaks.length ? [...(sourceBreaks ?? []), ...restoredBreaks].sort((a, b) => a - b) : sourceBreaks;
  let nextBreak = 0;
  const minute = 60_000_000_000n;
  const maxStep = BigInt(Math.max(2_000_000_000, Math.ceil((time?.dtNs ?? 0) * 1.5)));
  for (const point of points) {
    const t0 = point.t0 ?? (time?.slots ? slotColToTsNs(time.slots, point.col) : null);
    let crossedBreak = false;
    while (breaks && nextBreak < breaks.length && breaks[nextBreak] <= point.xCol) {
      if (breaks[nextBreak] > previousX) crossedBreak = true;
      nextBreak++;
    }
    const step = t0 !== null && previousTime !== null ? t0 - previousTime : 0n;
    // Restored candle columns are clock-aligned and form their own cadence.
    const minuteStep = t0 !== null && step === minute && t0 % minute === 0n;
    const brokenClock = step < 0n || (sourceBreaks === undefined && step > maxStep && !minuteStep);
    if (point.col !== previous + 1 || crossedBreak || brokenClock) {
      runs.push([]);
    }
    runs[runs.length - 1].push(point);
    previous = point.col;
    previousX = point.xCol;
    previousTime = t0;
  }
  return runs;
}
