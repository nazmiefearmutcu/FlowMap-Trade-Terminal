/**
 * Time source for the GL pipeline's deferred work: the normalizer's settle and
 * retry timers and the view worker's time slicing. Production code gets
 * {@link systemClock}; tests pass a {@link createManualClock} so a merge that
 * waits "150 ms" waits exactly that much fake time, never on machine load.
 */
export interface GlClock {
  /** Monotonic milliseconds (performance.now()). */
  now(): number;
  /** Run `callback` once after `delayMs`; returns a handle for {@link clearTimer}. */
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Yield one macrotask so input and paint run between work slices. */
  yieldToEventLoop(): Promise<void>;
}

export const systemClock: GlClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  yieldToEventLoop: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
};

/** A {@link GlClock} whose time moves only when {@link ManualClock.advance} is called. */
interface ManualClock extends GlClock {
  advance(ms: number): void;
  /** Timers that have not fired yet. */
  pending(): number;
}

export function createManualClock(start = 0): ManualClock {
  let time = start;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => time,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { due: time + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(handle) { timers.delete(handle as number); },
    yieldToEventLoop: () => Promise.resolve(),
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > time || !timers.delete(id)) continue;
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}
