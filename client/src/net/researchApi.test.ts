import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchResearch, MAX_ITEMS, ResearchFetchError } from './researchApi';
import { sidecarFetch } from './serverBase';

vi.mock('./serverBase', () => ({ sidecarFetch: vi.fn() }));

const RISK_FACTORS_OK = {
  section: 'risk-factors',
  symbol: 'AAPL',
  status: 'ok',
  reason: null,
  source: 'SEC EDGAR',
  asOf: '2026-11-03',
  fetchedAt: 1794698390341,
  stale: false,
  data: {
    form: '10-K',
    filedDate: '2026-11-03',
    previousForm: '10-Q',
    previousFiledDate: '2026-07-31',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/x-index.html',
    previousUrl: 'https://www.sec.gov/Archives/edgar/data/320193/y-index.html',
    added: ['A new paragraph.'],
    removed: ['An old paragraph.'],
    addedCount: 122,
    removedCount: 11,
    modifiedCount: 8,
    triggers: ['litigation'],
  },
};

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sentInit(): RequestInit {
  return vi.mocked(sidecarFetch).mock.calls[0][1] as RequestInit;
}

function sentPath(): string {
  return vi.mocked(sidecarFetch).mock.calls[0][0];
}

function sentHeader(name: string): string | null {
  return new Headers(sentInit().headers).get(name);
}

beforeEach(() => {
  vi.mocked(sidecarFetch).mockReset();
});

describe('fetchResearch request', () => {
  it('builds the path with the symbol encoded and no contact in the URL', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    await fetchResearch('us', 'risk-factors', 'BRK.B', { secContact: 'me@example.com' });
    expect(sentPath()).toBe('/api/research/us/risk-factors?symbol=BRK.B');
    expect(sentPath()).not.toContain('example.com');
  });

  it('sends X-SEC-Contact on the two SEC sections when a contact is set', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    await fetchResearch('us', 'risk-factors', 'AAPL', { secContact: ' me@example.com ' });
    expect(sentHeader('X-SEC-Contact')).toBe('me@example.com');

    vi.mocked(sidecarFetch).mockReset();
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, section: 'language', data: null, status: 'empty', reason: 'no_earnings_release' }));
    await fetchResearch('us', 'language', 'AAPL', { secContact: 'me@example.com' });
    expect(sentHeader('X-SEC-Contact')).toBe('me@example.com');
  });

  it('never sends the contact header on other sections', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, section: 'gex', status: 'empty', data: null }));
    await fetchResearch('us', 'gex', 'AAPL', { secContact: 'me@example.com' });
    expect(sentHeader('X-SEC-Contact')).toBeNull();
  });

  it('sends no contact header when the contact is empty or missing', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    await fetchResearch('us', 'risk-factors', 'AAPL', { secContact: '   ' });
    expect(sentHeader('X-SEC-Contact')).toBeNull();

    vi.mocked(sidecarFetch).mockReset();
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(sentHeader('X-SEC-Contact')).toBeNull();
  });

  it('passes the abort signal to the request', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    const controller = new AbortController();
    await fetchResearch('us', 'risk-factors', 'AAPL', { signal: controller.signal, secContact: 'me@example.com' });
    expect(sentInit().signal).toBe(controller.signal);
  });
});

