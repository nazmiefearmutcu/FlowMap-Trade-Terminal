/**
 * Settings drawer. A right-side sheet exposing the workspace knobs:
 * colormap, normalization percentile, tick grouping, bubble-size threshold, follow
 * mode, right-rail visibility, and the heatmap overlay toggles.
 *
 * Every change flows up via `onChange(patch)`; the App merges it, persists the
 * whole object to localStorage, and applies the live-honourable knobs to the
 * renderer (bubble threshold, overlays, follow, rail). The display knobs (colormap
 * / normalization / tick grouping) are persisted so the choice survives reloads.
 */

import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/useT';
import { useIndicatorStore } from '../indicators/store';
import { useFlowMapStore } from '../state/store';
import { THEME_IDS, THEMES, useTheme } from '../theme';
import { resolveAppearance } from '../theme/appearance';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { RecordingSection } from './SettingsDrawerRecording';
import {
  SettingsAppearanceSection,
  SettingsDisplaySection,
  SettingsKeysSection,
  SettingsOverlaysSection,
  SettingsTradesSection,
  SettingsViewSection,
} from './SettingsDrawerSections';
import { DEFAULT_SETTINGS, type FlowMapSettings } from './settings';

/** A restore needs a second click within this window, because it discards every knob. */
const RESTORE_CONFIRM_MS = 4000;

interface SettingsDrawerProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
  onClose: () => void;
  /** Opens the About and legal dialog. Omitted: the entry is not shown. */
  onOpenAbout?: () => void;
}

