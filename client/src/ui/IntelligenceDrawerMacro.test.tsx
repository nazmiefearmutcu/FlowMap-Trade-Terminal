import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tFor } from '../i18n';
import type { MacroStressData } from '../state/intelligenceStore';
import { IntelMacroBar } from './IntelligenceDrawerMacro';

const full: MacroStressData = {
  sofrRate: 3.9, hySpreadBps: 350, yieldCurve10Y2Y: 0.24, stressRegime: 'NORMAL',
  stressScore: 0.1, status: 'NORMAL_LIQUIDITY', updatedAt: 1_700_000_000_000,
  sourceStatus: { SOFR: 'ok', BAMLH0A0HYM2: 'ok', T10Y2Y: 'ok' },
};

let container: HTMLDivElement;
let root: Root;

function render(macro: MacroStressData | null): HTMLDivElement {
  act(() => root.render(<IntelMacroBar macro={macro} demo={false} />));
  return container;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('IntelMacroBar with the REST reading', () => {
  it('shows every figure and no explanation when all are present', () => {
    const el = render(full);
    expect(el.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('3.90%');
    expect(el.textContent).toContain('350');
    expect(el.textContent).toContain('+0.24%');
    expect(el.querySelector('[data-testid="intel-macro-hy-note"]')).toBeNull();
  });

  it('shows a dash and the explanation line for a missing high-yield spread', () => {
    const el = render({
      ...full, hySpreadBps: null, stressRegime: 'UNKNOWN', stressScore: undefined, status: undefined,
      sourceStatus: { SOFR: 'ok', BAMLH0A0HYM2: 'fred_api_key_missing', T10Y2Y: 'ok' },
    });
    const bar = el.querySelector('[data-testid="intel-macro-bar"]');
    expect(bar?.textContent).toContain('3.90%');
    expect(bar?.textContent).toContain('+0.24%');
    const note = el.querySelector('[data-testid="intel-macro-hy-note"]');
    expect(note?.textContent).toBe(tFor('en', 'macro.hyNeedsKey'));
  });

  it('shows the plainer line when a set key was refused, not the key hint', () => {
    const el = render({
      ...full, hySpreadBps: null,
      sourceStatus: { SOFR: 'ok', BAMLH0A0HYM2: 'unreachable', T10Y2Y: 'ok' },
    });
    expect(el.querySelector('[data-testid="intel-macro-hy-note"]')?.textContent).toBe(tFor('en', 'macro.hyMissing'));
  });

  it('shows dashes for every figure when nothing has been received', () => {
    const el = render(null);
    const bar = el.querySelector('[data-testid="intel-macro-bar"]');
    expect(bar?.textContent).toContain('—');
    expect(bar?.textContent).not.toContain('%');
    expect(el.querySelector('[data-testid="intel-macro-hy-note"]')).toBeNull();
  });
});