describe('fetchResearch envelope', () => {
  it('returns the envelope and a typed risk-factors section', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    const result = await fetchResearch('us', 'risk-factors', 'AAPL', { secContact: 'me@example.com' });
    expect(result).toEqual({
      section: 'risk-factors',
      symbol: 'AAPL',
      status: 'ok',
      reason: null,
      source: 'SEC EDGAR',
      asOf: '2026-11-03',
      fetchedAt: 1794698390341,
      stale: false,
      data: RISK_FACTORS_OK.data,
    });
  });

  it('keeps a not_applicable answer with its reason and no data', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        section: 'hiring', symbol: 'AAPL', status: 'not_applicable', reason: 'no_public_board',
        source: 'Public job boards', asOf: null, fetchedAt: 1, stale: false, data: null,
      }),
    );
    const result = await fetchResearch('us', 'hiring', 'AAPL');
    expect(result.status).toBe('not_applicable');
    expect(result.reason).toBe('no_public_board');
    expect(result.data).toBeNull();
  });

  it('keeps the stale flag and the server reason on an unavailable answer', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        section: 'gex', symbol: 'LMT', status: 'unavailable', reason: 'http_403',
        source: 'Cboe delayed options', asOf: null, fetchedAt: 5, stale: true, data: null,
      }),
    );
    const result = await fetchResearch('us', 'gex', 'LMT');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('http_403');
    expect(result.stale).toBe(true);
  });

  it('rejects an unknown status as an invalid reply', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, status: 'partial' }));
    const error = await fetchResearch('us', 'risk-factors', 'AAPL').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResearchFetchError);
    expect((error as ResearchFetchError).code).toBe('invalid_reply');
  });

  it('rejects an envelope without a numeric fetch time', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, fetchedAt: 'now' }));
    await expect(fetchResearch('us', 'risk-factors', 'AAPL')).rejects.toMatchObject({ code: 'invalid_reply' });
  });

  it('rejects a body that is not JSON on a success status', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    await expect(fetchResearch('us', 'gex', 'AAPL')).rejects.toMatchObject({ code: 'invalid_reply' });
  });

  it('rejects a non-2xx status with its code', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(422, { error: { code: 'unknown_research_section' } }));
    await expect(fetchResearch('us', 'gex', 'AAPL')).rejects.toMatchObject({ code: 'http_422' });
  });

  it('rejects a network failure as network', async () => {
    vi.mocked(sidecarFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchResearch('us', 'gex', 'AAPL')).rejects.toMatchObject({ code: 'network' });
  });

  it('rejects with the abort reason when the signal aborts', async () => {
    const controller = new AbortController();
    vi.mocked(sidecarFetch).mockImplementation(async () => {
      controller.abort(new Error('superseded'));
      throw new TypeError('aborted');
    });
    await expect(fetchResearch('us', 'gex', 'AAPL', { signal: controller.signal })).rejects.toThrow('superseded');
  });
});

