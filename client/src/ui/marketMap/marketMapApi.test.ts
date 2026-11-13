import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMarketMap } from './marketMapApi';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMarketMap', () => {
  it('requests the market and parses a good response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        market: 'us',
        asOf: 1794593685406,
        source: 'Nasdaq screener',
        stale: false,
        items: [
          {
            symbol: 'NVDA',
            name: 'NVIDIA Corporation',
            group: 'Technology',
            marketCap: 3.9e12,
            price: 160.91,
            change: { '1d': -3.17 },
            volume: 9393915,
            chart: { market: 'equity', symbol: 'NVDA' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchMarketMap('us');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/market-map?market=us');
    expect(data.market).toBe('us');
    expect(data.asOf).toBe(1794593685406);
    expect(data.source).toBe('Nasdaq screener');
    expect(data.stale).toBe(false);
    expect(data.items).toEqual([
      {
        symbol: 'NVDA',
        name: 'NVIDIA Corporation',
        group: 'Technology',
        marketCap: 3.9e12,
        price: 160.91,
        change: { '1d': -3.17 },
        volume: 9393915,
        chart: { market: 'equity', symbol: 'NVDA' },
      },
    ]);
  });

  it('drops items without a symbol or with a bad market cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          market: 'us',
          asOf: 1,
          source: 's',
          stale: false,
          items: [
            { name: 'no symbol', group: 'Technology', marketCap: 1, price: 1, change: {}, volume: null, chart: null },
            { symbol: 'ZERO', name: 'z', group: 'Technology', marketCap: 0, price: 1, change: {}, volume: null, chart: null },
            { symbol: 'NEG', name: 'n', group: 'Technology', marketCap: -5, price: 1, change: {}, volume: null, chart: null },
            { symbol: 'NAN', name: 'n', group: 'Technology', marketCap: 'big', price: 1, change: {}, volume: null, chart: null },
            { symbol: 'OK', name: 'ok', group: 'Technology', marketCap: 10, price: 1, change: {}, volume: null, chart: null },
          ],
        }),
      ),
    );

    const data = await fetchMarketMap('us');

    expect(data.items.map((item) => item.symbol)).toEqual(['OK']);
  });

  it('keeps only finite numbers in change and treats a bad chart as null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          market: 'crypto',
          asOf: 1,
          source: 's',
          stale: true,
          items: [
            {
              symbol: 'BTC',
              name: 'Bitcoin',
              group: 'Crypto',
              marketCap: 1e12,
              price: 60000,
              change: { '1h': 0.5, '24h': 'x', '7d': null, '30d': 3 },
              volume: null,
              chart: { market: 'crypto', symbol: 'BTCUSDT' },
            },
            {
              symbol: 'ETH',
              name: 'Ether',
              group: 'Crypto',
              marketCap: 5e11,
              price: 3000,
              change: {},
              volume: 12,
              chart: 'nope',
            },
          ],
        }),
      ),
    );

    const data = await fetchMarketMap('crypto');

    expect(data.stale).toBe(true);
    expect(data.items[0].change).toEqual({ '1h': 0.5, '30d': 3 });
    expect(data.items[0].chart).toEqual({ market: 'crypto', symbol: 'BTCUSDT' });
    expect(data.items[1].chart).toBeNull();
    expect(data.items[1].volume).toBe(12);
  });

  it('surfaces the server error message on a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, { error: { code: 'upstream_unavailable', message: 'The screener is down.' } }),
      ),
    );

    await expect(fetchMarketMap('us')).rejects.toThrow('The screener is down.');
  });

  it('falls back to a generic message when the error body is not readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 502 })));

    await expect(fetchMarketMap('us')).rejects.toThrow(/502/);
  });

  it('propagates an abort', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );

    const pending = fetchMarketMap('us', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
