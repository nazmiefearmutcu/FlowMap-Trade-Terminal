import { describe, expect, it } from 'vitest';
import { applyChartAccessibility, CHART_KEYSHORTCUTS } from './chartAccessibility';

describe('applyChartAccessibility', () => {
  it('adds the key summary, an application role and a tab stop to a bare canvas', () => {
    const canvas = document.createElement('canvas');
    applyChartAccessibility(canvas);
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('aria-keyshortcuts')).toBe(CHART_KEYSHORTCUTS);
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
});