describe('section data validation', () => {
  it('keeps only well-typed fields and drops unknown keys', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        ...RISK_FACTORS_OK,
        data: { ...RISK_FACTORS_OK.data, form: 42, addedCount: 'many', extra: 'dropped', added: ['ok', 7, null] },
      }),
    );
    const { data } = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(data?.form).toBeNull();
    expect(data?.addedCount).toBeNull();
    expect(data).not.toHaveProperty('extra');
    expect(data?.added).toEqual(['ok']);
  });

  it('turns a non-number (such as the string \'NaN\') into null', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        section: 'gex', symbol: 'NVDA', status: 'ok', reason: null, source: 'Cboe delayed options',
        asOf: '2026-11-14', fetchedAt: 1, stale: false,
        data: { spot: 1, netGex: 'NaN', callWall: null, putWall: 350, gammaFlip: null, putCallOiRatio: 0.9, contracts: 1, expiries: 1, maxPain: 340, maxPainExpiry: '2026-11-20', currency: 'USD' },
      }),
    );
    const result = await fetchResearch('us', 'gex', 'NVDA');
    expect(result.data?.netGex).toBeNull();
    expect(result.data?.gammaFlip).toBeNull();
    expect(result.data?.spot).toBe(1);
  });

  it('bounds every array at MAX_ITEMS', async () => {
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => `line ${i}`);
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, { ...RISK_FACTORS_OK, data: { ...RISK_FACTORS_OK.data, added: many } }),
    );
    const { data } = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(data?.added).toHaveLength(MAX_ITEMS);
    expect(data?.added[0]).toBe('line 0');
  });

  it('drops array entries that are not objects and keeps the typed fields of those that are', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        section: 'house-trades', symbol: 'NVDA', status: 'ok', reason: null, source: 'House Clerk',
        asOf: '2026-11-12', fetchedAt: 1, stale: false,
        data: {
          trades: [
            'junk',
            { ticker: 'NVDA', type: 'Purchase', amount: '$1,001 - $15,000', district: 7, committees: ['Armed Services', 3] },
          ],
          tradeCount: 1,
          coverage: { parsed: 40, total: 983, unreadable: 5 },
          years: [2025, 'x', 2026],
          ownerKnown: false,
        },
      }),
    );
    const { data } = await fetchResearch('us', 'house-trades', 'NVDA');
    expect(data?.trades).toHaveLength(1);
    expect(data?.trades[0]).toMatchObject({ ticker: 'NVDA', type: 'Purchase', district: 7, committees: ['Armed Services'] });
    expect(data?.trades[0].member).toBeNull();
    expect(data?.coverage).toEqual({ parsed: 40, total: 983, unreadable: 5 });
    expect(data?.years).toEqual([2025, 2026]);
  });

  it('maps an unknown hiring trend to null and keeps the known ones', async () => {
    const hiringData = {
      provider: 'Lever', board: 'palantir', boardName: null, boardUrl: 'https://jobs.lever.co/palantir',
      totalOpenings: 90, rdOpenings: 40, newLast30d: 9, newPrior30d: 6, changePct: 50, status: 'exploding',
    };
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, { section: 'hiring', symbol: 'PLTR', status: 'ok', reason: null, source: 'Lever', asOf: '2026-11-14', fetchedAt: 1, stale: false, data: hiringData }),
    );
    expect((await fetchResearch('us', 'hiring', 'PLTR')).data?.status).toBeNull();
  });

  it('reads the crypto market section with its nullable supply and TVL reason', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        section: 'market', symbol: 'ETHUSDT', status: 'ok', reason: null, source: 'CoinGecko and DefiLlama', asOf: '2026-11-14', fetchedAt: 1, stale: false,
        data: {
          coinId: 'ethereum', name: 'Ethereum', rank: 2, price: 3000, change24hPct: 1.5, change7dPct: -2, change30dPct: 4,
          marketCap: 3.6e11, volume24h: 2e10, circulatingSupply: 1.2e8, totalSupply: 1.2e8, maxSupply: null,
          ath: 4900, athChangePct: -38, athDate: '2025-08-24T00:00:00.000Z', tvl: 3.7e10, tvlSource: 'chain', tvlReason: null,
        },
      }),
    );
    const { data } = await fetchResearch('crypto', 'market', 'ETHUSDT');
    expect(data?.maxSupply).toBeNull();
    expect(data?.tvl).toBe(3.7e10);
    expect(data?.tvlReason).toBeNull();
  });

  it('turns data of the wrong shape into unavailable with invalid_reply', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, data: ['not', 'an', 'object'] }));
    const result = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('invalid_reply');
    expect(result.data).toBeNull();
  });

  it('turns an ok answer without data into unavailable with invalid_reply', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, { ...RISK_FACTORS_OK, data: null }));
    const result = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('invalid_reply');
  });

  it('accepts a missing data field on an empty answer', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, { section: 'contracts', symbol: 'NVDA', status: 'empty', reason: 'no_awards', source: 'USAspending.gov', asOf: '2026-11-14', fetchedAt: 1, stale: false }),
    );
    const result = await fetchResearch('us', 'contracts', 'NVDA');
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_awards');
    expect(result.data).toBeNull();
  });
});

describe('links from the server', () => {
  it('keeps only https addresses in the link fields', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(200, {
        ...RISK_FACTORS_OK,
        data: {
          ...RISK_FACTORS_OK.data,
          url: 'javascript:alert(1)',
          previousUrl: 'http://www.sec.gov/plain.html',
        },
      }),
    );
    const { data } = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(data?.url).toBeNull();
    expect(data?.previousUrl).toBeNull();
  });

  it('keeps an https filing link as it is', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, RISK_FACTORS_OK));
    const { data } = await fetchResearch('us', 'risk-factors', 'AAPL');
    expect(data?.url).toBe(RISK_FACTORS_OK.data.url);
  });
});
