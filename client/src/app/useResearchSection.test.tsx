import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchResearch, ResearchFetchError, type ResearchResult, type ResearchSection } from '../net/researchApi';
import {
  clearResearchCache,
  HOUSE_POLL_MS,
  RESEARCH_KEEP_MS,
  useResearchSection,
  type ResearchSectionState,
} from './useResearchSection';

vi.mock('../net/researchApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../net/researchApi')>()),
  fetchResearch: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FetchOptions = { signal: AbortSignal; secContact?: string };
const fetchMock = fetchResearch as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

function calls(): Array<[string, string, string, FetchOptions]> {
  return fetchMock.mock.calls as unknown as Array<[string, string, string, FetchOptions]>;
}

function answer(section: ResearchSection, over: Partial<ResearchResult<unknown>> = {}): ResearchResult<unknown> {
  return {
    section,
    symbol: 'AAPL',
    status: 'ok',
    reason: null,
    source: 'test source',
    asOf: null,
    fetchedAt: 1,
    stale: false,
    data: { marker: Math.random() },
    ...over,
  };
}

interface ProbeProps {
  enabled?: boolean;
  section?: ResearchSection;
  symbol?: string;
  secContact?: string;
  market?: 'us' | 'crypto';
}

let latest: ResearchSectionState<ResearchSection> | null = null;

function Probe({ enabled = true, section = 'gex', symbol = 'AAPL', secContact = '', market = 'us' }: ProbeProps) {
  latest = useResearchSection<ResearchSection>(market, section, symbol, { enabled, secContact });
  return null;
}

let container: HTMLDivElement;
let root: Root;

function render(props: ProbeProps = {}): void {
  act(() => {
    root.render(<Probe {...props} />);
  });
}

