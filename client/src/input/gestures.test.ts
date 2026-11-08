/**
 * Canvas gesture routing (input/gestures.ts). Pinned here: the keyboard surface
 * owns only BARE keys — a chord (Ctrl+R / ⌘F / Ctrl+P / Ctrl-K) must reach the
 * browser and the app-level router untouched — and a drag dies when its pointer
 * is lost (moves with no button held), not just on a clean pointerup.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachGestures, type CameraController } from './gestures';
import { setSingleKeyShortcutsEnabled } from './shortcutPrefs';

function makeController(): CameraController {
  return {
    panByPixels: vi.fn(),
    zoomTimeAtFraction: vi.fn(),
    zoomPriceAtFraction: vi.fn(),
    scalePriceCentered: vi.fn(),
    panTimeSteps: vi.fn(),
    panPriceSteps: vi.fn(),
    zoomTimeCentered: vi.fn(),
    toggleFollow: vi.fn(),
    togglePriceFollow: vi.fn(),
    setPriceFollow: vi.fn(),
    setFollowTime: vi.fn(),
    goLive: vi.fn(),
  };
}

/** A KeyboardEvent plus a preventDefault spy (jsdom supports the real type). */
function keyEvent(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; repeat?: boolean } = {},
): {
  event: KeyboardEvent;
  prevented: ReturnType<typeof vi.fn>;
} {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    bubbles: true,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    repeat: mods.repeat ?? false,
  });
  const prevented = vi.fn();
  event.preventDefault = prevented as unknown as () => void;
  return { event, prevented };
}

/** jsdom has no PointerEvent constructor — a property-bearing Event satisfies the handlers. */
function pointerEvent(
  type: string,
  opts: { x?: number; y?: number; buttons?: number; button?: number; pointerId?: number } = {},
): PointerEvent {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: opts.pointerId ?? 1,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    button: opts.button ?? 0,
    buttons: opts.buttons ?? 1,
  });
  return e as unknown as PointerEvent;
}

describe('attachGestures keyboard — modifier guard', () => {
  it('does NOT consume Ctrl+R (browser reload must survive chart focus)', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);
    const { event, prevented } = keyEvent('r', { ctrl: true });
    canvas.dispatchEvent(event);
    expect(prevented).not.toHaveBeenCalled();
    expect(ctrl.goLive).not.toHaveBeenCalled();
    dispose();
  });

  it('does NOT consume ⌘F / Ctrl+F / Ctrl+P / Ctrl-K (browser + app chords pass through)', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);
    for (const [key, mods] of [
      ['f', { meta: true }],
      ['f', { ctrl: true }],
      ['p', { ctrl: true }],
      ['k', { ctrl: true }],
      ['k', { meta: true }],
    ] as const) {
      const { event, prevented } = keyEvent(key, mods);
      canvas.dispatchEvent(event);
      expect(prevented, `${mods.ctrl ? 'Ctrl' : '⌘'}+${key}`).not.toHaveBeenCalled();
    }
    expect(ctrl.toggleFollow).not.toHaveBeenCalled();
    dispose();
  });

  it('bare chart keys still work and are still consumed', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    const left = keyEvent('ArrowLeft');
    canvas.dispatchEvent(left.event);
    expect(ctrl.panTimeSteps).toHaveBeenCalledWith(-1);
    expect(left.prevented).toHaveBeenCalledOnce();

    const r = keyEvent('r');
    canvas.dispatchEvent(r.event);
    expect(ctrl.goLive).toHaveBeenCalledOnce();
    expect(r.prevented).toHaveBeenCalledOnce();

    // Shift+P re-fits the price axis.
    const bigP = keyEvent('P', { shift: true });
    canvas.dispatchEvent(bigP.event);
    expect(ctrl.setPriceFollow).toHaveBeenCalledWith('fit');
    expect(bigP.prevented).toHaveBeenCalledOnce();

    // CapsLock 'P' arrives without Shift and must only toggle follow.
    vi.mocked(ctrl.setPriceFollow).mockClear();
    const capsP = keyEvent('P');
    canvas.dispatchEvent(capsP.event);
    expect(ctrl.togglePriceFollow).toHaveBeenCalledOnce();
    expect(ctrl.setPriceFollow).not.toHaveBeenCalled();

    // Held F/P/R do not toggle again on auto-repeat, but are still consumed.
    vi.mocked(ctrl.toggleFollow).mockClear();
    const heldF = keyEvent('f', { repeat: true });
    canvas.dispatchEvent(heldF.event);
    expect(ctrl.toggleFollow).not.toHaveBeenCalled();
    expect(heldF.prevented).toHaveBeenCalledOnce();

    // Held arrows keep panning: that is the point of auto-repeat.
    const heldLeft = keyEvent('ArrowLeft', { repeat: true });
    canvas.dispatchEvent(heldLeft.event);
    expect(ctrl.panTimeSteps).toHaveBeenCalledWith(-1);
    dispose();
  });
});

