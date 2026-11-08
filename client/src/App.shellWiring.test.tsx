import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The shell wiring that the app-level props carry: the research drawer receives
// the active market and its sources link opens the About dialog, and the
// failed engine state shows its log path with an Open log folder action. The renderer is the same DOM-free double as App.replayPolicy.test.

const harness = vi.hoisted(() => {
  const renderer = {
    following: true, wantedFollowTime: true, priceFollow: 'fit', marketFrameReady: false,
    setFollowTime(on: boolean) { this.following = this.wantedFollowTime = on; },
    setPriceFollow(mode: string) { this.priceFollow = mode; },
    resetForSession() {}, timeline: () => null, historyStats: () => null, overviewStats: () => null,
    stats: () => ({ fps: 0, frameMs: 0, uploads: 0 }),
  };
  return { renderer: new Proxy(renderer, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => null,
  }) };
});
vi.mock('./gl/renderer', () => ({ Renderer: class { constructor() { return harness.renderer; } } }));

import { App } from './App';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import { useIntelligenceStore } from './state/intelligenceStore';
import { markOnboarded } from './ui/OnboardingCard';
import { setLocale } from './i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ShellWindow = { __TAURI_INTERNALS__?: unknown };

let root: Root;
let container: HTMLDivElement;
const click = (el: Element): void => { act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };

function mountApp(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '{}' })));
  window.localStorage.clear(); markOnboarded(); setLocale('en');
  setFlowMapTransport({ url: 'wss://test.invalid/ws', wsFactory: () => ({ binaryType: 'arraybuffer', onopen: null,
    onclose: null, onerror: null, onmessage: null, send() {}, close() {} }) });
  mountApp();
  await act(async () => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount()); container.remove();
  useFlowMapStore.getState().disconnect(); setFlowMapTransport({});
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
  delete (window as unknown as ShellWindow).__TAURI_INTERNALS__;
  document.body.replaceChildren();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

it('gives the research drawer the active market and opens the sources dialog from it', async () => {
  act(() => useFlowMapStore.setState({
    subscription: { market: 'binance-spot', symbol: 'BTCUSDT', band: 'deep', mode: 'live' },
  }));
  act(() => useIntelligenceStore.getState().setDrawerOpen(true));
  // A crypto market gets the equity-only note, which needs the market to reach the drawer.
  expect(container.querySelector('[data-testid="intel-equity-only"]')).not.toBeNull();

  click(container.querySelector('[data-testid="intel-open-sources"]')!);
  expect(container.querySelector('[data-testid="intelligence-drawer"]')).toBeNull();
  expect(document.querySelector('[data-testid="about-dialog"]')).not.toBeNull();
});

it('shows the failed engine state with its log path and an Open log folder action in the shell', async () => {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'sidecar_status') {
      return { state: 'failed', port: null, logPath: 'C:/data/flowmap-server.log', detail: '' };
    }
    return undefined;
  });
  (window as unknown as ShellWindow).__TAURI_INTERNALS__ = { invoke, transformCallback: () => 1 };
  act(() => root.unmount());
  container.remove();
  mountApp();
  await act(async () => root.render(<App />));
  await act(async () => {});

  const failed = container.querySelector('[data-testid="sidecar-failed"]');
  expect(failed?.textContent).toContain('C:/data/flowmap-server.log');
  click(container.querySelector('[data-testid="sidecar-open-logs"]')!);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('open_log_folder');
});

it('offers no log action outside the desktop shell', () => {
  expect(container.querySelector('[data-testid="sidecar-open-logs"]')).toBeNull();
});
