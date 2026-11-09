/**
 * OnboardingCard tests: first-run auto-open, 3-step wizard,
 * Skip/Done persistence, Esc/scrim defer-without-persist, focus trap +
 * focus restore, reopen via openOnboarding, i18n'd copy.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../i18n';
import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import {
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  OnboardingCard,
  closeOnboarding,
  hasSeenOnboarding,
  markOnboarded,
  openOnboarding,
  stepBodyKey,
} from './OnboardingCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<OnboardingCard />);
  });
  mounted.push({ container, root });
  return container;
}

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="onboarding-dialog"]');
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
}

beforeEach(() => {
  localStorage.clear();
  closeOnboarding();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  closeOnboarding();
  localStorage.clear();
  setLocale('en');
  setSingleKeyShortcutsEnabled(true);
});

describe('switch-aware step copy', () => {
  it('names the bare keys on the mouse step only while single-key shortcuts are on', () => {
    const mouse = ONBOARDING_STEPS[1];
    expect(stepBodyKey(mouse, true)).toBe('onboarding.step.mouse.body');
    expect(stepBodyKey(mouse, false)).toBe('onboarding.step.mouse.bodyNoKey');
    const connect = ONBOARDING_STEPS[0];
    expect(stepBodyKey(connect, false)).toBe(connect.bodyKey);
  });

  it('renders the no-key body when the switch is off, and the bare-key body when it is on', () => {
    setSingleKeyShortcutsEnabled(false);
    const container = render();
    act(() => (container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement).click());
    const body = container.querySelector('[data-testid="onboarding-body"]')!.textContent ?? '';
    expect(body).toContain('Shift with the up or down arrow zooms price');
    expect(body).not.toContain('+ / − zoom price');
    act(() => (container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement).click());
    const shortcuts = container.querySelector('[data-testid="onboarding-body"]')!.textContent ?? '';
    expect(shortcuts).toContain('Turn them on under Settings, Keyboard');
    expect(shortcuts).not.toContain('Press ? anytime');
  });

  it('keeps the bare-key copy while the switch is on', () => {
    const container = render();
    act(() => (container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="onboarding-body"]')!.textContent).toContain('+ / − zoom price');
  });
});

describe('first run', () => {
  it('says the first chart is simulated and that recording writes to disk, before any market is chosen', () => {
    const container = render();
    const notes = container.querySelector('[data-testid="onboarding-notes"]');
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain('SIM-DEMO');
    expect(notes!.textContent).toContain('synthetic');
    expect(notes!.textContent).toContain('20 GB');
    expect(notes!.textContent).toContain('app-data folder');
    expect(notes!.textContent).toContain('Settings, Data');
  });

  it('opens automatically when the tour was never acknowledged', () => {
    const container = render();
    expect(dialog(container)).not.toBeNull();
    expect(dialog(container)!.getAttribute('role')).toBe('dialog');
    expect(dialog(container)!.getAttribute('aria-modal')).toBe('true');
  });

  it('stays closed once acknowledged (Skip or Done persisted)', () => {
    markOnboarded();
    const container = render();
    expect(dialog(container)).toBeNull();
    expect(hasSeenOnboarding()).toBe(true);
  });
});

describe('wizard steps', () => {
  it('walks 3 steps, then Done persists and closes', () => {
    const container = render();
    const stepOf = () => container.querySelector('[data-testid="onboarding-step-of"]')!.textContent;
    const next = () => container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement;

    expect(stepOf()).toBe('Step 1 of 3');
    act(() => next().click());
    expect(stepOf()).toBe('Step 2 of 3');
    act(() => next().click());
    expect(stepOf()).toBe('Step 3 of 3');
    expect(next().textContent).toBe('Done');

    act(() => next().click());
    expect(dialog(container)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe('1');
  });

  it('Skip persists from any step', () => {
    const container = render();
    const skip = container.querySelector('[data-testid="onboarding-skip"]') as HTMLButtonElement;
    act(() => skip.click());
    expect(dialog(container)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe('1');
  });

  it('restarting the tour always begins at step 1', () => {
    const container = render();
    const next = () => container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement;
    act(() => next().click());
    act(() => {
      pressKey('Escape');
    });
    expect(dialog(container)).toBeNull();
    act(() => {
      openOnboarding();
    });
    expect(
      container.querySelector('[data-testid="onboarding-step-of"]')!.textContent,
    ).toBe('Step 1 of 3');
  });
});

describe('dismissal semantics', () => {
  it('Escape closes but never persists — the tour returns next launch', () => {
    const container = render();
    act(() => {
      pressKey('Escape');
    });
    expect(dialog(container)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
    expect(hasSeenOnboarding()).toBe(false);

    const again = render();
    expect(dialog(again)).not.toBeNull();
  });

  it('scrim click defers too', () => {
    const container = render();
    act(() => {
      (container.querySelector('[data-testid="onboarding-scrim"]') as HTMLElement).click();
    });
    expect(dialog(container)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
  });

  it('openOnboarding() re-opens even after dismissal', () => {
    markOnboarded();
    const container = render();
    expect(dialog(container)).toBeNull();
    act(() => {
      openOnboarding();
    });
    expect(dialog(container)).not.toBeNull();
  });
});

describe('focus management', () => {
  it('moves focus into the dialog on open and restores it on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const container = render();
    expect(document.activeElement).toBe(dialog(container));

    act(() => {
      pressKey('Escape');
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps Tab: forward from the last control wraps to the first', () => {
    const container = render();
    const panel = dialog(container)!;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const last = focusables[focusables.length - 1];
    const first = focusables[0];
    act(() => {
      last.focus();
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
  });

  it('traps Tab: backward from the first control wraps to the last', () => {
    const container = render();
    const panel = dialog(container)!;
    const focusables = panel.querySelectorAll<HTMLElement>('button');
    const last = focusables[focusables.length - 1];
    const first = focusables[0];
    act(() => {
      first.focus();
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, shiftKey: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});

describe('i18n', () => {
  it('renders Turkish copy when the locale is tr', () => {
    setLocale('tr');
    const container = render();
    expect(container.querySelector('.onboard__title')!.textContent).toBe('FlowMap’e hoş geldiniz');
    const next = container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement;
    const skip = container.querySelector('[data-testid="onboarding-skip"]') as HTMLButtonElement;
    expect(next.textContent).toBe('İleri');
    expect(skip.textContent).toBe('Atla');
    act(() => next.click());
    act(() => next.click());
    expect(
      (container.querySelector('[data-testid="onboarding-next"]') as HTMLButtonElement).textContent,
    ).toBe('Tamam');
  });
});
