/**
 * IndicatorPicker interaction tests: render with raw react-dom (the app's
 * testing-library-free pattern), drive the store through the DOM, and pin the
 * `I`/Esc key behaviour with the same guards the app router uses.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IndicatorPicker, toggleIndicatorPicker } from './IndicatorPicker';
import { resetIndicatorStoreForTest, useIndicatorStore, MAX_ACTIVE_INDICATORS } from '../indicators/store';
import { setTimeframe, getSnapshot as getCandleSnapshot, resetForTest as resetCandles, CANDLE_TIMEFRAMES } from '../candles/store';
import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { pushOverlay, resetOverlays } from './overlayStack';
import { setLocale, t } from '../i18n';

const here = dirname(fileURLToPath(import.meta.url));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderPicker(): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<IndicatorPicker />);
  });
  mounted.push({ container, root });
  return { container };
}

function fireKey(key: string, target: EventTarget | null = window, init: KeyboardEventInit = {}): void {
  act(() => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

function q(container: HTMLElement, sel: string): Element | null {
  return container.querySelector(sel);
}

beforeEach(() => {
  window.localStorage.clear();
  resetIndicatorStoreForTest();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetIndicatorStoreForTest();
  resetCandles();
  window.localStorage.clear();
});

describe('IndicatorPicker — open/close', () => {
  it('renders nothing while closed; `I` opens, Esc and × close', () => {
    const { container } = renderPicker();
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();

    fireKey('i');
    expect(q(container, '[data-testid="indi-picker"]')).not.toBeNull();

    fireKey('Escape');
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();

    fireKey('i');
    act(() => {
      q(container, '[data-testid="indi-close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();
  });

  it('toggleIndicatorPicker works with no React context', () => {
    renderPicker();
    act(() => toggleIndicatorPicker());
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    act(() => toggleIndicatorPicker());
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
  });

  it('never fires while typing or with modifiers; `I` is left alone inside another dialog', () => {
    renderPicker();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('i', input); // typing context
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    fireKey('I', window, { ctrlKey: true }); // browser reserved
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    fireKey('i');
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    fireKey('i');
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    fireKey('i', button); // a foreign dialog owns the I key
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    input.remove();
    dialog.remove();
  });

  it('I is silent while single-key shortcuts are off, and Esc still closes an open picker', () => {
    renderPicker();
    setSingleKeyShortcutsEnabled(false);
    try {
      fireKey('i');
      expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    } finally {
      setSingleKeyShortcutsEnabled(true);
    }
    fireKey('i');
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    setSingleKeyShortcutsEnabled(false);
    try {
      fireKey('Escape');
      expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    } finally {
      setSingleKeyShortcutsEnabled(true);
    }
  });

  it('I toggles the picker shut when focus is on one of its own controls', () => {
    const { container } = renderPicker();
    fireKey('i');
    const close = q(container, '[data-testid="indi-close"]') as HTMLElement;
    fireKey('i', close);
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
  });

  it('Esc closes the picker even when focus is inside its own dialog', () => {
    const { container } = renderPicker();
    fireKey('i');
    const close = q(container, '[data-testid="indi-close"]') as HTMLElement;
    fireKey('Escape', close);
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
  });

  it('a held I toggles the picker once, not on every auto-repeat', () => {
    const { container } = renderPicker();
    fireKey('i');
    expect(q(container, '[data-testid="indi-picker"]')).not.toBeNull();
    fireKey('i', window, { repeat: true });
    expect(q(container, '[data-testid="indi-picker"]')).not.toBeNull();
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
  });

  it('Esc is left alone when another surface already consumed the keystroke', () => {
    const consume = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', consume);
    try {
      const { container } = renderPicker();
      fireKey('i');
      fireKey('Escape', window, { cancelable: true });
      expect(q(container, '[data-testid="indi-picker"]')).not.toBeNull();
      expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    } finally {
      window.removeEventListener('keydown', consume);
    }
  });

  it('moves focus into the picker on open and returns it to the opener on close', () => {
    const { container } = renderPicker();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    fireKey('i');
    expect(document.activeElement).toBe(q(container, '[data-testid="indi-close"]'));
    fireKey('Escape');
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Esc goes to the topmost overlay: a surface opened above the picker keeps it', () => {
    renderPicker();
    fireKey('i');
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    const offAbove = pushOverlay('settings');
    fireKey('Escape', window);
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    offAbove();
    fireKey('Escape', window);
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    resetOverlays();
  });
});

describe('IndicatorPicker — stacking', () => {
  it('sits above the Settings scrim and drawer, so it is visible when opened from Settings', () => {
    const css = readFileSync(resolve(here, '../indicators/indicators.css'), 'utf8');
    const app = readFileSync(resolve(here, '../App.css'), 'utf8');
    const pickerZ = /:root:has\(\.drawer-scrim\) \.indi-picker\s*\{\s*z-index:\s*(\d+)/.exec(css);
    const drawerZ = /\n\.drawer \{[^}]*z-index:\s*(\d+)/.exec(app);
    expect(pickerZ).not.toBeNull();
    expect(drawerZ).not.toBeNull();
    expect(Number(pickerZ![1])).toBeGreaterThan(Number(drawerZ![1]));
  });

  it('the picker stylesheet sets its font sizes through the type tokens, not raw pixels', () => {
    const css = readFileSync(resolve(here, '../indicators/indicators.css'), 'utf8');
    expect(css).not.toMatch(/font-size:\s*\d*\.?\d+px/);
  });
});

describe('IndicatorPicker — registry add/remove', () => {
  it('adds registry entries, shows them active, and removes by instance', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => {
      q(container, '[data-testid="indi-add-sma"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-active-sma"]')).not.toBeNull();
    expect(useIndicatorStore.getState().active.map((a) => a.defId)).toEqual(['sma']);
    const uid = useIndicatorStore.getState().active[0].uid;
    act(() => {
      q(container, `[data-testid="indi-remove-${uid}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-active-empty"]')).not.toBeNull();
  });

  it('disables Add at the cap and reflects the count', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => {
      for (let i = 0; i < MAX_ACTIVE_INDICATORS; i += 1) useIndicatorStore.getState().add('ema');
    });
    const add = q(container, '[data-testid="indi-add-sma"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(container.textContent).toContain(t('indi.active', { count: MAX_ACTIVE_INDICATORS, max: MAX_ACTIVE_INDICATORS }));
  });
});

/** Fire a React-tracked input change (native value setter defeats the value tracker). */
function fireInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('IndicatorPicker — params, colors, timeframe', () => {
  it('param edits clamp through the store schema', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => useIndicatorStore.getState().add('sma'));
    const uid = useIndicatorStore.getState().active[0].uid;
    const input = q(container, `[data-testid="indi-param-${uid}-period"]`) as HTMLInputElement;
    fireInput(input, '99999');
    // The store clamped to the schema max (500) regardless of raw input.
    expect(useIndicatorStore.getState().active[0].params.period).toBe(500);
  });

  it('lists parameters with the UI locale decimal separator and no digit grouping', () => {
    act(() => setLocale('tr'));
    try {
      const { container } = renderPicker();
      fireKey('i');
      act(() => useIndicatorStore.getState().add('bb'));
      const uid = useIndicatorStore.getState().active[0].uid;
      act(() => useIndicatorStore.getState().setParam(uid, 'mult', 2.5));
      const row = q(container, '[data-testid="indi-active-bb"]')!;
      expect(row.textContent).toContain('(20 / 2,5)');
    } finally {
      act(() => setLocale('en'));
    }
  });

  it('a series without an override shows the colour it is drawn in, not black', () => {
    document.documentElement.style.setProperty('--indi-c1', '#123ABC');
    try {
      const { container } = renderPicker();
      fireKey('i');
      act(() => useIndicatorStore.getState().add('sma'));
      const uid = useIndicatorStore.getState().active[0].uid;
      const color = q(container, `[data-testid="indi-color-${uid}-sma"]`) as HTMLInputElement;
      expect(useIndicatorStore.getState().active[0].colors.sma ?? null).toBeNull(); // no override
      expect(color.value).toBe('#123abc');
    } finally {
      document.documentElement.style.removeProperty('--indi-c1');
    }
  });

  it('color pick stores an override; the reset chip restores the theme default', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => useIndicatorStore.getState().add('vwap'));
    const uid = useIndicatorStore.getState().active[0].uid;
    const color = q(container, `[data-testid="indi-color-${uid}-vwap"]`) as HTMLInputElement;
    fireInput(color, '#112233');
    expect(useIndicatorStore.getState().active[0].colors.vwap).toBe('#112233');
    act(() => {
      q(container, `[data-testid="indi-color-reset-${uid}-vwap"]`)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(useIndicatorStore.getState().active[0].colors.vwap).toBeNull();
  });

  it('the timeframe select re-points the candle store and persists', () => {
    const { container } = renderPicker();
    fireKey('i');
    const select = q(container, '[data-testid="indi-tf"]') as HTMLSelectElement;
    expect(String(getCandleSnapshot().timeframeNs)).toBe(select.value);
    act(() => {
      select.value = String(CANDLE_TIMEFRAMES[1].ns);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getCandleSnapshot().timeframeNs).toBe(CANDLE_TIMEFRAMES[1].ns);
    expect(window.localStorage.getItem('flowmap.candles.tf')).toBe(String(CANDLE_TIMEFRAMES[1].ns));
    setTimeframe(CANDLE_TIMEFRAMES[0].ns); // cleanup for other suites
  });
});
