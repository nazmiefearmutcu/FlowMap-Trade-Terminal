import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../../i18n';
import { fetchMarketMap, type MarketMapData, type MapItem } from './marketMapApi';
import { MarketMap } from './MarketMap';

vi.mock('./marketMapApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./marketMapApi')>();
  return { ...actual, fetchMarketMap: vi.fn() };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.mocked(fetchMarketMap);

function stock(overrides: Partial<MapItem> & Pick<MapItem, 'symbol'>): MapItem {
  return {
    name: `${overrides.symbol} Inc`,
    group: 'Technology',
    marketCap: 1e12,
    price: 100,
    change: { '1d': 1.2 },
    volume: 1000,
    chart: { market: 'equity', symbol: overrides.symbol },
    ...overrides,
  };
}

const usData: MarketMapData = {
  market: 'us',
  asOf: Date.UTC(2026, 10, 13, 20, 45, 18),
  source: 'Nasdaq screener',
  stale: false,
  items: [
    stock({ symbol: 'NVDA', marketCap: 3.9e12, price: 160.91, change: { '1d': -3.17 } }),
    stock({ symbol: 'AAPL', group: 'Technology', marketCap: 3.5e12, change: { '1d': 1.2 } }),
    stock({ symbol: 'XOM', group: 'Energy', marketCap: 4e11, change: { '1d': 0.1 }, chart: null }),
  ],
};

const cryptoData: MarketMapData = {
  market: 'crypto',
  asOf: Date.UTC(2026, 10, 13, 20, 45, 18),
  source: 'Exchange tickers',
  stale: false,
  items: [
    stock({
      symbol: 'BTC',
      group: 'Crypto',
      marketCap: 1.2e12,
      change: { '1h': 0.5, '24h': 4, '7d': -6 },
      chart: { market: 'crypto', symbol: 'BTCUSDT' },
    }),
    stock({
      symbol: 'ETH',
      group: 'Crypto',
      marketCap: 4e11,
      change: { '1h': -1, '24h': -2, '7d': 10 },
      chart: null,
    }),
  ],
};

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderMap(props: { open: boolean; onClose?: () => void; onOpenChart?: (m: string, s: string) => void }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  const onClose = props.onClose ?? vi.fn();
  const onOpenChart = props.onOpenChart ?? vi.fn();
  const element = (open: boolean) => (
    <MarketMap open={open} onClose={onClose} onOpenChart={onOpenChart} />
  );
  act(() => root.render(element(props.open)));
  return {
    onClose,
    onOpenChart,
    setOpen: (open: boolean) => act(() => root.render(element(open))),
  };
}

/** Lets pending promises (the mocked fetch) settle inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function tiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="market-map-tile"]')];
}

function tileFor(symbol: string): HTMLElement {
  const tile = tiles().find((el) => el.getAttribute('aria-label')?.includes(`(${symbol})`));
  if (!tile) throw new Error(`no tile for ${symbol}`);
  return tile;
}

function tab(market: 'us' | 'crypto'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="market-map-tab-${market}"]`);
  if (!el) throw new Error(`no tab ${market}`);
  return el;
}

function clickEl(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

beforeEach(() => {
  setLocale('en');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (market) => (market === 'us' ? usData : cryptoData));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element): void {
        this.callback(
          [{ target, contentRect: { width: 800, height: 500 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MarketMap', () => {
  it('renders nothing while closed and fetches nothing', () => {
    renderMap({ open: false });

    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches on open, shows loading, then the tiles', async () => {
    renderMap({ open: true });

    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(document.body.textContent).toContain('Loading the market map');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('us', expect.any(AbortSignal));

    await flush();

    expect(document.body.textContent).not.toContain('Loading the market map');
    expect(tiles().map((el) => el.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([expect.stringContaining('(NVDA)'), expect.stringContaining('(AAPL)')]),
    );
    expect(document.body.textContent).toContain('Nasdaq screener');
  });

  it('switches market on a tab and fetches each tab once', async () => {
    renderMap({ open: true });
    await flush();

    clickEl(tab('crypto'));
    await flush();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['us', 'crypto']);
    expect(tab('crypto').getAttribute('aria-selected')).toBe('true');
    expect(tileFor('BTC')).toBeTruthy();
  });

  it('shows the period switch only on crypto and changes tile tone with it', async () => {
    renderMap({ open: true });
    await flush();
    expect(document.querySelector('[role="group"][aria-label="Change over"]')).toBeNull();

    clickEl(tab('crypto'));
    await flush();
    const group = document.querySelector('[role="group"][aria-label="Change over"]');
    expect(group).not.toBeNull();

    const btcStrength = () => tileFor('BTC').style.getPropertyValue('--strength');
    const btcSide = () => tileFor('BTC').getAttribute('data-side');
    // 24 h: +4% of a 10% clamp is 0.4 of the full colour.
    expect(btcSide()).toBe('up');
    expect(btcStrength()).toBe('0.4');

    // 7 days: -6% of a 20% clamp is 0.3, which rounds up to the 0.4 step.
    clickEl(group!.querySelectorAll('button')[2] as HTMLElement); // 7 days
    expect(btcSide()).toBe('down');
    expect(btcStrength()).toBe('0.4');
  });

  it('opens the chart and closes when a tile with a chart is activated', async () => {
    const { onClose, onOpenChart } = renderMap({ open: true });
    await flush();

    const nvda = tileFor('NVDA');
    expect(nvda.tagName).toBe('BUTTON');
    clickEl(nvda);

    expect(onOpenChart).toHaveBeenCalledWith('equity', 'NVDA');
    expect(onClose).toHaveBeenCalled();
    const openOrder = vi.mocked(onOpenChart).mock.invocationCallOrder[0];
    const closeOrder = vi.mocked(onClose).mock.invocationCallOrder[0];
    expect(openOrder).toBeLessThan(closeOrder);
  });

  it('renders a tile without a chart as a non-focusable element', async () => {
    renderMap({ open: true });
    await flush();

    const xom = tileFor('XOM');
    expect(xom.tagName).not.toBe('BUTTON');
    expect(xom.hasAttribute('tabindex')).toBe(false);
  });

  it('closes on Escape', async () => {
    const { onClose } = renderMap({ open: true });
    await flush();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('shows the reason on an error and retries on demand', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The screener is down.'));
    renderMap({ open: true });
    await flush();

    expect(document.body.textContent).toContain('The market map could not be loaded.');
    expect(document.body.textContent).toContain('The screener is down.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    expect(retry).toBeTruthy();
    clickEl(retry!);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tiles().length).toBeGreaterThan(0);
  });

  it('shows the stale notice when the server marks its data stale', async () => {
    fetchMock.mockResolvedValueOnce({ ...usData, stale: true });
    renderMap({ open: true });
    await flush();

    expect(document.body.textContent).toContain('Could not refresh. Showing the last data received.');
  });

  it('refetches the visible tab every 60 seconds and stops after close', async () => {
    vi.useFakeTimers();
    const { setOpen } = renderMap({ open: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setOpen(false);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch again after close', async () => {
    const { setOpen } = renderMap({ open: true });
    await flush();
    setOpen(false);
    expect(dialog()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
