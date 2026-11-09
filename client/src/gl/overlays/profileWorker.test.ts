import { afterEach, describe, expect, it, vi } from 'vitest';

import { GridMap } from './coords';
import type { OverlayFrame } from './frame';
import { Profile } from './profile';
import type { PriceScale } from '../priceScale';
import { createManualClock } from '../clock';
import { ViewWorker } from '../viewWorker';
import type { ViewResult } from '../viewWorkerEngine';

// The profile worker is kept across view changes,
// the held profile stays on screen while the view moves, and a failed worker is
// retried after a backoff instead of leaving the profile failed until the next pan.

/** A spy handle: only the call record is read here. */
interface Spy {
  mock: { calls: unknown[][] };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const scale: PriceScale = { kind: 'linear', rows: 8, p0: 0, step: 1 };
const dims = { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 };

function frameAt(colOffset: number, changed: () => void): OverlayFrame {
  const gm = new GridMap({ colOffset, colScale: 3, rowOffset: 0, rowScale: 8 }, dims, null, { p0: 0, step: 1, scale });
  return {
    gm,
    resident: { oldest: 0, newest: 9 },
    dataVersion: 1,
    changed,
    columnArrays: () => ({ bid: new Float32Array(8).fill(1), ask: null }),
    solid: { begin: () => {}, addRect: () => {}, flush: () => {} },
    text: { badge: () => {} },
  } as unknown as OverlayFrame;
}

let clock = createManualClock(1000);

/** Move the injected clock to absolute time `time` (timers due by then fire). */
function at(time: number): void {
  clock.advance(time - clock.now());
}

function result(): ViewResult {
  return { bins: Float64Array.from([1, 1, 1, 9, 1, 1, 1, 1]), total: 16, columns: 3, missing: 0, sampled: false };
}

describe('profile worker lifecycle', () => {
  let pending: Pending[] = [];
  let run: Spy;
  let dispose: Spy;

  afterEach(() => {
    vi.restoreAllMocks();
    pending = [];
    clock = createManualClock(1000);
  });

  function mockWorker(): void {
    run = vi.spyOn(ViewWorker.prototype, 'run').mockImplementation(function (this: ViewWorker) {
      this.busy = true;
      return new Promise((resolve, reject) => {
        pending.push({
          resolve: (value) => { this.busy = false; resolve(value as ViewResult); },
          reject: (error) => { this.busy = false; reject(error); },
        });
      });
    });
    dispose = vi.spyOn(ViewWorker.prototype, 'dispose');
  }

  it('a pan neither disposes the worker nor blanks the held profile, and the new window waits for the view to settle', async () => {
    mockWorker();
    const changed = vi.fn();
    const profile = new Profile({ maxCols: 2 }, clock);
    profile.draw(frameAt(0, changed));
    expect(run).toHaveBeenCalledTimes(1);
    pending[0].resolve(result());
    await vi.waitFor(() => expect(profile.calculationState).toBe('ready'));
    profile.draw(frameAt(0, changed));
    expect(profile.last?.max).toBe(9);

    at(2000); // the view moves
    profile.draw(frameAt(1, changed));
    expect(dispose).not.toHaveBeenCalled();
    expect(profile.last?.max).toBe(9); // held while moving
    expect(run).toHaveBeenCalledTimes(1);

    at(2050); // still inside the settle period
    profile.draw(frameAt(1, changed));
    expect(run).toHaveBeenCalledTimes(1);

    at(2200); // settled
    profile.draw(frameAt(1, changed));
    expect(run).toHaveBeenCalledTimes(2);
    profile.dispose();
  });

  it('a failed worker is dropped and retried after a backoff, not left failed until the view moves', async () => {
    mockWorker();
    const changed = vi.fn();
    const profile = new Profile({ maxCols: 2 }, clock);
    profile.draw(frameAt(0, changed));
    pending[0].reject(new Error('boom'));
    await vi.waitFor(() => expect(profile.calculationState).toBe('failed'));
    expect(dispose).toHaveBeenCalledTimes(1);

    at(1500); // inside the 2 s backoff
    profile.draw(frameAt(0, changed));
    expect(run).toHaveBeenCalledTimes(1);

    at(3100); // backoff elapsed on a static view
    profile.draw(frameAt(0, changed));
    expect(run).toHaveBeenCalledTimes(2);
    pending[1].resolve(result());
    await vi.waitFor(() => expect(profile.calculationState).toBe('ready'));
    profile.draw(frameAt(0, changed));
    expect(profile.last?.max).toBe(9);
    profile.dispose();
  });

  it('a new data version gets a fresh retry budget once the retries of the old one are spent', async () => {
    mockWorker();
    const changed = vi.fn();
    const profile = new Profile({ maxCols: 2 }, clock);
    profile.draw({ ...frameAt(0, changed), dataVersion: 1 });
    pending[0].reject(new Error('boom'));
    await vi.waitFor(() => expect(profile.calculationState).toBe('failed'));

    (profile as unknown as { failures: number }).failures = 99; // retries of version 1 are spent
    at(10_000); // past any backoff
    profile.draw({ ...frameAt(0, changed), dataVersion: 1 });
    expect(run).toHaveBeenCalledTimes(1); // still exhausted for this version

    profile.draw({ ...frameAt(0, changed), dataVersion: 2 });
    expect(run).toHaveBeenCalledTimes(2); // new data, new budget
    profile.dispose();
  });

  it('a within-budget profile is reused while the window and frame version are unchanged', () => {
    const changed = vi.fn();
    const profile = new Profile();
    const columnArrays = vi.fn(() => ({ bid: new Float32Array(8).fill(1), ask: null }));
    const frame = { ...frameAt(0, changed), columnArrays } as unknown as OverlayFrame;
    profile.draw(frame);
    const reads = columnArrays.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    profile.draw(frame);
    expect(columnArrays.mock.calls.length).toBe(reads);
    profile.draw({ ...frame, dataVersion: 2 } as OverlayFrame);
    expect(columnArrays.mock.calls.length).toBeGreaterThan(reads);
  });

  it('a stream of new data under a held profile starts at most one run per settle period', async () => {
    mockWorker();
    const changed = vi.fn();
    const profile = new Profile({ maxCols: 2 }, clock);
    profile.draw(frameAt(0, changed));
    pending[0].resolve(result());
    await vi.waitFor(() => expect(profile.calculationState).toBe('ready'));
    profile.draw(frameAt(0, changed));

    at(1050); // new data under the same window, inside the settle period
    profile.draw({ ...frameAt(0, changed), dataVersion: 2 } as OverlayFrame);
    expect(run).toHaveBeenCalledTimes(1);

    at(1140);
    profile.draw({ ...frameAt(0, changed), dataVersion: 3 } as OverlayFrame);
    expect(run).toHaveBeenCalledTimes(1);

    at(1150); // one settle period after the last run started
    profile.draw({ ...frameAt(0, changed), dataVersion: 3 } as OverlayFrame);
    expect(run).toHaveBeenCalledTimes(2);
    profile.dispose();
  });
});
