import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '../i18n';
import { en } from '../i18n/en';
import { tr } from '../i18n/tr';
import { clearResearchCache } from '../app/useResearchSection';
import { fetchResearch, ResearchFetchError, type ResearchResult } from '../net/researchApi';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { IntelligenceDrawer } from './IntelligenceDrawer';
import { reasonText, REASON_SENTENCE_KEYS } from './IntelligenceDrawerSection';
import { pushOverlay, resetOverlays } from './overlayStack';

vi.mock('../net/researchApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../net/researchApi')>()),
  fetchResearch: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = fetchResearch as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;
type Call = [string, string, string, { secContact?: string }];
function calls(): Call[] {
  return fetchMock.mock.calls as unknown as Call[];
}

/** One section's answer, by section name. Anything not listed is `not_applicable`. */
let answers: Record<string, Partial<ResearchResult<unknown>>> = {};

function answer(section: string, over: Partial<ResearchResult<unknown>> = {}): ResearchResult<unknown> {
  return {
    section: section as ResearchResult<unknown>['section'],
    symbol: 'NVDA',
    status: 'ok',
    reason: null,
    source: 'Test source',
    asOf: null,
    fetchedAt: 1_794_698_390_341,
    stale: false,
    data: null,
    ...answers[section],
    ...over,
  };
}

const RISK = {
  form: '10-K', filedDate: '2026-11-03', previousForm: '10-Q', previousFiledDate: '2026-07-31',
  url: 'https://www.sec.gov/Archives/edgar/data/1/a-index.html', previousUrl: null,
  added: ['A new paragraph about supply.'], removed: ['An old paragraph.'],
  addedCount: 1, removedCount: 1, modifiedCount: 2, triggers: ['going concern'],
};

const GEX = {
  spot: 355.4, netGex: 120_000_000_000, callWall: 360, putWall: 350, gammaFlip: 332.04,
  putCallOiRatio: 0.945, contracts: 2400, expiries: 23, maxPain: 340, maxPainExpiry: '2026-11-20', currency: 'USD',
};

const HOUSE = {
  trades: [{
    ticker: 'NVDA', assetType: 'ST', type: 'Purchase', transactionDate: '2026-10-01', notificationDate: '2026-10-10',
    amount: '$1,001 - $15,000', member: 'Jane Doe', state: 'CA', district: 11, filedDate: '2026-10-10',
    reportUrl: 'https://disclosures-clerk.house.gov/x.pdf', committees: ['Armed Services'],
  }],
  tradeCount: 1, coverage: { parsed: 40, total: 983, unreadable: 5 }, years: [2025, 2026], ownerKnown: false,
};

function fill(): void {
  answers = {
    'risk-factors': { data: RISK, asOf: '2026-11-03' },
    language: { data: null, status: 'empty', reason: 'no_earnings_release' },
    contracts: { status: 'empty', reason: 'no_awards', data: null },
    'house-trades': { data: HOUSE, asOf: null },
    gex: { data: GEX, asOf: '2026-11-14' },
    'short-volume': {
      data: {
        date: '2026-11-13', shortVolume: 6_815_042, shortExemptVolume: 25_752, totalVolume: 12_364_490,
        shortRatio: 0.55, avgShortRatio5d: 0.52,
        days: [{ date: '2026-11-13', shortRatio: 0.55 }, { date: '2026-11-12', shortRatio: 0.44 }],
      },
    },
    hiring: { status: 'not_applicable', reason: 'no_public_board', data: null, source: 'Public job boards' },
  };
}

function setupFetch(): void {
  fetchMock.mockImplementation(async (_market: unknown, section: unknown) => {
    await Promise.resolve();
    return answer(String(section));
  });
}

let mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