export function SettingsDrawer({ settings, onChange, onClose, onOpenAbout }: SettingsDrawerProps): JSX.Element {
  const t = useT(); // re-renders on locale change
  const { theme, setTheme } = useTheme();
  const depthTier = useFlowMapStore((s) => s.capability?.depth);
  const synthetic = typeof depthTier === 'string' && depthTier.startsWith('SYNTH');
  const densityControlsDisabled = settings.depthChannel === 'imbalance' && !synthetic;
  // The indicator picker opened from this drawer is a dialog of its own. While it
  // is open this drawer is not modal, so the picker stays reachable by keyboard and
  // assistive technology.
  const pickerOpen = useIndicatorStore((s) => s.pickerOpen);
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Restore needs two clicks, and the previous settings can be put back until the
  // drawer closes: one stray click must not discard every tuned knob.
  const [restoreArmed, setRestoreArmed] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<FlowMapSettings | null>(null);

  // Esc closes the drawer — but only when the drawer is the TOPMOST open
  // overlay. If the `?` shortcuts overlay sits above it, that overlay's own
  // Escape handler owns the keystroke; `stopPropagation` cannot express this
  // between two listeners on the same window target (see ui/overlayStack.ts).
  // `e.defaultPrevented` covers the other half: a surface whose
  // Escape is handled in REACT (the symbol palette) flushes its update — and
  // its registry pop — before this window listener runs, so the stack alone
  // would read this drawer as top and close a second surface on one Escape.
  // A consumed keystroke must stay consumed.
  useEffect(() => {
    const off = pushOverlay('settings');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTopOverlay('settings')) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [onClose]);

  // Modal focus management: capture the opener, move focus inside on open, and
  // restore it on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trap Tab / Shift+Tab within the drawer while it is open (not while the picker is).
  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || pickerOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    const focusable = aside.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !aside.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!restoreArmed) return;
    const id = window.setTimeout(() => setRestoreArmed(false), RESTORE_CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [restoreArmed]);

  const restoreDefaults = (): void => {
    if (!restoreArmed) {
      setRestoreArmed(true);
      return;
    }
    setRestoreArmed(false);
    setUndoSnapshot(settings);
    onChange({ ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_SETTINGS.overlays } });
  };

  const undoRestore = (): void => {
    if (!undoSnapshot) return;
    onChange({ ...undoSnapshot, overlays: { ...undoSnapshot.overlays } });
    setUndoSnapshot(null);
  };

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} data-testid="settings-scrim" />
      <aside
        ref={asideRef}
        className="drawer"
        role="dialog"
        aria-modal={pickerOpen ? 'false' : 'true'}
        aria-label={t('drawer.title')}
        data-testid="settings-drawer"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="drawer__header">
          <h2 className="drawer__title">{t('drawer.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            className="drawer__close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label={t('drawer.close')}
          >
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <h3 className="drawer__section" data-testid="section-appearance">
            {t('drawer.sectionAppearance')}
          </h3>

          {/* theme picker (T cycles, this pins a choice) */}
          <div className="setting">
            <span className="setting__label">{t('settings.theme')}</span>
            <div className="appearance-grid" role="group" aria-label={t('settings.theme')} data-testid="setting-theme">
              {THEME_IDS.map((id) => {
                const chart = THEMES[id].chart;
                const preview = resolveAppearance(id, settings.colormap);
                return (
                  <button
                    type="button"
                    key={id}
                    className={`appearance-choice${theme === id ? ' is-on' : ''}`}
                    aria-pressed={theme === id}
                    data-testid={`theme-${id}`}
                    onClick={() => setTheme(id)}
                  >
                    <svg className="theme-preview" viewBox="0 0 144 64" aria-hidden="true">
                      <rect width="144" height="64" fill={THEMES[id].canvas.bg} />
                      <rect width="144" height="10" fill={chart.chipBg} />
                      <path d="M5 5H21M28 5H46" stroke={chart.ink} strokeWidth="2" />
                      <path d="M118 5H139" stroke={chart.accent} strokeWidth="3" />
                      <rect y="11" width="105" height="46" fill={chart.bg} />
                      <path d="M0 25H105M0 41H105M32 11V57M67 11V57" stroke={chart.grid} strokeOpacity=".25" />
                      {[.2,.4,.6,.8].map((n,i) => <rect key={n} x={5+i*8} y={18+i*9} width={90-i*14} height="3" fill={`rgb(${preview.density[i+1].rgb.join(',')})`} />)}
                      <path d="M0 46L14 40L25 44L42 29L57 34L69 23L85 27L104 17" fill="none" stroke={THEMES[id].canvas.bg} strokeWidth="3" />
                      <path d="M0 46L14 40L25 44L42 29L57 34L69 23L85 27L104 17" fill="none" stroke={chart.price} strokeWidth="1.3" />
                      <rect x="106" y="11" width="38" height="46" fill={chart.gutterBg} />
                      <path d="M111 17H137M111 25H137M111 33H137M111 41H137M111 49H137" stroke={chart.chipBorder} />
                      <path d="M127 21H138M127 29H134" stroke={THEMES[id].canvas.ask} strokeWidth="3" />
                      <path d="M111 37H122M115 45H122" stroke={THEMES[id].canvas.bid} strokeWidth="3" />
                      <rect y="58" width="144" height="6" fill={chart.chipBg} />
                      <path d="M5 61H138" stroke={chart.accent} strokeOpacity=".65" />
                    </svg>
                    <span className="appearance-choice__name">{t(`theme.${id}.name`)}<span aria-hidden="true">{theme === id ? '✓' : ''}</span></span>
                    <span className="appearance-choice__hint">{t(`theme.${id}.hint`)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <SettingsAppearanceSection settings={settings} onChange={onChange} onOpenAbout={onOpenAbout} onCloseDrawer={onClose} />

          <SettingsDisplaySection
            settings={settings}
            onChange={onChange}
            synthetic={synthetic}
            densityControlsDisabled={densityControlsDisabled}
          />

          <SettingsTradesSection settings={settings} onChange={onChange} />

          <SettingsViewSection settings={settings} onChange={onChange} />

          <SettingsOverlaysSection settings={settings} onChange={onChange} />

          {/* data (desktop shell only): the recorder's switch and where it writes */}
          <h3 className="drawer__section" data-testid="section-data">
            {t('drawer.sectionData')}
          </h3>
          <RecordingSection />

          <SettingsKeysSection />

          {/* restore defaults */}
          <div className="drawer__restore-row">
            <button
              type="button"
              className={`drawer__restore${restoreArmed ? ' is-armed' : ''}`}
              data-testid="settings-restore"
              onClick={restoreDefaults}
            >
              {restoreArmed ? t('settings.restoreConfirm') : t('settings.restoreDefaults')}
            </button>
            {undoSnapshot && (
              <button
                type="button"
                className="drawer__restore"
                data-testid="settings-restore-undo"
                onClick={undoRestore}
              >
                {t('settings.restoreUndo')}
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
