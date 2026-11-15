/**
 * The drawer rendered with the REAL server answers (copied under
 * `__fixtures__/research/`). Each answer goes through the researchApi validator
 * (only `sidecarFetch` is replaced, to return the sample body), then the drawer
 * draws it in English and in Turkish. Each case asserts a few visible values and
 * that no `NaN` or `undefined` text appears.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, type Locale } from '../i18n';
import { clearResearchCache } from '../app/useResearchSection';
import { useIntelligenceStore, type IntelTab } from '../state/intelligenceStore';
import { IntelligenceDrawer } from './IntelligenceDrawer';

const routes = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));

vi.mock('../net/serverBase', () => ({
  sidecarFetch: vi.fn(async (path: string) => {
    const match = /^\/api\/research\/([a-z]+)\/([a-z-]+)\?/.exec(path);
    const key = match ? `${match[1]}/${match[2]}` : path;
    const body = routes.map[key] ?? {
      section: key,
      symbol: '',
      status: 'not_applicable',
      reason: 'no_public_board',
      source: 'test',
      asOf: null,
      fetchedAt: 1,
      stale: false,
      data: null,
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One real sample file, read as the server sent it. */
function sample(name: string): unknown {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'research');
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

interface Case {
  name: string;
  market: 'equity' | 'crypto';
  symbol: string;
  tab: IntelTab;
  /** Sections fetched on this tab, by `market/section`, each to a sample file. */
  routes: Record<string, string>;
  /** English and Turkish expectations, each a list of text fragments. */
  en: string[];
  tr: string[];
  /** Extra checks on the rendered DOM, run under each locale. */
  dom?: (container: HTMLElement, locale: Locale) => void;
}