/** Lets pending fetches resolve and their state updates land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keyDown(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

const testid = (container: ParentNode, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
  resetOverlays();
  clearResearchCache();
  fill();
  fetchMock.mockReset();
  setupFetch();
});

afterEach(() => {
  for (const { container, root } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  setLocale('en');
  resetOverlays();
});

describe('IntelligenceDrawer tabs', () => {
  it('shows the US stock tabs with their hints and wires them to their panels', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.id)).toEqual(['intel-tab-DOCS', 'intel-tab-GOV', 'intel-tab-FLOW', 'intel-tab-GEO']);
    const docs = container.querySelector<HTMLButtonElement>('#intel-tab-DOCS')!;
    expect(docs.getAttribute('aria-controls')).toBe('intel-panel-DOCS');
    expect(docs.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#intel-tab-GOV')!.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('#intel-panel-DOCS')!.getAttribute('aria-labelledby')).toBe('intel-tab-DOCS');
  });

  it('moves the selection and focus with the arrow, Home and End keys', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    const tablist = container.querySelector('[role="tablist"]')!;
    keyDown(tablist, 'ArrowRight');
    expect(useIntelligenceStore.getState().activeTab).toBe('GOV');
    expect(document.activeElement).toBe(container.querySelector('#intel-tab-GOV'));
    keyDown(tablist, 'End');
    expect(useIntelligenceStore.getState().activeTab).toBe('GEO');
    keyDown(tablist, 'ArrowRight');
    expect(useIntelligenceStore.getState().activeTab).toBe('DOCS');
    keyDown(tablist, 'ArrowLeft');
    expect(useIntelligenceStore.getState().activeTab).toBe('GEO');
    keyDown(tablist, 'Home');
    expect(useIntelligenceStore.getState().activeTab).toBe('DOCS');
  });

  it('shows the crypto tabs for a crypto market and starts on the first of them', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="ETHUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    await settle();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.id)).toEqual(['intel-tab-PERP', 'intel-tab-OPTIONS', 'intel-tab-MARKET', 'intel-tab-SENTIMENT']);
    expect(tabs[0].textContent).toContain('Funding & positions');
    expect(testid(container, 'pane-perp')).not.toBeNull();
  });

  it('falls back to the first tab of the new set when the market changes', async () => {
    useIntelligenceStore.getState().setActiveTab('GOV');
    const { container, root } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    expect(testid(container, 'pane-gov')).not.toBeNull();
    act(() => root.render(<IntelligenceDrawer activeSymbol="ETHUSDT" activeMarket="binance-spot" onClose={vi.fn()} />));
    await settle();
    expect(testid(container, 'pane-perp')).not.toBeNull();
    expect(container.querySelector('#intel-tab-PERP')!.getAttribute('aria-selected')).toBe('true');
  });

  it('says research does not cover other markets and shows no tabs', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="SIM-DEMO" activeMarket="sim" onClose={vi.fn()} />);
    await settle();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(testid(container, 'intel-not-covered')?.textContent).toBe(
      'Research covers US stocks and crypto. This market has no research sources yet.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls onClose from the close button and on Escape only while topmost', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={onClose} />);
    const offPalette = pushOverlay('palette');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
    offPalette();
    click(container.querySelector('[data-testid="intel-drawer-close"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the macro stress footer labels', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    const macroBar = testid(container, 'intel-macro-bar');
    expect(macroBar!.textContent).toContain('SOFR');
    expect(macroBar!.textContent).toContain('HY SPREAD');
    expect(macroBar!.textContent).toContain('10Y-2Y YIELD CURVE');
    expect(macroBar!.textContent).toContain('MACRO NOT CONNECTED');
  });

  it('moves focus into the drawer on open and restores the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { root, container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="intel-drawer-close"]'));
    act(() => root.unmount());
    mounted = mounted.filter((m) => m.root !== root);
    container.remove();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('IntelligenceDrawer US sections', () => {
  it('asks the server only for the visible tab, and only for its sections', async () => {
    render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" secContact="me@example.com" onClose={vi.fn()} />);
    await settle();
    const asked = calls().map((c) => c.slice(0, 3));
    expect(asked).toEqual([
      ['us', 'risk-factors', 'NVDA'],
      ['us', 'language', 'NVDA'],
    ]);
    // The contact goes to the two SEC sections only.
    expect(calls()[0][3].secContact).toBe('me@example.com');
    expect(calls()[1][3].secContact).toBe('me@example.com');
  });

  it('shows the risk-factor change with its counts, trigger badges and filing link', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" secContact="me@example.com" onClose={vi.fn()} />);
    await settle();
    const card = testid(container, 'research-risk-factors')!;
    expect(card.textContent).toContain('10-K filed 2026-11-03, compared with 10-Q filed 2026-07-31.');
    expect(card.textContent).toContain('going concern');
    expect(card.textContent).toContain('A new paragraph about supply.');
    expect(card.textContent).toContain('An old paragraph.');
    const link = card.querySelector<HTMLAnchorElement>('a[href^="https://www.sec.gov"]')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(card.textContent).toContain('Data as of 2026-11-03');
  });

  it('asks for a contact with a button when none is set and an opener exists', async () => {
    answers['risk-factors'] = { status: 'unavailable', reason: 'sec_contact_missing', data: null };
    const onOpenSettings = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onOpenSettings={onOpenSettings} onClose={vi.fn()} />);
    await settle();
    const reason = container.querySelector<HTMLElement>('[data-reason="sec_contact_missing"]')!;
    expect(reason.textContent).toContain('contact e-mail');
    click(testid(container, 'research-open-settings')!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('names the place to set the contact in words when no opener exists', async () => {
    answers['risk-factors'] = { status: 'unavailable', reason: 'sec_contact_missing', data: null };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    expect(testid(container, 'research-open-settings')).toBeNull();
    expect(container.textContent).toContain('Settings → Data');
  });

  it('shows the management-language measure and its note, never audio', async () => {
    answers.language = {
      data: {
        filedDate: '2026-11-02', previousFiledDate: '2026-07-30', url: 'https://www.sec.gov/x.htm', words: 1032,
        hedgingPer1k: 2.91, uncertaintyPer1k: 0, previousHedgingPer1k: 3.17, previousUncertaintyPer1k: 0,
        hedgingChange: -0.26, uncertaintyChange: 0, topTerms: [{ term: 'approximately', count: 2 }],
      },
    };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" secContact="me@example.com" onClose={vi.fn()} />);
    await settle();
    const card = testid(container, 'research-language')!;
    expect(card.textContent).toContain('Management language (text, not audio)');
    expect(card.textContent).toContain('written earnings release');
    expect(card.textContent).toContain('2.91');
    expect(card.textContent).toContain('-0.26');
    expect(card.textContent).toContain('approximately');
  });

  it('shows the contract total and the awards, and says when none matched', async () => {
    answers.contracts = {
      status: 'ok', reason: null,
      data: {
        query: 'apple', windowDays: 365, listedTotal: 10_178_293.25, matchedCount: 4, source: 'USAspending.gov',
        awards: [{
          awardId: 'A1', recipient: 'Apple Construction', agency: 'Department of Defense', subAgency: 'Air Force',
          amount: 525_000, startDate: '2025-09-15', description: 'Restripe', url: 'https://www.usaspending.gov/a',
        }],
      },
    };
    const { container } = render(<IntelligenceDrawer activeSymbol="AAPL" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-gov')!);
    await settle();
    const card = testid(container, 'research-contracts')!;
    expect(card.textContent).toContain('Listed total $10.2M across 4 awards in the last 365 days.');
    expect(card.textContent).toContain('Apple Construction');
    expect(card.textContent).toContain('$525K');
  });

  it('says a contract search found nothing, in the reason sentence', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-gov')!);
    await settle();
    expect(testid(container, 'research-contracts')!.textContent).toContain('No federal award to this company in the last 365 days.');
  });

  it('lists House trades with the owner line, and the coverage with "still reading"', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-gov')!);
    await settle();
    const card = testid(container, 'research-house-trades')!;
    expect(testid(card, 'research-house-coverage')!.textContent).toBe(
      'Read 40 of 983 House reports; 5 had no readable text. (still reading)',
    );
    expect(card.textContent).toContain('The owner of each row (member, spouse, joint account or child) is in the linked report.');
    expect(card.textContent).toContain('Jane Doe');
    expect(card.textContent).toContain('CA-11');
    expect(card.textContent).toContain('Armed Services');
    expect(card.textContent).toContain('$1,001 - $15,000');
  });

  it('hides the owner line when the owner is known and drops "still reading" once all reports are read', async () => {
    answers['house-trades'] = { data: { ...HOUSE, ownerKnown: true, coverage: { parsed: 983, total: 983, unreadable: 0 } } };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-gov')!);
    await settle();
    const card = testid(container, 'research-house-trades')!;
    expect(testid(card, 'research-house-coverage')!.textContent).toBe('Read 983 of 983 House reports; 0 had no readable text.');
    expect(card.textContent).not.toContain('The owner of each row');
  });

  it('shows the net gamma exposure per 1% move with the long-gamma wording and the model note', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    const card = testid(container, 'research-gex')!;
    expect(card.textContent).toContain('Net gamma exposure (model, $ per 1% move)');
    // 120e9 gamma per unit move is 1.2e9 per 1% move.
    expect(card.querySelector('.gex-stat__val')!.textContent).toBe('$1.2B');
    expect(card.textContent).toContain('dealers long gamma (dampening)');
    expect(card.textContent).toContain('The model assumes dealers are short puts and long calls.');
    expect(card.textContent).toContain('Gamma flip');
    expect(card.textContent).toContain('Call wall (ceiling)');
  });

  it('shows the short-gamma wording and "no flip" when the model has neither', async () => {
    answers.gex = { data: { ...GEX, netGex: -340_000_000, gammaFlip: null } };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    const card = testid(container, 'research-gex')!;
    expect(card.querySelector('.gex-stat__val')!.textContent).toBe('-$3.4M');
    expect(card.textContent).toContain('dealers short gamma (amplifying)');
    expect(card.textContent).toContain('no flip');
  });

  it('explains an HTTP 403 from Cboe on the gamma section', async () => {
    answers.gex = { status: 'unavailable', reason: 'http_403', data: null };
    const { container } = render(<IntelligenceDrawer activeSymbol="LMT" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    expect(testid(container, 'research-gex')!.textContent).toContain('Cboe refused the request; this symbol may have no listed options.');
  });

  it('shows the short-sale share with its bar, the five days and the short-exempt volume', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    const card = testid(container, 'research-short-volume')!;
    expect(card.textContent).toContain('55.0%');
    expect(card.querySelector<HTMLElement>('.research-bar__fill')!.style.width).toBe('55%');
    expect(card.textContent).toContain('Short-exempt volume');
    expect(card.textContent).toContain('2026-11-12');
  });

  it('says the job board is missing for a company without one, and that jets have no source', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="AAPL" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    fetchMock.mockClear();
    click(testid(container, 'tab-geo')!);
    await settle();
    expect(testid(container, 'research-hiring')!.textContent).toContain(
      'No public job board (Greenhouse, Lever or Ashby) was found for this company.',
    );
    const jets = testid(container, 'research-jets')!;
    expect(jets.textContent).toContain('No free source maps aircraft to listed companies, so this section has no data.');
    // Jets make no request: only the hiring section asks the server on this tab.
    expect(calls().map((c) => c[1])).toEqual(['hiring']);
  });

  it('shows the stale note with the last successful read time', async () => {
    answers.gex = { data: GEX, stale: true, status: 'ok' };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    expect(testid(container, 'research-stale')!.textContent).toMatch(/^Last successful read: \S/);
  });

  it('shows a request failure with its code and a retry button', async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      throw new ResearchFetchError('http_500');
    });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    await settle();
    const card = testid(container, 'research-risk-factors')!;
    expect(card.querySelector('[data-reason="http_500"]')!.textContent).toContain('HTTP 500');
    expect(testid(card, 'research-retry')).not.toBeNull();
  });
});

describe('IntelligenceDrawer crypto sections', () => {
  const DERIV = {
    pair: 'BTCUSDT', markPrice: 63794.38, indexPrice: 63817.52, fundingRate: 0.00003472, fundingIntervalHours: 8,
    fundingRateAnnualPct: 3.8, nextFundingTime: 1_794_700_800_000, openInterest: 97_860.693,
    openInterestUsd: 6_242_962_925.88, longShortAccountRatio: 2.9793, longAccountPct: 74.87, shortAccountPct: 25.13,
    takerBuySellRatio: 0.9604,
  };

  it('shows the perpetual funding rate per interval and annualized, the open interest and the account ratio', async () => {
    answers.derivatives = { data: DERIV };
    const { container } = render(<IntelligenceDrawer activeSymbol="BTCUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    await settle();
    const card = testid(container, 'research-derivatives')!;
    expect(card.textContent).toContain('0.0035%');
    expect(card.textContent).toContain('per 8 h');
    expect(card.textContent).toContain('3.80%');
    expect(card.textContent).toContain('$6.2B');
    expect(card.textContent).toContain('74.87% long · 25.13% short');
    expect(calls()[0].slice(0, 3)).toEqual(['crypto', 'derivatives', 'BTCUSDT']);
  });

  it('sends the crypto symbol as the chart shows it', async () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="binance:ETHUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    await settle();
    expect(calls()[0][2]).toBe('binance:ETHUSDT');
    expect(testid(container, 'research-derivatives')).not.toBeNull();
  });

  it('explains that Deribit has no options market for a coin other than BTC and ETH', async () => {
    answers.options = { status: 'not_applicable', reason: 'no_options_market', data: null, source: 'Deribit' };
    const { container } = render(<IntelligenceDrawer activeSymbol="SOLUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    click(testid(container, 'tab-options')!);
    await settle();
    expect(testid(container, 'research-options')!.textContent).toContain('Deribit lists options for BTC and ETH only');
  });

  it('shows the market figures, the all-time high and the TVL with its kind', async () => {
    answers.market = {
      data: {
        coinId: 'bitcoin', name: 'Bitcoin', rank: 1, price: 63564, change24hPct: -6.3, change7dPct: -16.17,
        change30dPct: -22.97, marketCap: 1_278_277_925_767, volume24h: 42_489_995_875, circulatingSupply: 20_112_015,
        totalSupply: 20_112_015, maxSupply: 21_000_000, ath: 126_080, athChangePct: -49.58, athDate: '2025-10-06',
        tvl: 3_410_593_009.63, tvlSource: 'chain', tvlReason: null,
      },
    };
    const { container } = render(<IntelligenceDrawer activeSymbol="BTCUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    click(testid(container, 'tab-market')!);
    await settle();
    const card = testid(container, 'research-market')!;
    expect(card.textContent).toContain('Bitcoin · rank 1');
    expect(card.textContent).toContain('-6.30%');
    expect(card.textContent).toContain('$1.3T');
    expect(card.textContent).toContain('on 2025-10-06');
    expect(card.textContent).toContain('-49.58%');
    expect(card.textContent).toContain('$3.4B');
    expect(card.textContent).toContain('chain');
  });

  it('gives the TVL reason when DefiLlama did not answer', async () => {
    answers.market = {
      data: {
        coinId: 'x', name: 'Coin', rank: 300, price: 0.01, change24hPct: 0, change7dPct: 0, change30dPct: 0,
        marketCap: 1, volume24h: 1, circulatingSupply: 1, totalSupply: 1, maxSupply: null, ath: 1, athChangePct: 0,
        athDate: '2024-01-01', tvl: null, tvlSource: null, tvlReason: 'unreachable',
      },
    };
    const { container } = render(<IntelligenceDrawer activeSymbol="XUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    click(testid(container, 'tab-market')!);
    await settle();
    expect(testid(container, 'research-tvl-reason')!.textContent).toBe(
      'The source could not be reached. Press Try again to read it once more.',
    );
  });

  it('draws the 30-day sentiment path, oldest day first, and says it is market-wide', async () => {
    answers.sentiment = {
      data: {
        value: 13, label: 'Extreme Fear', avg7d: 25.57, avg30d: 41.47,
        history: [
          { date: '2026-11-14', value: 13 },
          { date: '2026-11-13', value: 20 },
          { date: '2026-11-12', value: 28 },
        ],
      },
    };
    const { container } = render(<IntelligenceDrawer activeSymbol="BTCUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    click(testid(container, 'tab-sentiment')!);
    await settle();
    const card = testid(container, 'research-sentiment')!;
    expect(card.textContent).toContain('Extreme Fear');
    expect(card.textContent).toContain('Market-wide, not per coin.');
    const points = testid(card, 'research-sentiment-path')!.querySelector('polyline')!.getAttribute('points')!;
    // Three points, the oldest (28) on the left and the newest (13) on the right.
    expect(points.split(' ')).toHaveLength(3);
    expect(points.split(' ')[0].endsWith(',' + '57.6')).toBe(true);
  });
});

describe('reason sentences', () => {
  const SERVER_TOKENS = [
    'sec_contact_missing', 'not_sec_registrant', 'fewer_than_two_filings', 'no_earnings_release', 'unknown_company',
    'no_awards', 'index_loading', 'no_listed_options', 'not_in_file', 'no_public_board', 'no_perpetual',
    'no_options_market', 'not_in_top_250', 'unreachable', 'malformed', 'too_large', 'invalid_reply', 'failed', 'network',
  ];

  it('has a sentence in English and Turkish for every token the server or client can send', () => {
    for (const key of REASON_SENTENCE_KEYS) {
      expect(en[key], key).toBeDefined();
      expect(tr[key], key).toBeDefined();
    }
  });

  it('gives every known token its own sentence, not the generic one', () => {
    expect(t('research.reason.unknown', { reason: 'x' })).toBe('The source gave no answer (x).');
    for (const token of SERVER_TOKENS) {
      expect(reasonText(t, token, null), token).not.toContain('gave no answer');
    }
  });

  it('puts an unknown token in parentheses and an HTTP status into its sentence', () => {
    expect(reasonText(t, 'brand_new_reason', null)).toBe('The source gave no answer (brand_new_reason).');
    expect(reasonText(t, 'http_500', null)).toBe('The source answered with HTTP 500.');
    expect(reasonText(t, 'http_403', 'contracts')).toBe('The source answered with HTTP 403.');
    expect(reasonText(t, 'http_403', 'gex')).toBe('Cboe refused the request; this symbol may have no listed options.');
  });

  it('is in Turkish under the Turkish locale', async () => {
    setLocale('tr');
    answers.contracts = { status: 'empty', reason: 'no_awards', data: null };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-gov')!);
    await settle();
    expect(testid(container, 'research-contracts')!.textContent).toContain('Son 365 günde bu şirkete bağlı federal bir ödül yok.');
  });

  it('promises a retry only where the drawer makes one', () => {
    const promising = /shortly|tried again|will appear|yakında|yeniden denenecek|kısa süre/i;
    for (const key of ['research.reason.indexLoading', 'research.reason.unreachable']) {
      expect(en[key], key).not.toMatch(promising);
      expect(tr[key], key).not.toMatch(promising);
    }
    expect(en['research.reason.indexLoading']).toContain('every 15 seconds');
    expect(en['research.reason.unreachable']).toContain('Try again');
    expect(tr['research.reason.unreachable']).toContain('Yeniden dene');
    expect(tr['research.reason.indexLoading']).toContain('15 saniye');
  });
});

describe('IntelligenceDrawer small rules', () => {
  it('says how many paragraphs the server counted when it sent none of them', async () => {
    answers['risk-factors'] = { data: { ...RISK, added: [], addedCount: 3 } };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" secContact="me@example.com" onClose={vi.fn()} />);
    await settle();
    const card = testid(container, 'research-risk-factors')!;
    expect(card.textContent).toContain('Showing 0 of 3.');
    expect(card.textContent).not.toContain('None.');
  });

  it('says a zero gamma exposure is neither long nor short', async () => {
    answers.gex = { data: { ...GEX, netGex: 0 } };
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    click(testid(container, 'tab-flow')!);
    await settle();
    const card = testid(container, 'research-gex')!;
    expect(card.textContent).toContain('dealers neutral gamma');
    expect(card.textContent).not.toContain('dealers long gamma');
  });
});
