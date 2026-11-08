import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version } from '../../package.json';
import { setLocale, t } from '../i18n';
import { FONT_LICENSES } from '../theme/fontLicenses';
import { AboutDialog, APP_LICENSE, DATA_SOURCES, REPO_URL } from './About';
import { resetOverlays } from './overlayStack';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Win = { __TAURI_INTERNALS__?: unknown };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** The dialog is a portal into document.body, so every query runs from there. */
function mount(onClose = vi.fn()): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<AboutDialog onClose={onClose} />);
  });
  return document.body;
}

/** A Tauri IPC bridge whose invoke is the given mock (desktop shell). */
function installShell(invoke: ReturnType<typeof vi.fn>): void {
  (window as unknown as Win).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: () => 1,
  };
}

beforeEach(() => {
  resetOverlays();
  setLocale('en');
  delete (window as unknown as Win).__TAURI_INTERNALS__;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  delete (window as unknown as Win).__TAURI_INTERNALS__;
  resetOverlays();
  vi.restoreAllMocks();
});

describe('AboutDialog', () => {
  it('states the version, the licence, the data-source attribution and the not-investment-advice notice', () => {
    const el = mount();
    const dialog = el.querySelector('[data-testid="about-dialog"]');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(el.querySelector('[data-testid="about-version"]')?.textContent)
      .toBe(t('about.version', { version }));
    expect(el.textContent).toContain(t('about.license', { license: APP_LICENSE }));
    expect(APP_LICENSE).toBe('Apache-2.0');
    expect(el.querySelector('[data-testid="about-sources"]')?.textContent)
      .toBe(t('about.sourcesBody', { sources: DATA_SOURCES }));
    expect(DATA_SOURCES).toContain('Binance');
    expect(DATA_SOURCES).toContain('Google Finance');
    expect(DATA_SOURCES).not.toContain('FRED');
    expect(el.querySelector('[data-testid="about-not-advice"]')?.textContent).toBe(t('about.notAdvice'));
  });

  it('offers no log action outside the desktop shell', () => {
    const el = mount();
    expect(el.querySelector('[data-testid="about-open-logs"]')).toBeNull();
  });

  it('opens the engine log folder through the shell and reports the outcome', async () => {
    const invoke = vi.fn(async () => undefined);
    installShell(invoke);
    const el = mount();
    const button = el.querySelector<HTMLButtonElement>('[data-testid="about-open-logs"]');
    expect(button?.textContent).toBe(t('about.openLogs'));
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('open_log_folder');
    expect(el.querySelector('[data-testid="about-logs-state"]')?.textContent).toBe(t('about.openLogsDone'));
  });

  it('says when the log folder cannot be opened', async () => {
    installShell(vi.fn(async () => {
      throw new Error('no file manager');
    }));
    const el = mount();
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="about-open-logs"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="about-logs-state"]')?.textContent).toBe(t('about.openLogsFailed'));
  });

  it('closes on the close button, Escape and a backdrop click', () => {
    const onClose = vi.fn();
    const el = mount(onClose);
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="about-close"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => {
      el.querySelector<HTMLElement>('[data-testid="about-backdrop"]')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('moves focus into the dialog on open', () => {
    const el = mount();
    expect(document.activeElement).toBe(el.querySelector('[data-testid="about-close"]'));
  });
});

describe('AboutDialog licence, fonts and source', () => {
  it('lists every bundled font licence, with its full text, in a section that starts collapsed', () => {
    const el = mount();
    const fonts = el.querySelector<HTMLDetailsElement>('[data-testid="about-fonts"]');
    expect(fonts).not.toBeNull();
    expect(fonts!.open).toBe(false);
    expect(FONT_LICENSES.length).toBeGreaterThan(0);
    for (const font of FONT_LICENSES) {
      expect(fonts!.textContent).toContain(font.family);
      expect(fonts!.textContent).toContain(font.text);
    }
  });

  it('links the source repository outside the desktop shell', () => {
    const el = mount();
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="about-source"] a');
    expect(link?.getAttribute('href')).toBe(REPO_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('shows the repository address as text, not a link, inside the desktop shell', () => {
    installShell(vi.fn(async () => undefined));
    const el = mount();
    const source = el.querySelector('[data-testid="about-source"]');
    expect(source?.querySelector('a')).toBeNull();
    expect(source?.querySelector('code')?.textContent).toBe(REPO_URL);
  });

  it('keeps Tab inside the dialog when the fonts summary is the last control', () => {
    const el = mount();
    const dialog = el.querySelector<HTMLElement>('[data-testid="about-dialog"]')!;
    const summary = el.querySelector<HTMLElement>('[data-testid="about-fonts"] summary')!;
    act(() => {
      summary.focus();
    });
    expect(document.activeElement).toBe(summary);
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(el.querySelector('[data-testid="about-close"]'));
  });
});
