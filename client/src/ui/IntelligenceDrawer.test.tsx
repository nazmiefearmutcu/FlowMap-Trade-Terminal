import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '../i18n';
import { MsgType } from '../proto/types';
import { DEMO_INTELLIGENCE, useIntelligenceStore, type VocalStressData } from '../state/intelligenceStore';
import { IntelligenceDrawer } from './IntelligenceDrawer';
import { pushOverlay, resetOverlays } from './overlayStack';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

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

beforeEach(() => {
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
  resetOverlays();
});

afterEach(() => {
  for (const { container, root } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  resetOverlays();
});

describe('IntelligenceDrawer', () => {
  it('renders the Research header, tabs, and a hidden-module note for unconnected sources', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);

    expect(container.textContent).toContain('Research · Labs');
    expect(container.textContent).toContain('Experimental');
    expect(container.textContent).not.toContain('<GO>');
    expect(container.querySelector('[data-testid="pane-docs"]')).not.toBeNull();
    // Nothing has been received, so no module is shown as live.
    expect(container.querySelector('.intel-section')).toBeNull();
    const hidden = container.querySelector('[data-testid="intel-hidden-modules"]');
    expect(hidden?.textContent).toContain('Not connected, hidden (2): SEC EDGAR Item 1A, Earnings-call acoustics');
  });

  it('exposes WAI-ARIA tabs wired to their panels', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(4);
    const docs = container.querySelector<HTMLButtonElement>('#intel-tab-DOCS')!;
    expect(docs.getAttribute('aria-controls')).toBe('intel-panel-DOCS');
    expect(docs.getAttribute('aria-selected')).toBe('true');
    expect(docs.tabIndex).toBe(0);
    expect(container.querySelector('#intel-tab-GOV')!.getAttribute('tabindex')).toBe('-1');
    const panel = container.querySelector('#intel-panel-DOCS')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('intel-tab-DOCS');
  });

  it('moves the selection and focus with the arrow, Home and End keys', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
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

  it('switches between tabs by click and shows each module title when its source is connected', () => {
    const store = useIntelligenceStore.getState();
    store.ingestGex({ type: MsgType.GEX_UPDATE, symbol: 'NVDA', spot_price: 130, net_gex: 12_000, call_wall: 137, put_wall: 119, gamma_flip: 127 });
    store.ingestIntel({ type: MsgType.MARKET_INTELLIGENCE, ts_ns: 1n, symbol: 'NVDA', kind: 'defense_contract', headline: 'Award', detail: '{"award_id":"A1"}', source: 'USASpending', amount_usd: 1000 });
    store.ingestIntel({ type: MsgType.MARKET_INTELLIGENCE, ts_ns: 2n, symbol: 'NVDA', kind: 'capitol', headline: 'Trade', detail: '{"politician":"X"}', source: 'House' });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);

    click(container.querySelector('[data-testid="tab-gov"]')!);
    expect(container.querySelector('[data-testid="pane-gov"]')).not.toBeNull();
    expect(container.textContent).toContain('Government & Defense Contracts');
    expect(container.textContent).toContain('Congressional Trades (House)');

    click(container.querySelector('[data-testid="tab-flow"]')!);
    expect(container.textContent).toContain('Gamma Exposure (GEX) Model Levels');
    expect(container.querySelector('.gex-summary-card')).not.toBeNull();
    // No short-sale source has delivered anything: that module is hidden and counted.
    expect(container.textContent).not.toContain('Short-Sale Volume Share (Reg SHO)');
    expect(container.querySelector('[data-testid="intel-hidden-modules"]')?.textContent).toContain('Reg SHO short-sale volume');

    click(container.querySelector('[data-testid="tab-geo"]')!);
    expect(container.textContent).not.toContain('Corporate Jet Movements');
    expect(container.querySelector('[data-testid="intel-hidden-modules"]')?.textContent).toContain('hidden (2): ADS-B aircraft');
  });

  it('says a connected source has no records for the symbol instead of hiding it', () => {
    const store = useIntelligenceStore.getState();
    store.ingestGex({ type: MsgType.GEX_UPDATE, symbol: 'TSLA', spot_price: 200, net_gex: -5_000, call_wall: 210, put_wall: 190, gamma_flip: 200 });
    store.setActiveTab('FLOW');
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(container.querySelector('[data-testid="intel-no-matches"]')?.textContent).toBe(
      'No Option-chain GEX records for NVDA.',
    );
    expect(container.querySelector('[data-testid="intel-hidden-modules"]')?.textContent).toContain('Reg SHO short-sale volume');
  });

  it('renders the macro stress footer labels', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    const macroBar = container.querySelector('[data-testid="intel-macro-bar"]');
    expect(macroBar).not.toBeNull();
    expect(macroBar!.textContent).toContain('SOFR');
    expect(macroBar!.textContent).toContain('HY SPREAD');
    expect(macroBar!.textContent).toContain('10Y-2Y YIELD CURVE');
    expect(macroBar!.textContent).toContain('MACRO NOT CONNECTED');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);
    click(container.querySelector('[data-testid="intel-drawer-close"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape only while it is the topmost overlay', () => {
    const onClose = vi.fn();
    render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);

    // A palette opened over the drawer owns the keystroke.
    const offPalette = pushOverlay('palette');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
    offPalette();

    // A surface that already consumed Escape (defaultPrevented) must not close the drawer.
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    consumed.preventDefault();
    window.dispatchEvent(consumed);
    expect(onClose).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the drawer on open and restores the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { root, container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="intel-drawer-close"]'));
    act(() => root.unmount());
    mounted.splice(mounted.findIndex((m) => m.root === root), 1);
    container.remove();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not substitute SIM-DEMO data for an unknown live symbol', () => {
    useIntelligenceStore.setState({ activeTab: 'FLOW', gex: { 'SIM-DEMO': DEMO_INTELLIGENCE.gex['SIM-DEMO'] }, darkPool: { 'SIM-DEMO': DEMO_INTELLIGENCE.darkPool['SIM-DEMO'] } });
    const { container } = render(<IntelligenceDrawer activeSymbol="UNKNOWN" onClose={vi.fn()} />);
    expect(container.querySelector('.gex-summary-card')).toBeNull();
    expect(container.querySelector('.darkpool-card')).toBeNull();
    expect(container.querySelector('[data-testid="intel-demo-label"]')).toBeNull();
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('MACRO NOT CONNECTED');
    expect(container.textContent).not.toContain('0.00%');
  });

  it('labels SIM-DEMO fixture values and keeps them outside live state', () => {
    useIntelligenceStore.setState({ activeTab: 'FLOW' });
    const { container } = render(<IntelligenceDrawer activeSymbol="SIM-DEMO" onClose={vi.fn()} />);
    expect(container.querySelector('[data-testid="intel-demo-label"]')?.textContent).toContain('all values, names and events below are synthetic');
    expect(container.textContent).toContain('CALL WALL (CEILING)');
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('DEMO');
    expect(useIntelligenceStore.getState().gex).toEqual({});
    expect(useIntelligenceStore.getState().macro).toBeNull();
  });

  it('ships no invented subpoena or filing text in the synthetic fixtures', () => {
    const text = JSON.stringify(DEMO_INTELLIGENCE.secDiffs);
    expect(text).not.toContain('subpoena');
    expect(text).not.toContain('Department of Justice');
  });

  it('renders actual received GEX and macro instead of the unavailable state', () => {
    const store = useIntelligenceStore.getState();
    store.setActiveTab('FLOW');
    store.ingestGex({ type: MsgType.GEX_UPDATE, symbol: 'NVDA', spot_price: 130, net_gex: 12_000, call_wall: 137, put_wall: 119, gamma_flip: 127 });
    store.ingestMacro({ type: MsgType.MACRO_STRESS, ts_ns: 1n, sofr: 5.32, hy_spread: 3.42, yield_10y2y: -0.18, stress_score: 0.4, status: 'ELEVATED' });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('$137.00');
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('NET GEX (MODEL)');
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('M / 100% spot move');
    expect(container.querySelector('.gex-summary-card')?.textContent).not.toContain('M/pt');
    expect(container.textContent).toContain('dealer inventory is unknown');
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('342 bps');
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('ELEVATED STRESS (HEURISTIC)');
    expect(container.querySelector('[data-testid="intel-macro-received"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="intel-demo-label"]')).toBeNull();
  });

  it('localizes the macro stress regime word in Turkish', () => {
    const store = useIntelligenceStore.getState();
    store.setActiveTab('FLOW');
    store.ingestMacro({ type: MsgType.MACRO_STRESS, ts_ns: 1n, sofr: 5.32, hy_spread: 3.42, yield_10y2y: -0.18, stress_score: 0.4, status: 'ELEVATED' });
    setLocale('tr');
    try {
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      const badge = container.querySelector('.macro-regime-badge')?.textContent ?? '';
      expect(badge).toContain('YÜKSELMİŞ STRES (SEZGİSEL)');
      expect(badge).not.toContain('ELEVATED');
    } finally {
      setLocale('en');
    }
  });

  it('shows an UNKNOWN stress regime as unavailable, never as the raw token', () => {
    const store = useIntelligenceStore.getState();
    store.setActiveTab('FLOW');
    store.ingestMacro({ type: MsgType.MACRO_STRESS, ts_ns: 1n, sofr: 5.32, hy_spread: 3.42, yield_10y2y: -0.18, stress_score: 0.4, status: 'SOMETHING_NEW' });
    setLocale('tr');
    try {
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      const badge = container.querySelector('.macro-regime-badge');
      expect(badge?.textContent).toContain(t('topbar.unavailable'));
      expect(badge?.textContent).not.toContain('UNKNOWN');
      expect(badge?.getAttribute('title')).toBeNull();
    } finally {
      setLocale('en');
    }
  });

  it('prints macro rates with the Turkish decimal comma and the bp unit', () => {
    const store = useIntelligenceStore.getState();
    store.setActiveTab('FLOW');
    store.ingestMacro({ type: MsgType.MACRO_STRESS, ts_ns: 1n, sofr: 5.32, hy_spread: 3.42, yield_10y2y: -0.18, stress_score: 0.4, status: 'ELEVATED' });
    setLocale('tr');
    try {
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      const bar = container.querySelector('[data-testid="intel-macro-bar"]')?.textContent ?? '';
      expect(bar).toContain('342 bp');
      expect(bar).toContain('5,32%');
      expect(bar).not.toContain('5.32%');
    } finally {
      setLocale('en');
    }
  });

  it('says the research modules are equity-only for a crypto symbol and stays silent for equities', () => {
    const crypto = render(<IntelligenceDrawer activeSymbol="BTCUSDT" activeMarket="binance-spot" onClose={vi.fn()} />);
    expect(crypto.container.querySelector('[data-testid="intel-equity-only"]')?.textContent).toContain('US equities');
    const equity = render(<IntelligenceDrawer activeSymbol="NVDA" activeMarket="equity" onClose={vi.fn()} />);
    expect(equity.container.querySelector('[data-testid="intel-equity-only"]')).toBeNull();
  });

  it('shows plain unknown intelligence content without inventing people or filings', () => {
    useIntelligenceStore.getState().ingestIntel({ type: MsgType.MARKET_INTELLIGENCE, ts_ns: 1n, symbol: 'NVDA', kind: 'unknown_kind', headline: 'Received headline', detail: 'Plain source detail', source: 'Received source' });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    const received = container.querySelector('[data-testid="intel-received-events"]');
    expect(received?.textContent).toContain('unknown_kind');
    expect(received?.textContent).toContain('Received headline');
    expect(received?.textContent).toContain('Received source');
    // The raw detail is never printed: unknown kinds show their token and headline only.
    expect(received?.textContent).not.toContain('Plain source detail');
    expect(container.textContent).not.toContain('Chief Financial Officer');
    expect(container.querySelector('.intel-card--diff')).toBeNull();
  });

  it('routes to the data-sources and legal dialog from the drawer', () => {
    const onOpenSources = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onOpenSources={onOpenSources} onClose={vi.fn()} />);
    click(container.querySelector('[data-testid="intel-open-sources"]')!);
    expect(onOpenSources).toHaveBeenCalledTimes(1);
  });

  it('shows no sources link when no route is supplied', () => {
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(container.querySelector('[data-testid="intel-open-sources"]')).toBeNull();
  });

  it('keeps every visible label in the Turkish table under the Turkish locale', () => {
    setLocale('tr');
    try {
      useIntelligenceStore.getState().setActiveTab('FLOW');
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      expect(container.querySelector('[data-testid="intel-hidden-modules"]')?.textContent)
        .toContain(t('intel.hiddenModules', { count: 2, names: `${t('intel.src.gex')}, ${t('intel.src.regSho')}` }));
      expect(container.querySelector('.intel-drawer__title')?.textContent).toBe(t('intel.title'));
      expect(container.querySelector('[data-testid="intel-open-sources"]')).toBeNull();
    } finally {
      setLocale('en');
    }
  });
});

