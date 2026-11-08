/**
 * Alerts popover — the list surface for the on-chart price alerts: every alert
 * for the CURRENT symbol with its state (armed / re-armed / re-arm pending /
 * fired at its clock time / muted), a re-arm button for fired or muted alerts, a
 * snooze button for armed ones, a delete button, and a create form for typing an
 * exact level. Presentational on purpose: state lives in state/alertsStore.ts,
 * mounting + data wiring in ui/PriceAlerts.tsx (the only component that mounts it).
 *
 * Accessibility: the surface is a `role="dialog"` (so input/keys.ts classifies
 * its children as inside a dialog and background shortcuts yield) with a Tab
 * trap and Escape-to-close through the open-overlay registry.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { PriceAlert } from '../state/alertsStore';
import { exchangeZoneFor, formatClock, useTimeZone, zoneLabel } from '../i18n/format';
import { useT } from '../i18n/useT';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';
import { alertPriceText } from './alertPrice';
import { draftPrice } from './alertDraft';
import { isTopOverlay, pushOverlay } from './overlayStack';

/** Seconds left in a snooze, for the muted badge. */
function mutedFor(snoozedUntil: number | null, now: number): number | null {
  if (snoozedUntil === null || snoozedUntil <= now) return null;
  return Math.ceil((snoozedUntil - now) / 1000);
}

export interface AlertsPopoverProps {
  alerts: readonly PriceAlert[];
  /** Live market price — the reference the add-row hint compares against. */
  refPx: number | null;
  /**
   * Instrument group of the current symbol (`marketGroup` in ui/symbols): the
   * exchange zone the fired-at clock reads in under the `exchange` preference.
   */
  group?: string;
  /**
   * Why a new alert cannot be added right now (for example replay mode), or null.
   * While set, the add row is disabled and the reason is shown in its place.
   */
  addBlockedReason?: string | null;
  onClose: () => void;
  onCreate: (price: number) => void;
  onDelete: (id: string) => void;
  /** Mute an armed alert for the snooze window. */
  onSnooze: (id: string) => void;
  /** Clear the mute / fired latch (hysteresis band preserved). */
  onRearm: (id: string) => void;
  /** Delete every FIRED alert (they have already done their job). */
  onClearFired: () => void;
  /** Now, ms epoch — re-rendered by the parent at its poll cadence. */
  now: number;
}

