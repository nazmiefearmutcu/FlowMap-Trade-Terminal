import { afterEach, describe, expect, it } from 'vitest';
import { applyChartAccessibility, chartKeyshortcuts } from './chartAccessibility';
import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';

afterEach(() => {
  setSingleKeyShortcutsEnabled(true);
});

describe('chartKeyshortcuts', () => {
  it('lists the single-character keys only while the single-key switch is on', () => {
    const on = chartKeyshortcuts(true).split(' ');
    const off = chartKeyshortcuts(false).split(' ');
    for (const key of ['+', '-', '[', ']', 'F', 'P', 'R']) {
      expect(on).toContain(key);
      expect(off).not.toContain(key);
    }
  });

  it('always lists the arrow keys and the Shift+Arrow price zoom', () => {
    for (const singleKeys of [true, false]) {
      const keys = chartKeyshortcuts(singleKeys).split(' ');
      expect(keys).toEqual(expect.arrayContaining(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']));
      expect(keys).toEqual(expect.arrayContaining(['Shift+ArrowUp', 'Shift+ArrowDown']));
    }
  });
});

describe('applyChartAccessibility', () => {
  it('adds the key summary, an application role and a tab stop to a bare canvas', () => {
    const canvas = document.createElement('canvas');
    applyChartAccessibility(canvas);
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('aria-keyshortcuts')).toBe(chartKeyshortcuts(true));
    expect(canvas.getAttribute('tabindex')).toBe('0');
  });

  it('never names the canvas: App.tsx owns the instrument-specific label', () => {
    const canvas = document.createElement('canvas');
    applyChartAccessibility(canvas);
    expect(canvas.hasAttribute('aria-label')).toBe(false);
  });

  it('keeps the name, role and tabindex the page already set', () => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '-1');
    canvas.setAttribute('aria-label', 'Liquidity heatmap chart, crypto:BTC');
    applyChartAccessibility(canvas);
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('tabindex')).toBe('-1');
    expect(canvas.getAttribute('aria-label')).toBe('Liquidity heatmap chart, crypto:BTC');
  });

  it('follows the single-key switch when it is toggled after the canvas was set up', () => {
    const canvas = document.createElement('canvas');
    applyChartAccessibility(canvas);
    expect(canvas.getAttribute('aria-keyshortcuts')).toBe(chartKeyshortcuts(true));
    setSingleKeyShortcutsEnabled(false);
    expect(canvas.getAttribute('aria-keyshortcuts')).toBe(chartKeyshortcuts(false));
    setSingleKeyShortcutsEnabled(true);
    expect(canvas.getAttribute('aria-keyshortcuts')).toBe(chartKeyshortcuts(true));
  });
});