/** Lets resolved promises and their state updates run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  clearResearchCache();
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useResearchSection fetching', () => {
  it('does not fetch while disabled', async () => {
    render({ enabled: false });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest?.state).toBe('idle');
  });

  it('fetches when enabled and reports loading, then ready with the answer', async () => {
    const result = answer('gex', { symbol: 'AAPL' });
    fetchMock.mockResolvedValue(result);
    render({ section: 'gex', symbol: 'AAPL' });
    expect(latest?.state).toBe('loading');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls()[0].slice(0, 3)).toEqual(['us', 'gex', 'AAPL']);
    expect(latest?.state).toBe('ready');
    expect(latest?.result).toEqual(result);
    expect(latest?.errorCode).toBeNull();
  });

  it('passes the SEC contact through to the request', async () => {
    fetchMock.mockResolvedValue(answer('risk-factors'));
    render({ section: 'risk-factors', secContact: 'me@example.com' });
    await flush();
    expect(calls()[0][3].secContact).toBe('me@example.com');
  });

  it('aborts the request in flight and asks again when the symbol changes', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    render({ symbol: 'AAPL' });
    const first = calls()[0][3].signal;
    render({ symbol: 'NVDA' });
    expect(first.aborted).toBe(true);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][2]).toBe('NVDA');
  });

  it('aborts the request in flight on unmount', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    render();
    const signal = calls()[0][3].signal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    root = createRoot(container);
  });

  it('asks again when the contact flag changes, since the cache key includes it', async () => {
    fetchMock.mockResolvedValue(answer('risk-factors'));
    render({ section: 'risk-factors', secContact: '' });
    await flush();
    render({ section: 'risk-factors', secContact: 'me@example.com' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useResearchSection cache', () => {
  it('reuses a kept answer when the section is shown again', async () => {
    fetchMock.mockResolvedValue(answer('gex'));
    render({ enabled: true });
    await flush();
    render({ enabled: false });
    render({ enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.state).toBe('ready');
  });

  it('asks again once the keep time has passed', async () => {
    fetchMock.mockResolvedValue(answer('gex'));
    render({ enabled: true });
    await flush();
    render({ enabled: false });
    await advance(RESEARCH_KEEP_MS.gex + 1);
    render({ enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not keep an unavailable answer', async () => {
    fetchMock.mockResolvedValue(answer('gex', { status: 'unavailable', reason: 'http_403', data: null }));
    render({ enabled: true });
    await flush();
    expect(latest?.result?.reason).toBe('http_403');
    render({ enabled: false });
    render({ enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clearResearchCache forgets the kept answers', async () => {
    fetchMock.mockResolvedValue(answer('sentiment'));
    render({ section: 'sentiment', market: 'crypto', symbol: 'BTCUSDT' });
    await flush();
    clearResearchCache();
    render({ section: 'sentiment', market: 'crypto', symbol: 'BTCUSDT', enabled: false });
    render({ section: 'sentiment', market: 'crypto', symbol: 'BTCUSDT', enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useResearchSection refresh and errors', () => {
  it('refresh asks the server again past the cache', async () => {
    fetchMock.mockResolvedValue(answer('gex'));
    render();
    await flush();
    act(() => latest?.refresh());
    expect(latest?.state).toBe('loading');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('ready');
  });

  it('an error keeps the last result and sets the error code', async () => {
    const first = answer('gex');
    fetchMock.mockResolvedValueOnce(first);
    render();
    await flush();
    fetchMock.mockRejectedValueOnce(new ResearchFetchError('http_500'));
    act(() => latest?.refresh());
    await flush();
    expect(latest?.state).toBe('error');
    expect(latest?.errorCode).toBe('http_500');
    expect(latest?.result).toEqual(first);
  });

  it('reports a failure that is not a research error as failed, with no result', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    render();
    await flush();
    expect(latest?.state).toBe('error');
    expect(latest?.errorCode).toBe('failed');
    expect(latest?.result).toBeNull();
  });

  it('does nothing on refresh while disabled', async () => {
    render({ enabled: false });
    act(() => latest?.refresh());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useResearchSection house trades', () => {
  const houseData = (parsed: number, total: number) => ({
    trades: [],
    tradeCount: 0,
    coverage: { parsed, total, unreadable: 0 },
    years: [2025, 2026],
    ownerKnown: false,
  });

  it('asks again every 30 s while the reports are only partly read', async () => {
    fetchMock.mockResolvedValue(answer('house-trades', { data: houseData(10, 20) }));
    render({ section: 'house-trades' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(HOUSE_POLL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A background poll does not show the loading state again.
    expect(latest?.state).toBe('ready');
  });

  it('stops polling once every report is read', async () => {
    fetchMock.mockResolvedValueOnce(answer('house-trades', { data: houseData(10, 20) }));
    fetchMock.mockResolvedValue(answer('house-trades', { data: houseData(20, 20) }));
    render({ section: 'house-trades' });
    await flush();
    await advance(HOUSE_POLL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(10 * HOUSE_POLL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the section is disabled', async () => {
    fetchMock.mockResolvedValue(answer('house-trades', { data: houseData(10, 20) }));
    render({ section: 'house-trades' });
    await flush();
    render({ section: 'house-trades', enabled: false });
    await advance(5 * HOUSE_POLL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('arms the poll for a partial answer served from the cache, then refetches after 30 s', async () => {
    fetchMock.mockResolvedValue(answer('house-trades', { data: houseData(10, 20) }));
    render({ section: 'house-trades' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    render({ section: 'house-trades', enabled: false });
    await advance(20_000);
    // Shown again within the 60 s keep time: served from the cache, no request yet.
    render({ section: 'house-trades', enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.state).toBe('ready');
    expect((latest?.result?.data as { coverage: { parsed: number } }).coverage.parsed).toBe(10);
    // The reports are still partly read, so the poll runs from the cached answer too.
    await advance(HOUSE_POLL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useResearchSection aborts a request in flight', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
  });

  it('aborts when the section changes', () => {
    render({ section: 'gex' });
    const first = calls()[0][3].signal;
    render({ section: 'short-volume' });
    expect(first.aborted).toBe(true);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][1]).toBe('short-volume');
  });

  it('aborts when the market changes', () => {
    render({ section: 'sentiment', market: 'us' });
    const first = calls()[0][3].signal;
    render({ section: 'sentiment', market: 'crypto' });
    expect(first.aborted).toBe(true);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][0]).toBe('crypto');
  });

  it('aborts when the section is disabled mid-flight', () => {
    render({ enabled: true });
    const first = calls()[0][3].signal;
    render({ enabled: false });
    expect(first.aborted).toBe(true);
    expect(calls()).toHaveLength(1);
  });
});

describe('useResearchSection cache bound', () => {
  it('keeps the newest 200 answers and drops the oldest', async () => {
    fetchMock.mockImplementation(async (_market: unknown, _section: unknown, symbol: unknown) =>
      answer('gex', { symbol: String(symbol) }),
    );
    for (let i = 0; i <= 200; i++) {
      render({ symbol: `S${i}` });
      await flush();
    }
    expect(fetchMock).toHaveBeenCalledTimes(201);
    // The newest answer is still kept: showing it again asks nothing.
    render({ symbol: 'S200', enabled: false });
    render({ symbol: 'S200', enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(201);
    // The oldest was dropped: showing it again asks the server.
    render({ symbol: 'S0' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(202);
  });
});

describe('useResearchSection retries by itself only for index_loading', () => {
  it('asks again after 15 s while the House index is still loading', async () => {
    fetchMock.mockResolvedValueOnce(answer('house-trades', { status: 'unavailable', reason: 'index_loading', data: null }));
    fetchMock.mockResolvedValue(answer('house-trades', { data: houseData(983, 983) }));
    render({ section: 'house-trades' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.result?.reason).toBe('index_loading');
    await advance(15_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.result?.status).toBe('ok');
  });

  it('does not ask again by itself for unreachable or other unavailable reasons', async () => {
    fetchMock.mockResolvedValue(answer('house-trades', { status: 'unavailable', reason: 'unreachable', data: null }));
    render({ section: 'house-trades' });
    await flush();
    await advance(5 * 60_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const houseData = (parsed: number, total: number) => ({
    trades: [],
    tradeCount: 0,
    coverage: { parsed, total, unreadable: 0 },
    years: [2025, 2026],
    ownerKnown: false,
  });
});