const CASES: Case[] = [
  {
    name: 'DOCS for NVDA: risk-factor change and management language',
    market: 'equity',
    symbol: 'NVDA',
    tab: 'DOCS',
    routes: {
      'us/risk-factors': 'us-risk-factors-NVDA.json',
      'us/language': 'us-language-NVDA.json',
    },
    en: ['10-Q filed 2026-08-26, compared with 10-Q filed 2026-05-20.', 'export control', 'Data as of 2026-08-26', '2.87', '-0.65'],
    tr: ['2026-05-20 tarihli', 'export control', 'Veri tarihi: 2026-08-26', '2,87', '-0,65'],
  },
  {
    name: 'GOV for LMT: contracts total and awards',
    market: 'equity',
    symbol: 'LMT',
    tab: 'GOV',
    routes: {
      'us/contracts': 'us-contracts-LMT.json',
      'us/house-trades': 'us-house-trades-NVDA.json',
    },
    en: ['23 awards with activity in the last 365 days', 'total award value is $217.7B', 'LOCKHEED MARTIN CORP', '$48.1B'],
    tr: ['217,7', 'LOCKHEED MARTIN CORP', '48,1'],
  },
  {
    name: 'GOV for NVDA: no award, and House trades at 40 of 983',
    market: 'equity',
    symbol: 'NVDA',
    tab: 'GOV',
    routes: {
      'us/contracts': 'us-contracts-NVDA.json',
      'us/house-trades': 'us-house-trades-NVDA.json',
    },
    en: [
      'No federal award to this company in the last 365 days.',
      'Read 40 of 983 House reports; 5 had no readable text. (still reading)',
      'The owner of each row',
      'Maria Elvira Salazar',
    ],
    tr: [
      'Son 365 günde bu şirkete bağlı federal bir ödül yok.',
      '983 Temsilciler Meclisi bildiriminin 40 tanesi okundu',
      'Maria Elvira Salazar',
    ],
  },
  {
    name: 'FLOW for NVDA: gamma levels and short-sale volume',
    market: 'equity',
    symbol: 'NVDA',
    tab: 'FLOW',
    routes: {
      'us/gex': 'us-gex-NVDA.json',
      'us/short-volume': 'us-short-volume-NVDA.json',
    },
    en: ['-$168.9M', 'dealers short gamma (amplifying)', '161.01', '166.42', '33.4%', '55,742,971'],
    tr: ['-$168,9 Mn', 'satıcılar kısa gama (büyütücü)', '161,01', '166,42', '%33,4', '55.742.971'],
    dom: (container, locale) => {
      // A plain number in Turkish is never shown with a dot decimal, and a share count keeps no fraction.
      const text = container.textContent ?? '';
      if (locale === 'tr') {
        expect(text).not.toContain('161.01');
        expect(text).not.toContain('971,2');
      }
    },
  },
  {
    name: 'GEO for PLTR: hiring with a board and a trend; jets is a note',
    market: 'equity',
    symbol: 'PLTR',
    tab: 'GEO',
    routes: { 'us/hiring': 'us-hiring-PLTR.json' },
    en: ['302', '+43.8%', 'Board:', 'expanding (more than +10%)', 'No free source maps aircraft'],
    tr: ['302', '+%43,8', 'Pano:', 'genişliyor (%+10\'dan fazla)', 'Uçakları listelenmiş'],
  },
  {
    name: 'GEO for NVDA: no public job board',
    market: 'equity',
    symbol: 'NVDA',
    tab: 'GEO',
    routes: { 'us/hiring': 'us-hiring-NVDA.json' },
    en: ['No public job board (Greenhouse, Lever or Ashby) was found'],
    tr: ['herkese açık bir iş ilanı panosu'],
  },
  {
    name: 'PERP for ETHUSDT: funding, open interest and positioning',
    market: 'crypto',
    symbol: 'ETHUSDT',
    tab: 'PERP',
    routes: { 'crypto/derivatives': 'crypto-derivatives-ETHUSDT.json' },
    en: ['-0.0065%', 'per 8 h', '-7.17%', '2,339,172', '$4.1B', '74.26% long · 25.74% short'],
    tr: ['-%0,0065', 'her 8 saatte', '-%7,17', '2.339.172', '$4,1 Mr', '%74,26 uzun · %25,74 kısa'],
  },
  {
    name: 'OPTIONS for ETHUSDT and SOLUSDT: model levels, and "not applicable"',
    market: 'crypto',
    symbol: 'ETHUSDT',
    tab: 'OPTIONS',
    routes: { 'crypto/options': 'crypto-options-ETHUSDT.json' },
    en: ['-$8.9M', '2200.00', '1968.99', '0.54'],
    tr: ['-$8,9 Mn', '2200,00', '1968,99', '0,54'],
  },
  {
    name: 'OPTIONS for SOLUSDT: no options market',
    market: 'crypto',
    symbol: 'SOLUSDT',
    tab: 'OPTIONS',
    routes: { 'crypto/options': 'crypto-options-SOLUSDT.json' },
    en: ['Deribit lists options for BTC and ETH only, so this coin has none here.'],
    tr: ['Deribit yalnızca BTC ve ETH için opsiyon listeler'],
  },
  {
    name: 'MARKET for ETHUSDT: price, supply, no maximum, and TVL with its source',
    market: 'crypto',
    symbol: 'ETHUSDT',
    tab: 'MARKET',
    routes: { 'crypto/market': 'crypto-market-ETHUSDT.json' },
    en: ['Ethereum · rank 2', '1741.37', '$37.4B', 'chain', 'no maximum', '122,218,624'],
    tr: ['Ethereum · sıra 2', '1741,37', '$37,4 Mr', 'zincir', 'azami yok', '122.218.624'],
  },
  {
    name: 'SENTIMENT for BTCUSDT: the 30-day path and the label',
    market: 'crypto',
    symbol: 'BTCUSDT',
    tab: 'SENTIMENT',
    routes: { 'crypto/sentiment': 'crypto-sentiment-BTCUSDT.json' },
    en: ['Extreme Fear', 'Market-wide, not per coin.'],
    tr: ['Aşırı korku', 'Piyasa geneli'],
    dom: (container, locale) => {
      const points = container.querySelector('[data-testid="research-sentiment-path"] polyline')?.getAttribute('points') ?? '';
      const pairs = points.split(' ');
      // Thirty days, and every coordinate a plain number with a dot, whatever the locale.
      expect(pairs).toHaveLength(30);
      for (const pair of pairs) {
        expect(pair, locale).toMatch(/^\d+(\.\d)?,\d+(\.\d)?$/);
      }
    },
  },
];

let mounted: Array<{ container: HTMLElement; root: Root }> = [];

async function renderCase(c: Case, locale: Locale): Promise<HTMLElement> {
  setLocale(locale);
  routes.map = {};
  for (const [key, file] of Object.entries(c.routes)) routes.map[key] = sample(file);
  useIntelligenceStore.getState().setActiveTab(c.tab);
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <IntelligenceDrawer
        activeSymbol={c.symbol}
        activeMarket={c.market === 'equity' ? 'equity' : 'binance-spot'}
        secContact=""
        onClose={() => undefined}
      />,
    );
  });
  mounted.push({ container, root });
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  clearResearchCache();
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
});

afterEach(() => {
  for (const { container, root } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  setLocale('en');
});

describe('IntelligenceDrawer with the real sample answers', () => {
  for (const c of CASES) {
    for (const locale of ['en', 'tr'] as const) {
      it(`${c.name} (${locale})`, async () => {
        const container = await renderCase(c, locale);
        // Intl puts a no-break space before compact units; compare with a plain space.
        const text = (container.textContent ?? '').replace(/ /g, ' ');
        for (const fragment of locale === 'en' ? c.en : c.tr) {
          expect(text, fragment).toContain(fragment);
        }
        expect(text).not.toContain('NaN');
        expect(text).not.toContain('undefined');
        c.dom?.(container, locale);
      });
    }
  }
});
