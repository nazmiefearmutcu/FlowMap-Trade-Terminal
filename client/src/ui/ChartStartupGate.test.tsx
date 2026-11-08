import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFlowMapStore } from '../state/store';
import { ChartStartupGate, chartDiagnosticsText } from './ChartStartupGate';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let element: HTMLDivElement;
let root: Root;
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
let renderer: { marketFrameReady: boolean; residentRange?: () => { count: number } | null; getRenderFailure?: () => string | null };
let renderFailure: string | null;
let residentCount: number;
let rendererRef: { current: typeof renderer | null };

beforeEach(() => {
  callbacks = new Map();
  nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  useFlowMapStore.setState({
    status: 'live', feedState: 'live', noFeed: false, sessionId: 'btc-session', sessionRevision: 0,
    subscription: { market: 'binance-spot', symbol: 'BTCUSDT', band: 'deep', mode: 'live' },
  });
  residentCount = 16;
  renderFailure = null;
  renderer = {
    marketFrameReady: false,
    residentRange: () => residentCount ? { count: residentCount } : null,
    getRenderFailure: () => renderFailure,
  };
  rendererRef = { current: renderer };
  element = document.createElement('div');
  root = createRoot(element);
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function frame(timestamp: number): void {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  });
}

function reveal(start = 100): void {
  renderer.marketFrameReady = true;
  for (let n = 0; n <= 4; n++) frame(start + 16 * n);
}

it('waits for four real presentations and resets when graphics readiness is lost', () => {
  frame(0);
  frame(100_000);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  renderer.marketFrameReady = true;
  frame(100_016);
  frame(100_032);
  frame(100_048);
  renderer.marketFrameReady = false;
  frame(100_148);
  renderer.marketFrameReady = true;
  frame(100_164);
  frame(100_180);
  frame(100_196);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(100_212);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('retains presented history through a reconnect, then gates a new session', () => {
  reveal();
  act(() => useFlowMapStore.setState({ status: 'reconnecting', feedState: 'reconnecting' }));
  frame(1000);
  expect(element.querySelector('[role="status"]')).toBeNull();
  act(() => useFlowMapStore.setState({ status: 'live', feedState: 'live', sessionId: 'new-btc-session' }));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal(2000);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('waits again after graphics readiness is lost and keeps refused feeds honest', () => {
  reveal();
  renderer.marketFrameReady = false;
  frame(200);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  act(() => useFlowMapStore.setState({ noFeed: true, feedState: 'closed' }));
  reveal(300);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  expect(element.textContent).toContain('NO FEED');
});

it('offers a symbol search, and no retry, while the market has no feed', () => {
  const onSearchSymbols = vi.fn();
  act(() => root.render(
    <ChartStartupGate rendererRef={rendererRef} onResubscribe={vi.fn()} onSearchSymbols={onSearchSymbols} />,
  ));
  act(() => useFlowMapStore.setState({ noFeed: true, feedState: 'closed' }));
  expect(element.querySelector('strong')?.textContent).toBe('NO FEED');
  // The sentence lives in the closed banner; the gate does not repeat it.
  expect(element.textContent).not.toContain('no feed available for this market');
  expect(element.querySelector('[data-testid="chart-startup-resubscribe"]')).toBeNull();
  act(() => element.querySelector<HTMLButtonElement>('[data-testid="chart-startup-search"]')?.click());
  expect(onSearchSymbols).toHaveBeenCalledOnce();
});

it('offers a retry on the current instrument and a symbol search when history is unavailable', () => {
  residentCount = 0;
  const onResubscribe = vi.fn();
  const onSearchSymbols = vi.fn();
  act(() => root.render(
    <ChartStartupGate rendererRef={rendererRef} onResubscribe={onResubscribe} onSearchSymbols={onSearchSymbols} />,
  ));
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
  const retry = element.querySelector<HTMLButtonElement>('[data-testid="chart-startup-resubscribe"]');
  expect(retry?.textContent).toBe('Retry');
  act(() => retry?.click());
  expect(onResubscribe).toHaveBeenCalledWith('binance-spot', 'BTCUSDT');
  act(() => element.querySelector<HTMLButtonElement>('[data-testid="chart-startup-search"]')?.click());
  expect(onSearchSymbols).toHaveBeenCalledOnce();
});

it('shows no recovery controls when the host supplies none', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
  expect(element.querySelector('.chart-startup__actions')).toBeNull();
});

it('hides the gate while disabled', () => {
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} disabled />));
  expect(element.querySelector('[role="status"]')).toBeNull();
  expect(callbacks.size).toBe(0);
});

