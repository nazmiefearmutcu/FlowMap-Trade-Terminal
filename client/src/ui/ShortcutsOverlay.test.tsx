/**
 * ShortcutsOverlay — the `?` dialog. Pinned: it is a proper dialog
 * (role/aria-modal), Escape closes it, Tab is trapped inside, and the shared
 * `isHelpToggle` routing never fires while typing or inside another dialog.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '../i18n';
import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { isHelpToggle, KEYSHEET } from './keysheet';
import { isBareKeyRow } from './SettingsDrawerKeys';
import { resetOverlays } from './overlayStack';
import { SettingsDrawer } from './SettingsDrawer';
import { DEFAULT_SETTINGS } from './settings';
import { ShortcutsOverlay } from './ShortcutsOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setLocale('en');
  setSingleKeyShortcutsEnabled(true);
  resetOverlays();
});

function render(): { container: HTMLElement; onClose: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onClose = vi.fn();
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<ShortcutsOverlay onClose={onClose} />);
  });
  mounted.push({ container, root });
  return { container, onClose };
}

function overlay(): HTMLElement | null {
  return document.body.querySelector('[data-testid="shortcuts-overlay"]');
}

describe('isHelpToggle — the `?` routing decision', () => {
  it('fires on `?` from a plain target', () => {
    expect(isHelpToggle('?', { editable: false, dialog: false })).toBe(true);
  });

  it('never fires while typing or while a dialog owns the keyboard', () => {
    expect(isHelpToggle('?', { editable: true, dialog: false })).toBe(false);
    expect(isHelpToggle('?', { editable: false, dialog: true })).toBe(false);
    // And plain `/` (no shift) is the palette shortcut, not the help toggle.
    expect(isHelpToggle('/', { editable: false, dialog: false })).toBe(false);
  });
});

describe('ShortcutsOverlay', () => {
  it('renders a modal dialog listing the shared keysheet', () => {
    render();
    const el = overlay();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('dialog');
    expect(el!.getAttribute('aria-modal')).toBe('true');
    const rows = document.body.querySelectorAll('[data-testid="shortcuts-list"] .keysheet__row');
    expect(rows.length).toBe(KEYSHEET.length);
    // The sheet is the SHARED source of truth: it names the `?` toggle itself.
    expect(el!.textContent).toContain('toggle this shortcuts overlay');
  });

  it('renders the action strings through t() and follows the locale', () => {
    render();
    const el = overlay()!;
    expect(el.textContent).toContain('export the chart as a PNG download');

    act(() => setLocale('tr'));
    expect(el.textContent).toContain('grafiği PNG olarak indir');
    expect(el.textContent).toContain('bu kısayol penceresini aç-kapat');
    // The key label column is locale-independent.
    expect(el.textContent).toContain('Space');
    expect(el.textContent).toContain('Ctrl+Z');
  });

  it('says how the single-key shortcuts can be turned off, in the active locale', () => {
    render();
    const note = document.body.querySelector('[data-testid="shortcuts-single-key-note"]');
    expect(note?.textContent).toBe(t('shortcuts.singleKeysHint'));
    expect(note?.textContent).toContain('Turn off');
    act(() => setLocale('tr'));
    expect(document.body.querySelector('[data-testid="shortcuts-single-key-note"]')?.textContent)
      .toBe(t('shortcuts.singleKeysHint'));
    expect(document.body.querySelector('[data-testid="shortcuts-single-key-note"]')?.textContent)
      .toContain('Kapatırsanız');
  });

  it('keeps every row listed and marks the bare-key rows off while single-key shortcuts are off', () => {
    render();
    const rowKeys = (): string[] => [...document.body.querySelectorAll('[data-testid="shortcuts-list"] .keysheet__keys')]
      .map((el) => el.textContent ?? '');
    const offKeys = (): string[] => [...document.body.querySelectorAll('[data-testid="shortcuts-list"] .keysheet__row.is-off .keysheet__keys')]
      .map((el) => el.textContent ?? '');
    expect(rowKeys()).toEqual(KEYSHEET.map((entry) => entry.keys));
    expect(offKeys()).toEqual([]);
    act(() => setSingleKeyShortcutsEnabled(false));
    expect(rowKeys()).toEqual(KEYSHEET.map((entry) => entry.keys));
    expect(offKeys()).toEqual(KEYSHEET.filter((entry) => isBareKeyRow(entry.keys)).map((entry) => entry.keys));
    expect(offKeys()).toContain('Space');
    expect(offKeys()).not.toContain('⌘K / Ctrl+K');
    // The note says the marked keys do nothing and where to turn them back on.
    const note = document.body.querySelector('[data-testid="shortcuts-single-key-note"]');
    expect(note?.textContent).toBe(t('shortcuts.singleKeysOffHint'));
    expect(note?.textContent).not.toBe(t('shortcuts.singleKeysHint'));
    act(() => setSingleKeyShortcutsEnabled(true));
    expect(offKeys()).toEqual([]);
    expect(document.body.querySelector('[data-testid="shortcuts-single-key-note"]')?.textContent)
      .toBe(t('shortcuts.singleKeysHint'));
  });

  it('names the ? toggle in the footer only while single-key shortcuts are on', () => {
    render();
    const footer = (): string => document.body.querySelector('.keyshelp__foot')?.textContent ?? '';
    expect(footer()).toContain(t('shortcuts.footerToggle'));
    act(() => setSingleKeyShortcutsEnabled(false));
    expect(footer()).not.toContain(t('shortcuts.footerToggle'));
    expect(footer()).toContain(t('shortcuts.footerClose'));
    act(() => setSingleKeyShortcutsEnabled(true));
    expect(footer()).toContain(t('shortcuts.footerToggle'));
  });

  it('moves focus to its close button and Escape closes', () => {
    const { onClose } = render();
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="shortcuts-close"]'),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`?` closes it — the toggle works in BOTH directions (the footer says '? toggle')", () => {
    const { onClose } = render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A chorded keystroke is never the help toggle.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', ctrlKey: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with single-key shortcuts switched off, ? leaves the overlay open and Escape still closes it', () => {
    setSingleKeyShortcutsEnabled(false);
    const { onClose } = render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes ONLY the overlay when it sits above the settings drawer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const drawerClose = vi.fn();
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(
        <SettingsDrawer
          settings={DEFAULT_SETTINGS}
          onChange={() => {}}
          onClose={drawerClose}
        />,
      );
    });
    mounted.push({ container, root });

    const { onClose } = render(); // opened AFTER the drawer → topmost
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(drawerClose).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog', () => {
    render();
    const closeBtn = document.body.querySelector(
      '[data-testid="shortcuts-close"]',
    ) as HTMLButtonElement;
    // Tab from the LAST focusable wraps to the FIRST.
    act(() => {
      const rows = [...document.body.querySelectorAll<HTMLElement>('.keyshelp button, .keyshelp [href]')];
      rows[rows.length - 1].focus();
      closeBtn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
    });
    const firstInPanel = document.body.querySelector<HTMLElement>('.keyshelp button');
    expect(document.activeElement).toBe(firstInPanel);
  });
});
