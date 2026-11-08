/**
 * App-level notices drawn over the chart stage: the desktop engine failure with
 * Retry, the stalled-recording notice, the explicit SIM/DEMO badge, and the
 * graphics fallback. The terminal connection states (a version mismatch and a
 * refused subscription) are drawn once, by the ReconnectBanner; this file checks
 * that the stage shows them exactly once. The socket never opens, so only the
 * shell's own state drives what the chart shows.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';
import { setLocale, t } from './i18n';
import { markOnboarded, ONBOARDING_KEY } from './ui/OnboardingCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class InertSocket implements SocketLike {
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

type Win = { __TAURI_INTERNALS__?: unknown };

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function mountApp(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<App />);
  });
  mounted.push({ container, root });
  return container;
}

/** A shell bridge whose sidecar_status answers with the given payload. */
function installShell(status: unknown): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'sidecar_status') return status;
    return undefined;
  });
  (window as unknown as Win).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: () => 1,
  };
  return invoke;
}

beforeEach(() => {
  window.localStorage.clear();
  setFlowMapTransport({ url: 'wss://test.invalid/ws', wsFactory: (url: string): SocketLike => new InertSocket(url) });
  markOnboarded();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  useFlowMapStore.getState().disconnect();
  useFlowMapStore.setState({ refusal: null, protocolMismatch: null, recordingDegraded: false });
  setFlowMapTransport({});
  delete (window as unknown as Win).__TAURI_INTERNALS__;
  window.localStorage.removeItem(ONBOARDING_KEY);
  setLocale('en');
});

describe('App notices', () => {
  it('shows the sim/demo badge while the simulated feed is the subscription', () => {
    const container = mountApp();
    expect(useFlowMapStore.getState().subscription?.market).toBe('sim');
    expect(container.querySelector('[data-testid="sim-badge"]')?.textContent).toContain('SIM');
  });

  it('a version mismatch is one fatal alert naming both protocol versions', () => {
    const container = mountApp();
    expect(container.querySelector('[data-testid="protocol-mismatch-banner"]')).toBeNull();
    act(() => {
      useFlowMapStore.setState({ protocolMismatch: { got: 9, expected: 2 } });
    });
    const alerts = container.querySelectorAll('[data-testid="protocol-mismatch-banner"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].getAttribute('role')).toBe('alert');
    expect(alerts[0].textContent).toContain('9');
    expect(alerts[0].textContent).toContain('2');
  });

  it('a refused subscription is one terminal notice with its translated reason and no retry control', () => {
    const container = mountApp();
    act(() => {
      useFlowMapStore.setState({ refusal: { reason: 'invalid_symbol' } });
    });
    const notices = container.querySelectorAll('[data-testid="refusal-banner"]');
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain(t('banner.refusalReason.invalidSymbol'));
    expect(notices[0].textContent).not.toContain('invalid_symbol');
    expect(notices[0].querySelector('button')).toBeNull();
  });

  it('a version mismatch takes precedence over a refusal notice', () => {
    const container = mountApp();
    act(() => {
      useFlowMapStore.setState({ refusal: { reason: null }, protocolMismatch: { got: 3, expected: 2 } });
    });
    expect(container.querySelector('[data-testid="protocol-mismatch-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="refusal-banner"]')).toBeNull();
  });

  it('a stalled recording shows a polite status notice that clears when recording recovers', () => {
    const container = mountApp();
    expect(container.querySelector('[data-testid="recording-degraded"]')).toBeNull();
    act(() => {
      useFlowMapStore.setState({ recordingDegraded: true });
    });
    const notice = container.querySelector('[data-testid="recording-degraded"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain(t('banner.recordingDegraded'));
    act(() => {
      useFlowMapStore.setState({ recordingDegraded: false });
    });
    expect(container.querySelector('[data-testid="recording-degraded"]')).toBeNull();
  });

  it('a failed desktop engine shows its log path and a Retry that asks the shell to restart it', async () => {
    const invoke = installShell({ state: 'failed', port: 8731, logPath: 'C:/logs/flowmap-server.log', detail: 'gave up' });
    const container = mountApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const failed = container.querySelector('[data-testid="sidecar-failed"]');
    expect(failed?.textContent).toContain('C:/logs/flowmap-server.log');
    const retry = failed?.querySelector('button');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('retry_sidecar');
  });

  it('a healthy engine shows no failure notice', async () => {
    installShell({ state: 'live', port: 8731, logPath: null, detail: '' });
    const container = mountApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="sidecar-failed"]')).toBeNull();
  });

  it('a plain browser (no shell bridge) never shows an engine notice', () => {
    const container = mountApp();
    expect(container.querySelector('[data-testid="sidecar-failed"]')).toBeNull();
  });

  it('the graphics fallback offers Retry and copy-diagnostics actions with localized labels', () => {
    setLocale('tr');
    const container = mountApp();
    const fallback = container.querySelector('[data-testid="gl-fallback"]');
    expect(fallback).not.toBeNull();
    const labels = [...(fallback?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(['Yeniden dene', 'Tanılamayı kopyala']);
  });

  it('a PNG export that cannot run says so in the active language', () => {
    setLocale('tr');
    const container = mountApp();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    });
    expect(container.textContent).toContain('PNG dışa aktarımı kullanılamıyor');
  });

  it('the first connect waits for a starting desktop engine', async () => {
    const created: string[] = [];
    setFlowMapTransport({
      url: 'wss://test.invalid/ws',
      wsFactory: (url: string): SocketLike => {
        created.push(url);
        return new InertSocket(url);
      },
    });
    installShell({ state: 'starting', port: null, logPath: null, detail: '' });
    mountApp();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(created).toHaveLength(0);
  });

  it('a plain browser connects at mount, with no engine wait', () => {
    const created: string[] = [];
    setFlowMapTransport({
      url: 'wss://test.invalid/ws',
      wsFactory: (url: string): SocketLike => {
        created.push(url);
        return new InertSocket(url);
      },
    });
    mountApp();
    expect(created.length).toBeGreaterThan(0);
  });
});