export function AlertsPopover({
  alerts,
  refPx,
  group = '',
  addBlockedReason = null,
  onClose,
  onCreate,
  onDelete,
  onSnooze,
  onRearm,
  onClearFired,
  now,
}: AlertsPopoverProps): JSX.Element {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  // Clock times follow the Settings zone like every other clock on screen (the
  // top bar, tape and crosshair); the zone hook re-renders this popover on change.
  const zonePref = useTimeZone();
  const exchangeZone = exchangeZoneFor(group);
  const clockText = (ms: number): string =>
    `${formatClock(ms, zonePref, exchangeZone)} ${zoneLabel(zonePref, exchangeZone, ms)}`;
  const [draft, setDraft] = useState('');
  /** Why the last add was refused (the level sits on the market), or null. */
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  // The parent re-creates `onClose` every poll tick (~10 Hz), so the overlay
  // effect below must NOT depend on it — otherwise its cleanup refocuses the
  // opener and its body refocuses the close button 10×/s, stealing focus from
  // the add-alert input while the user types. Route the latest callback through
  // a ref and mount the effect once.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Join the open-overlay registry so a single Escape closes only the TOP
    // surface (the settings drawer defers to whoever pushed later).
    const off = pushOverlay('alerts');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTopOverlay('alerts')) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
      opener?.focus?.(); // WCAG 2.4.3: focus returns to the bell chip
    };
    // Mount-only by design (see the ref comment above).
  }, []);

  // Trap Tab / Shift+Tab inside the dialog while it is open (the disabled "add"
  // button is skipped so the cycle never dead-ends on an unfocusable stop).
  const onTrapKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const root = sectionRef.current;
    if (!root) return;
    // Disabled controls are skipped by the browser's own tab order, so the trap
    // must skip them too: a disabled last stop would strand focus outside.
    const focusable = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const firedCount = alerts.filter((a) => a.triggered).length;

  const price = draftPrice(draft);
  const addBlocked = addBlockedReason !== null;
  const submit = (): void => {
    if (price === null || addBlocked) return;
    // A level exactly on the market is already crossed: it would fire at once.
    // Say so instead of creating an alert that fires on the next tick.
    if (refPx !== null && price === refPx) {
      setHint(t('alerts.atMarketHint'));
      return;
    }
    setHint(null);
    onCreate(price);
    setDraft('');
    inputRef.current?.focus();
  };

  return (
    <section
      ref={sectionRef}
      className="alerts-pop"
      data-testid="alerts-popover"
      role="dialog"
      aria-modal="true"
      aria-label={t('alerts.dialogLabel')}
      onKeyDown={onTrapKeyDown}
    >
      <header className="alerts-pop__head">
        <span className="alerts-pop__title">
          {t('alerts.title')}
          <span className="alerts-chip__count"> · {alerts.length}</span>
        </span>
        {firedCount > 0 && (
          <button
            type="button"
            className="alert-row__btn"
            data-testid="alerts-clear-fired"
            onClick={onClearFired}
          >
            {t('alerts.clearFired')}
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          className="alert-row__btn"
          data-testid="alerts-close"
          aria-label={t('alerts.closeLabel')}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="alerts-pop__body">
        {alerts.length === 0 ? (
          <div className="alerts-pop__empty" data-testid="alerts-empty">
            {singleKeys ? t('alerts.emptyHint', { key: 'A' }) : t('alerts.emptyHintNoKey')}
          </div>
        ) : (
          alerts.map((a) => {
            const muted = mutedFor(a.snoozedUntil, now);
            // Five honest states: a fired alert now waits for the
            // hysteresis band; once price returns inside it the alert is
            // RE-ARMED (has fired before, currently armed); a manual re-arm
            // while price is still beyond shows the band it is waiting for.
            const dir = a.above ? '↑' : '↓';
            const state = a.triggered
              ? t('alerts.state.fired', { time: a.triggeredAt !== null ? clockText(a.triggeredAt) : '—' })
              : muted !== null
                ? t('alerts.state.muted', { seconds: muted })
                : a.rearmPx !== null
                  ? t('alerts.state.rearming', { price: alertPriceText(a.rearmPx) })
                  : a.triggeredAt !== null
                    ? t('alerts.state.rearmed', { dir })
                    : t('alerts.state.armed', { dir });
            const stateCls = a.triggered
              ? ' alert-row__state--fired'
              : muted !== null
                ? ' alert-row__state--muted'
                : '';
            const needsRearm = a.triggered || muted !== null;
            return (
              <div className="alert-row" key={a.id} data-testid="alert-row">
                <span className="alert-row__px">
                  {a.above ? '↑' : '↓'} {alertPriceText(a.price)}
                </span>
                <span className={`alert-row__state${stateCls}`} data-testid="alert-state">
                  {state}
                </span>
                {needsRearm ? (
                  <button
                    type="button"
                    className="alert-row__btn"
                    data-testid={`alert-rearm-${a.id}`}
                    onClick={() => onRearm(a.id)}
                  >
                    {t('alerts.rearm')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="alert-row__btn"
                    data-testid={`alert-snooze-${a.id}`}
                    onClick={() => onSnooze(a.id)}
                  >
                    {t('alerts.snooze')}
                  </button>
                )}
                <button
                  type="button"
                  className="alert-row__btn"
                  data-testid={`alert-delete-${a.id}`}
                  aria-label={t('alerts.deleteAria', { price: alertPriceText(a.price) })}
                  onClick={() => onDelete(a.id)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="alerts-add">
        <input
          ref={inputRef}
          className="alerts-add__input"
          data-testid="alerts-add-input"
          type="number"
          step="any"
          min="0"
          disabled={addBlocked}
          placeholder={`${t('alerts.levelPlaceholder')}${
            refPx !== null ? ` ${t('alerts.midPlaceholder', { price: alertPriceText(refPx) })}` : ''
          }`}
          aria-label={t('alerts.newPriceLabel')}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className="alerts-add__go"
          data-testid="alerts-add-go"
          disabled={price === null || addBlocked}
          onClick={submit}
        >
          {t('alerts.add')}
        </button>
      </div>
      {(addBlockedReason ?? hint) !== null && (
        <div className="alerts-pop__empty" role="status" data-testid="alerts-add-hint">
          {addBlockedReason ?? hint}
        </div>
      )}
    </section>
  );
}