describe('attachGestures keyboard — price zoom without a pointer', () => {
  it('] zooms price in and [ zooms price out, both about the viewport centre', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    const zoomIn = keyEvent(']');
    canvas.dispatchEvent(zoomIn.event);
    expect(ctrl.zoomPriceAtFraction).toHaveBeenLastCalledWith(0.8, 0.5);
    expect(zoomIn.prevented).toHaveBeenCalledOnce();

    const zoomOut = keyEvent('[');
    canvas.dispatchEvent(zoomOut.event);
    expect(ctrl.zoomPriceAtFraction).toHaveBeenLastCalledWith(1.25, 0.5);
    expect(zoomOut.prevented).toHaveBeenCalledOnce();

    // Price zoom is the only effect: the time axis and the follow policy stay put.
    expect(ctrl.zoomTimeCentered).not.toHaveBeenCalled();
    expect(ctrl.togglePriceFollow).not.toHaveBeenCalled();
    dispose();
  });

  it('Shift+ArrowUp and Shift+ArrowDown zoom price, and still work with the single-key switch off', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);
    const up = keyEvent('ArrowUp', { shift: true });
    canvas.dispatchEvent(up.event);
    expect(ctrl.zoomPriceAtFraction).toHaveBeenLastCalledWith(0.8, 0.5);
    expect(up.prevented).toHaveBeenCalledOnce();
    const down = keyEvent('ArrowDown', { shift: true });
    canvas.dispatchEvent(down.event);
    expect(ctrl.zoomPriceAtFraction).toHaveBeenLastCalledWith(1.25, 0.5);
    expect(ctrl.panPriceSteps).not.toHaveBeenCalled();
    setSingleKeyShortcutsEnabled(false);
    try {
      vi.mocked(ctrl.zoomPriceAtFraction).mockClear();
      canvas.dispatchEvent(keyEvent('ArrowUp', { shift: true }).event);
      expect(ctrl.zoomPriceAtFraction).toHaveBeenLastCalledWith(0.8, 0.5);
      canvas.dispatchEvent(keyEvent('ArrowUp').event);
      expect(ctrl.panPriceSteps).toHaveBeenCalledWith(1);
    } finally {
      setSingleKeyShortcutsEnabled(true);
    }
    dispose();
  });

  it('a chorded bracket is left to the browser and the app router', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);
    const { event, prevented } = keyEvent(']', { ctrl: true });
    canvas.dispatchEvent(event);
    expect(prevented).not.toHaveBeenCalled();
    expect(ctrl.zoomPriceAtFraction).not.toHaveBeenCalled();
    dispose();
  });
});

describe('attachGestures keyboard — Shift+P with CapsLock', () => {
  it('Shift+P auto-fits and bare P toggles, whichever case the key reports', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    // Plain Shift+P reports 'P'; Shift+P under CapsLock reports 'p'. Both carry the Shift flag.
    canvas.dispatchEvent(keyEvent('P', { shift: true }).event);
    canvas.dispatchEvent(keyEvent('p', { shift: true }).event);
    expect(ctrl.setPriceFollow).toHaveBeenCalledTimes(2);
    expect(ctrl.setPriceFollow).toHaveBeenNthCalledWith(1, 'fit');
    expect(ctrl.setPriceFollow).toHaveBeenNthCalledWith(2, 'fit');

    // CapsLock alone reports 'P' with no Shift flag: a plain toggle.
    canvas.dispatchEvent(keyEvent('P').event);
    canvas.dispatchEvent(keyEvent('p').event);
    expect(ctrl.togglePriceFollow).toHaveBeenCalledTimes(2);
    dispose();
  });
});

describe('attachGestures keyboard — single-key switch', () => {
  afterEach(() => setSingleKeyShortcutsEnabled(true));

  it('leaves every character key to the page while the switch is off, and keeps the arrows', () => {
    setSingleKeyShortcutsEnabled(false);
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    for (const [key, mods] of [
      ['f', {}], ['F', {}], ['p', {}], ['P', {}], ['P', { shift: true }], ['r', {}], ['R', {}],
      ['+', {}], ['-', {}], ['=', {}], ['_', {}], [']', {}], ['[', {}],
    ] as const) {
      const { event, prevented } = keyEvent(key, mods);
      canvas.dispatchEvent(event);
      expect(prevented, key).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(ctrl)) expect(fn).not.toHaveBeenCalled();

    const left = keyEvent('ArrowLeft');
    canvas.dispatchEvent(left.event);
    expect(ctrl.panTimeSteps).toHaveBeenCalledWith(-1);
    expect(left.prevented).toHaveBeenCalledOnce();
    dispose();
  });

  it('acts on the character keys again once the switch is back on', () => {
    setSingleKeyShortcutsEnabled(false);
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);
    setSingleKeyShortcutsEnabled(true);

    const r = keyEvent('r');
    canvas.dispatchEvent(r.event);
    expect(ctrl.goLive).toHaveBeenCalledOnce();
    expect(r.prevented).toHaveBeenCalledOnce();
    dispose();
  });
});

describe('attachGestures drag — lost pointer ends the drag', () => {
  it('pans while the button is held and stops cold once moves report buttons=0', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0 }));
    // 20px travel crosses the 6px release threshold → buffered delta applies.
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 0 }));
    expect(ctrl.panByPixels).toHaveBeenCalledTimes(1);

    // The pointerup was lost (e.g. released outside the window): moves keep
    // arriving with NO button held. The drag must end, not pan.
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 40, y: 0, buttons: 0 }));
    expect(ctrl.panByPixels).toHaveBeenCalledTimes(1);

    // And the dead drag stays dead — a later move pan must not resurrect it.
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 60, y: 0, buttons: 1 }));
    expect(ctrl.panByPixels).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('still ends cleanly on a real pointerup of the owning pointer', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0 }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 30, y: 0, buttons: 0 }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 60, y: 0 }));
    expect(ctrl.panByPixels).not.toHaveBeenCalled();
    dispose();
  });

  it('ignores moves and ups from a foreign pointer id', () => {
    const canvas = document.createElement('canvas');
    const ctrl = makeController();
    const dispose = attachGestures(canvas, ctrl);

    canvas.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, x: 0, y: 0 }));
    // A second pointer moving must not steal or end the active drag.
    canvas.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, x: 50, y: 0 }));
    canvas.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, buttons: 0 }));
    canvas.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, x: 20, y: 0 }));
    expect(ctrl.panByPixels).toHaveBeenCalledTimes(1); // only the id-7 drag move
    dispose();
  });
});