describe('IntelligenceDrawer localized values', () => {
  it('prints the congressional trade side through the locale table', () => {
    useIntelligenceStore.getState().ingestIntel({ type: MsgType.MARKET_INTELLIGENCE, ts_ns: 1n, symbol: 'NVDA', kind: 'capitol', headline: 'Trade', detail: '{"politician":"X","type":"Sale","chamber":"Senate"}', source: 'House' });
    useIntelligenceStore.getState().setActiveTab('GOV');
    const english = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(english.container.querySelector('.intel-card__side')?.textContent?.trim()).toBe('SALE');
    expect(english.container.querySelector('.intel-card__politician')?.textContent).toContain('(Senate)');
    setLocale('tr');
    try {
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      expect(container.querySelector('.intel-card__side')?.textContent?.trim()).toBe('SATIŞ');
      expect(container.querySelector('.intel-card__politician')?.textContent).toContain('(Senato)');
    } finally {
      setLocale('en');
    }
  });

  it('groups the listing counts with the locale number format', () => {
    useIntelligenceStore.setState({
      talent: { NVDA: { symbol: 'NVDA', talentDeltaPct: 1.5, rdOpenings: 1200, totalOpenings: 12000, hiringFreeze: false } },
    });
    useIntelligenceStore.getState().setActiveTab('GEO');
    setLocale('tr');
    try {
      const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
      const stats = container.querySelector('.talent-stats-grid')?.textContent ?? '';
      expect(stats).toContain('12.000');
      expect(stats).toContain('1.200');
    } finally {
      setLocale('en');
    }
  });
  it('agrees the tracked phrase count with its number', () => {
    const vocal: VocalStressData = {
      id: 'voc-test',
      symbol: 'NVDA',
      quarter: 'Q2 2026 Earnings Call',
      executive: 'Chief Financial Officer',
      f0Jitter: 0.01,
      shimmer: 0.02,
      pauseRatio: 0.1,
      stressScore: 0.2,
      evasiveAnswersDetected: 1,
    };
    useIntelligenceStore.setState({ vocalStress: [vocal] });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    const badge = (): string => container.querySelector('.intel-trigger-badge.is-warn')?.textContent ?? '';
    expect(badge()).toBe('1 tracked phrase match (text only)');
    act(() => {
      useIntelligenceStore.setState({ vocalStress: [{ ...vocal, evasiveAnswersDetected: 12 }] });
    });
    expect(badge()).toBe('12 tracked phrase matches (text only)');
  });
});