it('waits for a fresh presentation after the graphics error is cleared', () => {
  reveal();
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} disabled />));
  renderer.marketFrameReady = false;
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} />));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal(1000);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('reveals real recorded history when the market is closed', () => {
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal();
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('reports unavailable history for an attached closed feed with no retained columns', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
  expect(element.textContent).toContain('No recorded or provider history is available. Choose another symbol or try again.');
  expect(element.querySelector('.chart-startup__mark')).toBeNull();
  expect(element.textContent).toContain('BTCUSDT');
  frame(100_000);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
});

it('keeps closed history pending presentation distinct from an unavailable provider', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.textContent).toContain('Historical data unavailable');
  // A closed Status can arrive immediately before its real historical columns.
  residentCount = 10;
  frame(116);
  expect(element.textContent).toContain('MARKET CLOSED');
  expect(element.textContent).not.toContain('Historical data unavailable');
  renderer.marketFrameReady = true;
  frame(132);
  frame(148);
  frame(164);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(180);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('does not call a GPU rebuild unavailable history after real columns were retained', () => {
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  reveal();
  renderer.marketFrameReady = false;
  residentCount = 0; // the graphics restore temporarily re-creates an empty ring
  frame(300);
  expect(element.textContent).toContain('MARKET CLOSED');
  expect(element.textContent).not.toContain('Historical data unavailable');
});

it('requires a connected session and a known empty range before reporting unavailable history', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed', sessionId: null }));
  frame(100);
  expect(element.textContent).not.toContain('Historical data unavailable');
  act(() => useFlowMapStore.setState({ sessionId: 'btc-session', status: 'reconnecting' }));
  frame(200);
  expect(element.textContent).not.toContain('Historical data unavailable');
  delete renderer.residentRange;
  act(() => useFlowMapStore.setState({ status: 'live' }));
  frame(300);
  expect(element.textContent).not.toContain('Historical data unavailable');
});

it('reveals a successfully drawn market on a slow display without requiring 25 FPS', () => {
  renderer.marketFrameReady = true;
  frame(0);
  frame(100);
  frame(200);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(300);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('shows a chart failure with Retry and Copy diagnostics instead of Preparing chart', () => {
  const onRetry = vi.fn();
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} onRetry={onRetry} />));
  expect(element.textContent).toContain('Preparing chart');
  renderFailure = 'shader link failed: uniform u_norm';
  frame(100);
  frame(1700);
  expect(element.querySelector('[role="status"]')).toBeNull();
  const alert = element.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Chart could not start');
  expect(alert?.textContent).toContain('shader link failed: uniform u_norm');
  expect(element.textContent).not.toContain('Preparing chart');
  act(() => (element.querySelector('[data-testid="chart-startup-retry"]') as HTMLButtonElement).click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  renderFailure = null;
  frame(200);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.querySelector('[role="status"]')).not.toBeNull();
});

it('does not swap the chart for the failure view on a single bad frame', () => {
  const onRetry = vi.fn();
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} onRetry={onRetry} />));
  renderFailure = 'one-off frame error';
  frame(100);
  frame(116);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  renderFailure = null;
  frame(132);
  frame(1800);
  expect(element.querySelector('[role="alert"]')).toBeNull();
});

it('omits Retry when no retry handler is supplied', () => {
  renderFailure = 'boom';
  frame(100);
  frame(1700);
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(element.querySelector('[data-testid="chart-startup-retry"]')).toBeNull();
  expect(element.querySelector('[data-testid="chart-startup-copy"]')).not.toBeNull();
});

it('copies plain-text diagnostics to the clipboard and reports the outcome', async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    renderFailure = 'shader link failed';
    frame(100);
    frame(1700);
    await act(async () => {
      (element.querySelector('[data-testid="chart-startup-copy"]') as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('FlowMap chart diagnostics');
    expect(copied).toContain('render failure: shader link failed');
    expect(copied).toContain('instrument: binance-spot:BTCUSDT');
    expect(element.querySelector('[data-testid="chart-startup-copy-state"]')?.textContent).toBe('Diagnostics copied to the clipboard.');

    writeText.mockRejectedValueOnce(new Error('denied'));
    await act(async () => {
      (element.querySelector('[data-testid="chart-startup-copy"]') as HTMLButtonElement).click();
    });
    expect(element.querySelector('[data-testid="chart-startup-copy-state"]')?.textContent).toBe('Could not copy. Select the technical details instead.');
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('builds diagnostics without empty session or instrument fields', () => {
  const text = chartDiagnosticsText({
    failure: 'gl lost',
    connection: 'live',
    feed: 'closed',
    sessionId: null,
    instrument: null,
    now: new Date('2026-11-08T10:00:00.000Z'),
    userAgent: 'test-agent',
  });
  expect(text).toBe([
    'FlowMap chart diagnostics',
    'time: 2026-11-08T10:00:00.000Z',
    'render failure: gl lost',
    'connection: live',
    'feed: closed',
    'session: none',
    'instrument: none',
    'user agent: test-agent',
  ].join('\n'));
});
