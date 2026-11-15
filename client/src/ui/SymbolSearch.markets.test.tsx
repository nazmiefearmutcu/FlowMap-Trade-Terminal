/**
 * Symbol palette with markets switched off in Settings → Markets: their venue rows,
 * directory rows and recent picks are left out, and their movers are not requested.
 * All fetches are stubbed; nothing here touches the network.
 */

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupEntry, setHiddenMarkets } from './marketFilter';
import { SymbolSearch, type SymbolSearchHandle } from './SymbolSearch';
import { resetVenueCatalog, type VenueInfo } from './symbols';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = function scrollIntoView() {
  /* no-op */
};

const VENUES: VenueInfo[] = [
  { id: 'sim', assetClass: 'sim', depth: 'L2', native: true, segments: [] },
  { id: 'equity', assetClass: 'equity', depth: 'L2-snapshot', native: true, segments: [] },
  { id: 'binance', assetClass: 'crypto', depth: 'L2', native: true, segments: ['spot', 'usdm'] },
  { id: 'kraken', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
];

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  resetVenueCatalog();
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    let payload: unknown = { symbols: [] };
    if (url.includes('/api/venues')) payload = { venues: VENUES };
    else if (url.includes('/api/movers')) payload = { movers: [] };
    else if (url.includes('/api/quote')) payload = { market: 'x', symbol: 'y', price: 1, changePct: 0, spark: [] };
    else if (url.includes('market=kraken')) {
      payload = { symbols: [{ market: 'kraken', symbol: 'XBT/USD', capability: { depth: 'L2-snapshot' } }] };
    }
    return Promise.resolve({ ok: true, json: async () => payload } as unknown as Response);
  }) as unknown as typeof fetch;
});

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  setHiddenMarkets([]);
});

function render(ref = createRef<SymbolSearchHandle>()): { container: HTMLElement; ref: typeof ref } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<SymbolSearch ref={ref} current="sim:SIM-DEMO" onSelect={() => {}} />);
  });
  mounted.push({ container, root });
  return { container, ref };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const markets = (selector: string): string[] =>
  [...document.body.querySelectorAll(selector)].map((el) => el.getAttribute('data-market') ?? '');

describe('SymbolSearch with markets switched off', () => {
  it('leaves a switched-off group out of the directory and its movers unrequested', async () => {
    setHiddenMarkets([groupEntry('us')]);
    const { container } = render();
    click(container.querySelector('[data-testid="symbol-search-trigger"]'));
    await settle();

    const rows = markets('[data-testid="symbol-row"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).not.toContain('equity');
    expect(calls.some((url) => url.includes('/api/movers?market=equity'))).toBe(false);
    expect(calls.some((url) => url.includes('/api/movers?market=crypto'))).toBe(true);
  });

  it('leaves switched-off markets out of the venue list', async () => {
    setHiddenMarkets(['kraken', groupEntry('us')]);
    const { container } = render();
    click(container.querySelector('[data-testid="symbol-search-trigger"]'));
    await settle();
    click(document.body.querySelector('[data-testid="venue-picker-toggle"]'));
    await settle();

    const venues = markets('[data-testid="venue-row"]');
    expect(venues).toContain('binance-spot');
    expect(venues).not.toContain('kraken');
    expect(venues).not.toContain('equity');
  });

  it('opens on one market listing through the handle', async () => {
    const { ref } = render();
    act(() => ref.current?.openVenue('kraken'));
    await settle();
    await settle();

    expect(markets('[data-testid="symbol-row"]')).toEqual(['kraken']);
  });

  it('drops a chosen scope whose market is switched off', async () => {
    const { ref } = render();
    act(() => ref.current?.openVenue('kraken'));
    await settle();
    act(() => setHiddenMarkets(['kraken']));
    await settle();

    expect(markets('[data-testid="symbol-row"]')).not.toContain('kraken');
    expect(document.body.querySelector('[data-testid="venue-scope"]')?.textContent).not.toContain('kraken');
  });
});
