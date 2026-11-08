/**
 * Fixed-size rolling accumulator behind the SMA / Bollinger kernels — the
 * streaming twin of the reference implementation's rolling-window passes.
 *
 * Tracks `sum`/`sumsq` over the trailing `period` values in O(1) per step.
 * NaN policy matches the reference library: NaN never touches the
 * accumulators (adding it would poison `sum − NaN` long after eviction); it is
 * counted instead, and any NaN inside the window makes the output an honest
 * null until it has fully exited.
 *
 * `add(v, commit)` returns the POST-insertion stats; with `commit=false` the
 * identical arithmetic runs on temps (the kernels' peek path) and no state
 * moves. In a full ring, `head` always addresses the oldest element — the next
 * write slot IS the eviction slot.
 */

export interface RollingStats {
  sum: number;
  sumsq: number;
  /** NaNs currently inside the window. */
  nan: number;
  /** Whether `period` values are resident. */
  full: boolean;
}

export interface RollingSum {
  add(v: number, commit: boolean): RollingStats;
  reset(): void;
}

/**
 * Committed pushes between exact recomputations of sum/sumsq. Incremental
 * add/subtract drifts by rounding error over a long session, and sigma comes
 * from E[x²] − E[x]²; a periodic resync keeps the drift bounded.
 */
const RESYNC_PERIODS = 64;

export function createRolling(period: number): RollingSum {
  const buf = new Float64Array(period);
  const resyncEvery = period * RESYNC_PERIODS;
  let head = 0;
  let count = 0;
  let sum = 0;
  let sumsq = 0;
  let nan = 0;
  let pushes = 0;

  /** Recompute sum/sumsq from the resident values (the first `count` slots). */
  const resync = (): void => {
    let s = 0;
    let q = 0;
    for (let i = 0; i < count; i += 1) {
      const x = buf[i];
      if (!Number.isNaN(x)) {
        s += x;
        q += x * x;
      }
    }
    sum = s;
    sumsq = q;
  };

  return {
    add(v, commit) {
      let s = sum;
      let q = sumsq;
      let n = nan;
      let c = count;
      if (c === period) {
        const evict = buf[head];
        if (Number.isNaN(evict)) {
          n -= 1;
        } else {
          s -= evict;
          q -= evict * evict;
        }
      } else {
        c += 1;
      }
      if (Number.isNaN(v)) {
        n += 1;
      } else {
        s += v;
        q += v * v;
      }
      if (commit) {
        buf[head] = v;
        head = (head + 1) % period;
        sum = s;
        sumsq = q;
        nan = n;
        count = c;
        pushes += 1;
        if (pushes >= resyncEvery) {
          pushes = 0;
          resync();
          return { sum, sumsq, nan, full: c === period };
        }
      }
      return { sum: s, sumsq: q, nan: n, full: c === period };
    },

    reset() {
      buf.fill(0);
      head = 0;
      count = 0;
      sum = 0;
      sumsq = 0;
      nan = 0;
      pushes = 0;
    },
  };
}
