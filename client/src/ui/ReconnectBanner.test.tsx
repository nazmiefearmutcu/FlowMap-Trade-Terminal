/**
 * ReconnectBanner — truthful reconnect state. It renders ONLY while the
 * store's connection status is literally `reconnecting`, and it names the
 * market:symbol it is trying to reach. Live / connecting / idle render nothing —
 * a banner that guessed would be exactly the dishonesty this app refuses.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '../i18n';
import { useFlowMapStore } from '../state/store';
import { ReconnectBanner, closeReasonText } from './ReconnectBanner';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setLocale('en');
  useFlowMapStore.setState({ status: 'idle', lastClose: null, reconnectAttempts: 0, protocolMismatch: null, refusal: null });
});

function render(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<ReconnectBanner />);
  });
  mounted.push({ container, root });
}

describe('closeReasonText', () => {
  it('spells the codes the server actually sends, honestly', () => {
    expect(closeReasonText(null)).toBe('connection dropped');
    expect(closeReasonText({ code: 1001, wasClean: true })).toBe('server shut down');
    expect(closeReasonText({ code: 1000, wasClean: true })).toBe('server closed the session');
    expect(closeReasonText({ code: 1013, wasClean: true })).toBe('server overloaded');
    expect(closeReasonText({ code: null, wasClean: false })).toBe('connection dropped');
    expect(closeReasonText({ code: 1006, wasClean: false })).toBe('connection dropped');
    expect(closeReasonText({ code: 4321, wasClean: true })).toBe('server closed (code 4321)');
  });
});

describe('ReconnectBanner', () => {
  it('renders nothing while live — only the reconnecting state earns a banner', () => {
    useFlowMapStore.setState({ status: 'live' });
    render();
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
  });

  it('names the target and is announced politely while reconnecting', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      subscription: {
        market: 'kraken',
        symbol: 'XBT/USD',
        mode: 'live',
      } as unknown as ReturnType<typeof useFlowMapStore.getState>['subscription'],
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('status');
    expect(el!.getAttribute('aria-live')).toBe('polite');
    expect(el!.textContent).toContain('kraken:XBT/USD');
    expect(el!.textContent).toContain('reconnecting');
  });

  it('shows the close reason and the attempt count (calm, one line)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      lastClose: { code: 1001, wasClean: true },
      reconnectAttempts: 3,
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el!.textContent).toContain('server shut down');
    expect(el!.textContent).toContain('attempt 3');
  });

  it('retry-now fires exactly one retry (the store action)', () => {
    const retryNow = vi.fn();
    useFlowMapStore.setState({ status: 'reconnecting', retryNow });
    render();
    const btn = document.body.querySelector('[data-testid="reconnect-retry"]');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retryNow).toHaveBeenCalledTimes(1);
  });

  it('translates the framing strings in TR while the reason keeps its own translation', () => {
    setLocale('tr');
    useFlowMapStore.setState({
      status: 'reconnecting',
      lastClose: { code: 1001, wasClean: true },
      reconnectAttempts: 3,
      subscription: {
        market: 'kraken',
        symbol: 'XBT/USD',
        mode: 'live',
      } as unknown as ReturnType<typeof useFlowMapStore.getState>['subscription'],
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]')!;
    expect(el.textContent).toContain('bağlantı koptu');
    expect(el.textContent).toContain('kraken:XBT/USD');
    expect(el.textContent).toContain('için yeniden bağlanılıyor');
    expect(el.textContent).toContain('sunucu kapatıldı');
    expect(el.textContent).toContain('deneme 3');
    const btn = el.querySelector('[data-testid="reconnect-retry"]')!;
    expect(btn.textContent).toBe('Yeniden dene');
    expect(btn.getAttribute('title')).toBe('beklemeden hemen yeniden bağlan');
  });

  it('names the fallback target through the EN table (byte-identical fallback)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      subscription: undefined,
      reconnectAttempts: 0,
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]')!;
    expect(el.textContent).toContain('reconnecting to the feed');
  });
});

describe('ReconnectBanner terminal and escalated states', () => {
  it('shows a fatal protocol-mismatch alert with no retry control, even while not reconnecting', () => {
    useFlowMapStore.setState({ status: 'closed', protocolMismatch: { got: 9, expected: 3 } });
    render();
    const el = document.body.querySelector('[data-testid="protocol-mismatch-banner"]')!;
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toContain('The engine speaks protocol 9, but this FlowMap build expects 3.');
    expect(el.textContent).toContain('retrying will not help');
    expect(document.body.querySelector('[data-testid="reconnect-retry"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
  });

  it('shows the refusal copy with no retry control, and never the raw server token', () => {
    for (const reason of ['invalid_symbol', 'no recording for this session']) {
      useFlowMapStore.setState({ status: 'closed', refusal: { reason } });
      render();
      const el = document.body.querySelector('[data-testid="refusal-banner"]')!;
      expect(el.getAttribute('role')).toBe('alert');
      expect(el.textContent).toBe(t('banner.refused'));
      expect(el.textContent).not.toContain(reason);
      expect(document.body.querySelector('[data-testid="reconnect-retry"]')).toBeNull();
    }
  });

  it('uses the plain refusal copy when the server gives no reason', () => {
    useFlowMapStore.setState({ status: 'closed', refusal: { reason: null } });
    render();
    const el = document.body.querySelector('[data-testid="refusal-banner"]')!;
    expect(el.textContent).toBe(t('banner.refused'));
  });

  it('keeps the plain attempt copy below the escalation threshold', () => {
    useFlowMapStore.setState({ status: 'reconnecting', reconnectAttempts: 7 });
    render();
    const text = document.body.querySelector('[data-testid="reconnect-banner"]')!.textContent ?? '';
    expect(text).toContain('attempt 7');
    expect(text).not.toContain('still failing');
  });

  it('escalates the reconnect copy from eight attempts on', () => {
    useFlowMapStore.setState({ status: 'reconnecting', reconnectAttempts: 8 });
    render();
    const text = document.body.querySelector('[data-testid="reconnect-banner"]')!.textContent ?? '';
    expect(text).toContain('still failing after 8 attempts');
    expect(text).not.toContain('attempt 8');
  });

  it('localizes the 1002 and 1003 close reasons through the banner keys', () => {
    setLocale('tr');
    expect(closeReasonText({ code: 1002, wasClean: true })).toBe('bağlantı protokol hatası');
    expect(closeReasonText({ code: 1003, wasClean: true })).toBe('abonelik reddedildi');
    setLocale('en');
    expect(closeReasonText({ code: 1002, wasClean: true })).toBe('protocol error');
    expect(closeReasonText({ code: 1003, wasClean: true })).toBe('subscription refused');
  });
});
