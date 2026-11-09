/**
 * The chart canvas is the one focus stop of the workspace, so it must announce
 * what it is and how to drive it (WCAG 4.1.2, 2.1.1).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';
import { setLocale, t } from './i18n';
import { markOnboarded, ONBOARDING_KEY } from './ui/OnboardingCard';
import { setSingleKeyShortcutsEnabled } from './input/shortcutPrefs';

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
  setFlowMapTransport({});
  window.localStorage.removeItem(ONBOARDING_KEY);
  setSingleKeyShortcutsEnabled(true);
  setLocale('en');
});

describe('App — chart canvas accessibility', () => {
  it('is a named application region with a keyboard reference, reachable by Tab', () => {
    const container = mountApp();
    const canvas = container.querySelector<HTMLCanvasElement>('canvas#gl')!;
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('aria-label')).toBe(t('chart.ariaLabel', { instrument: 'sim:SIM-DEMO' }));
    expect(canvas.getAttribute('aria-label')).not.toBe('');

    const describedBy = canvas.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const help = container.ownerDocument.getElementById(describedBy!);
    expect(help?.textContent).toBe(t('chart.ariaHelp'));
    expect(help?.classList.contains('app-visually-hidden')).toBe(true);
  });

  it('drops the bare-key sentence from the keyboard reference while the single-key switch is off', () => {
    setSingleKeyShortcutsEnabled(false);
    const container = mountApp();
    const canvas = container.querySelector<HTMLCanvasElement>('canvas#gl')!;
    const help = container.ownerDocument.getElementById(canvas.getAttribute('aria-describedby')!);
    expect(help?.textContent).toBe(t('chart.ariaHelpNoKey'));
    expect(help?.textContent).not.toBe(t('chart.ariaHelp'));
  });
});
