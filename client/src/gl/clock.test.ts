import { describe, expect, it } from 'vitest';

import { createManualClock, systemClock } from './clock';

describe('manual clock', () => {
  it('moves only when advanced and fires due timers in order', () => {
    const clock = createManualClock(10);
    const fired: string[] = [];
    clock.setTimer(() => fired.push('late'), 20);
    clock.setTimer(() => fired.push('early'), 5);
    expect(clock.now()).toBe(10);
    expect(clock.pending()).toBe(2);
    clock.advance(5);
    expect(fired).toEqual(['early']);
    clock.advance(14);
    expect(fired).toEqual(['early']);
    clock.advance(1);
    expect(fired).toEqual(['early', 'late']);
    expect(clock.pending()).toBe(0);
  });

  it('clearTimer cancels a timer before it fires', () => {
    const clock = createManualClock();
    let fired = false;
    const handle = clock.setTimer(() => { fired = true; }, 1);
    clock.clearTimer(handle);
    clock.advance(10);
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('the system clock reads performance.now()', () => {
    const before = performance.now();
    const read = systemClock.now();
    expect(read).toBeGreaterThanOrEqual(before);
  });
});
