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

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

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

/**
 * Tab and Shift+Tab stay inside the dialog. The disabled "add" button is skipped, so
 * the cycle never dead-ends on an unfocusable stop: the browser's own tab order skips
 * disabled controls, and the trap must too, or a disabled last stop strands focus.
 */
function trapTabKey(root: HTMLElement | null, e: ReactKeyboardEvent): void {
  if (e.key !== 'Tab') return;
  if (!root) return;
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
}

/**
 * The dialog's focus lifecycle: the close button takes focus on open, Escape closes
 * only the TOP overlay, and focus returns to the opener on close (WCAG 2.4.3, the bell
 * chip). Returns the ref the close button mounts on.
 */
function useDialogFocus(onClose: () => void): RefObject<HTMLButtonElement> {
  const closeRef = useRef<HTMLButtonElement | null>(null);
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
  return closeRef;
}

interface AlertRowProps {
  alert: PriceAlert;
  now: number;
  clockText: (ms: number) => string;
  onRearm: (id: string) => void;
  onSnooze: (id: string) => void;
  onDelete: (id: string) => void;
}

/** One alert: its level, its state, and the re-arm or snooze and delete controls. */
function AlertRow({ alert: a, now, clockText, onRearm, onSnooze, onDelete }: AlertRowProps): JSX.Element {
  const t = useT();
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
    <div className="alert-row" data-testid="alert-row">
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
}

interface AlertAddRowProps {
  draft: string;
  /** The typed level, or null while the draft is not a usable price. */
  price: number | null;
  /** The live price the placeholder names, or null. */
  refPx: number | null;
  addBlocked: boolean;
  /** The reason the add row is blocked, or the last refused add; null when neither applies. */
  status: string | null;
  inputRef: RefObject<HTMLInputElement>;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}

/** The create form: a level input, its add button, and the status line beneath. */
function AlertAddRow({
  draft,
  price,
  refPx,
  addBlocked,
  status,
  inputRef,
  onDraftChange,
  onSubmit,
}: AlertAddRowProps): JSX.Element {
  const t = useT();
  return (
    <>
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
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <button
          type="button"
          className="alerts-add__go"
          data-testid="alerts-add-go"
          disabled={price === null || addBlocked}
          onClick={onSubmit}
        >
          {t('alerts.add')}
        </button>
      </div>
      {status !== null && (
        <div className="alerts-pop__empty" role="status" data-testid="alerts-add-hint">
          {status}
        </div>
      )}
    </>
  );
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
  const sectionRef = useRef<HTMLElement | null>(null);
  const closeRef = useDialogFocus(onClose);

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
      onKeyDown={(e) => trapTabKey(sectionRef.current, e)}
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
          alerts.map((a) => (
            <AlertRow
              key={a.id}
              alert={a}
              now={now}
              clockText={clockText}
              onRearm={onRearm}
              onSnooze={onSnooze}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      <AlertAddRow
        draft={draft}
        price={price}
        refPx={refPx}
        addBlocked={addBlocked}
        status={addBlockedReason ?? hint}
        inputRef={inputRef}
        onDraftChange={(value) => {
          setDraft(value);
          setHint(null);
        }}
        onSubmit={submit}
      />
    </section>
  );
}
