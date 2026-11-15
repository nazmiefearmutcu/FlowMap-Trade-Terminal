import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupEntry } from './marketFilter';
import { MarketsSection } from './SettingsDrawerMarkets';
import { resetVenueCatalog, type VenueInfo } from './symbols';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VENUES: VenueInfo[] = [
  { id: 'sim', assetClass: 'sim', depth: 'L2', native: true, segments: [] },
  { id: 'equity', assetClass: 'equity', depth: 'L2-snapshot', native: true, segments: [] },
  { id: 'binance', assetClass: 'crypto', depth: 'L2', native: true, segments: ['spot', 'usdm'] },
  { id: 'kraken', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
  { id: 'world', assetClass: 'equity', depth: 'per-market', native: true, segments: ['xist', 'xtai'] },
  { id: 'forex', assetClass: 'equity', depth: 'SYNTH', native: true, segments: [] },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  resetVenueCatalog();
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ venues: VENUES, labels: { 'world-xist': 'Borsa Istanbul (TR)' } }) } as unknown as Response),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(hiddenMarkets: string[], onChange = vi.fn(), onBrowseMarket = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<MarketsSection hiddenMarkets={hiddenMarkets} onChange={onChange} onBrowseMarket={onBrowseMarket} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { onChange, onBrowseMarket };
}

const box = (testId: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('MarketsSection', () => {
  it('lists every market of the catalog under its group, with a checkbox each', async () => {
    await mount([]);
    expect(box('markets-crypto')).not.toBeNull();
    expect(box('market-binance-spot').checked).toBe(true);
    expect(box('market-kraken').checked).toBe(true);
    expect(box('market-equity').checked).toBe(true);
    expect(box('markets-world').textContent).toContain('2 of 2 on');
    expect(document.querySelector('[data-testid="markets-world"]')?.textContent).toContain('Borsa Istanbul (TR)');
    expect(box('market-forex').checked).toBe(true);
    // Groups the catalog has nothing for are not shown.
    expect(document.querySelector('[data-testid="markets-bonds"]')).toBeNull();
  });

  it('switching a market off stores it', async () => {
    const { onChange } = await mount([]);
    click(box('market-kraken'));
    expect(onChange).toHaveBeenCalledWith({ hiddenMarkets: ['kraken'] });
  });

  it('a group checkbox switches the whole group and shows the mixed state', async () => {
    const { onChange } = await mount(['kraken']);
    const group = box('markets-group-crypto');
    expect(group.indeterminate).toBe(true);
    expect(group.getAttribute('aria-checked')).toBe('mixed');
    click(group);
    // Mixed → on: every crypto market is shown again.
    expect(onChange).toHaveBeenLastCalledWith({ hiddenMarkets: [] });
  });

  it('a hidden group reads none on and offers no Browse', async () => {
    await mount([groupEntry('world')]);
    expect(box('markets-group-world').checked).toBe(false);
    expect(box('market-world-xist').checked).toBe(false);
    expect(document.querySelector('[data-testid="market-browse-world-xist"]')).toBeNull();
    expect(document.querySelector('[data-testid="markets-world"]')?.textContent).toContain('0 of 2 on');
  });

  it('Browse opens the search on that market', async () => {
    const { onBrowseMarket } = await mount([]);
    click(document.querySelector('[data-testid="market-browse-world-xtai"]')!);
    expect(onBrowseMarket).toHaveBeenCalledWith('world-xtai');
  });

  it('the search box narrows the list to matching markets', async () => {
    await mount([]);
    const input = document.querySelector<HTMLInputElement>('[data-testid="markets-search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'istanbul');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="market-world-xist"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="market-world-xtai"]')).toBeNull();
    expect(document.querySelector('[data-testid="markets-crypto"]')).toBeNull();
  });
});
