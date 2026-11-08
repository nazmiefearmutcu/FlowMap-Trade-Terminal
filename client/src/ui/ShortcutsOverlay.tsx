/**
 * The `?` shortcuts overlay — a small centred modal listing every real
 * binding, from the same {@link KEYSHEET} the settings drawer renders. Toggled
 * by the App-level `?` handler (see ui/keysheet.ts `isHelpToggle`), it is a
 * proper dialog: `role="dialog"` + `aria-modal`, focus moves to the close
 * button on open and returns to the opener on close, Tab is trapped inside,
 * and Escape (or clicking the backdrop) dismisses it.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { isTopOverlay, pushOverlay } from './overlayStack';
import { isHelpToggle, keysheetRows } from './keysheet';
import { classifyTarget } from '../input/keys';
import { isSingleKeyShortcutsEnabled, useSingleKeyShortcuts } from '../input/shortcutPrefs';
import { useT } from '../i18n/useT';

interface ShortcutsOverlayProps {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps): JSX.Element {
  const t = useT(); // i18n shell pass
  // The footer names the `?` toggle only while single-key shortcuts are on, and
  // the sheet lists only the bindings that currently work.
  const singleKeys = useSingleKeyShortcuts();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // The overlay joins the open-overlay registry while mounted: window-level
  // Escape handlers elsewhere (settings drawer) defer to whichever surface is
  // topmost, so one Escape closes only this overlay — never both at once.
  useEffect(() => pushOverlay('shortcuts'), []);

  // Escape closes, and `?` toggles (the footer says so) — window-level so both
  // work wherever focus sits inside the overlay. Being registry-topmost is what
  // lets this handler act without also firing the drawer's Escape handler.
  // `?` shares the App-level predicate (isHelpToggle): a '?' typed into an
  // editable is a character, not a toggle. With single-key shortcuts switched off
  // (WCAG 2.1.4) only Escape closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!isTopOverlay('shortcuts')) return;
      const ctx = classifyTarget(e.target);
      const helpToggle = isSingleKeyShortcutsEnabled() && isHelpToggle(e.key, ctx);
      if (e.key === 'Escape' || helpToggle) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Modal focus management, same contract as SettingsDrawer: capture the opener,
  // move focus inside on open, restore it on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trap Tab / Shift+Tab within the overlay while it is open.
  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="keyshelp__backdrop"
      data-testid="shortcuts-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="keyshelp"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        data-testid="shortcuts-overlay"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="keyshelp__head">
          <span className="keyshelp__title">{t('shortcuts.title')}</span>
          <button
            ref={closeRef}
            type="button"
            className="keyshelp__close"
            onClick={onClose}
            data-testid="shortcuts-close"
            aria-label={t('shortcuts.close')}
          >
            ✕
          </button>
        </header>
        <div className="keysheet keyshelp__sheet" data-testid="shortcuts-list">
          {keysheetRows(singleKeys).map((entry) => (
            <div key={entry.keys} className="keysheet__row">
              <kbd className="keysheet__keys">{entry.keys}</kbd>
              <span className="keysheet__action">{t(entry.actionKey)}</span>
            </div>
          ))}
        </div>
        <div className="keyshelp__foot">
          <span>
            {singleKeys && (
              <>
                <kbd>?</kbd> {t('shortcuts.footerToggle')} ·{' '}
              </>
            )}
            <kbd>esc</kbd> {t('shortcuts.footerClose')}
          </span>
        </div>
        <div className="keyshelp__foot" data-testid="shortcuts-single-key-note">
          <span>{singleKeys ? t('shortcuts.singleKeysHint') : t('shortcuts.singleKeysOff')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
