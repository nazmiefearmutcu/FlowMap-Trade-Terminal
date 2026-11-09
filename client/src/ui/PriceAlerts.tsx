/**
 * On-chart price alerts — the container over the chart.
 *
 * Renders, inside the chart viewport: one dashed horizontal marker line per
 * alert of the CURRENT symbol (labelled with its level, solid red + a pulse
 * once fired), a bell chip (bottom-right) that opens the AlertsPopover, and
 * the keyboard surface: `A` creates an alert at the crosshair price.
 *
 * Data flow stays off the React render path: an interval at the bookStore
 * flush cadence (~10 Hz) reads the latest live price (BBO mid, else the last
 * trade, refused once older than {@link LIVE_PRICE_MAX_AGE_MS}) and hands it to
 * {@link evaluateAlerts}; alert list changes arrive through
 * `useSyncExternalStore` on the alerts store. Marker lines are
 * positioned through the renderer's `overlayRowCss` (price → row → canvas
 * CSS px), polled at the same cadence so they stay glued under pan/zoom.
 * Everything is client-local + localStorage-persisted per symbol; fires are
 * announced via the `window.__flowmapToast?.(msg)` hook when the shell
 * provides one (never imported: the hook is the only interface).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type RefObject,
} from 'react';

import type { Renderer } from '../gl/renderer';
import { priceToRow as scalePriceToRow, scaleFromEpoch } from '../gl/priceScale';
import {
  addAlert,
  alertsFor,
  evaluateAlerts,
  getAlertsSnapshot,
  rearmAlert,
  removeAlert,
  snoozeAlert,
  subscribeAlerts,
  type PriceAlert,
} from '../state/alertsStore';
import { getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { classifyTarget, routeGlobalKey } from '../input/keys';
import { clearProbeSpot, lastProbeSpot } from './lastProbe';
import { AlertsPopover } from './AlertsPopover';
import { alertPriceText } from './alertPrice';
import { alertSoundEnabled, playAlertSound } from './alertSound';
import { marketGroup } from './symbols';
import { useT, type TFn } from '../i18n/useT';
import './features.css';

/** Marker-line / evaluation poll cadence (a 100 ms poll, slower than the bookStore flush). */
const POLL_MS = 100;
/** How long a fired marker keeps pulsing. */
const PULSE_MS = 2000;
/**
 * The oldest book quote that still counts as the live market. The same bar the
 * watchlist uses for a live quote: a silent feed must not fire an alert on its
 * last print. Evaluation resumes on the next fresh tick, so a late fire is
 * recoverable and a stale one is not.
 */
const LIVE_PRICE_MAX_AGE_MS = 5_000;

/**
 * Latest usable price off the shared book buffer: BBO mid, else last trade. With
 * `nowMs`, a quote older than {@link LIVE_PRICE_MAX_AGE_MS} is refused. A quote
 * with no arrival clock (recordings, fixtures) is taken as it is.
 */
function bookPrice(nowMs: number | null): number | null {
  const { bbo, trades } = getSnapshot();
  const usable = (receivedAtMs: number | undefined): boolean =>
    nowMs === null || receivedAtMs === undefined || nowMs - receivedAtMs <= LIVE_PRICE_MAX_AGE_MS;
  if (bbo !== null && bbo.bidPx > 0 && bbo.askPx > 0 && usable(bbo.receivedAtMs)) {
    const mid = (bbo.bidPx + bbo.askPx) / 2;
    if (Number.isFinite(mid)) return mid;
  }
  if (trades.length > 0) {
    const newest = trades[0]; // newest-first
    if (Number.isFinite(newest.price) && usable(newest.receivedAtMs)) return newest.price;
  }
  return null;
}

/**
 * The live price an alert may FIRE on: the book price, refused once it is older
 * than {@link LIVE_PRICE_MAX_AGE_MS} at `nowMs`.
 */
export function marketPriceNow(nowMs: number = performance.now()): number | null {
  return bookPrice(nowMs);
}

/**
 * The last known price, however old. It only sets an alert's direction and the
 * add-row hint: a new alert below a quiet market must still read as "below", so a
 * stale mark is still the right reference (it is never used to fire).
 */
export function referencePriceNow(): number | null {
  return bookPrice(null);
}

/**
 * True while the chart shows a recording. The book then carries HISTORICAL
 * prices, so neither a crossing nor the level an alert is anchored on (the
 * crosshair probe, the mid) may be taken from it. Read live at each call: a
 * mode switch must take effect without re-creating any handler.
 */
function inReplay(): boolean {
  return useFlowMapStore.getState().subscription?.mode === 'replay';
}

/** Toast through the shell hook (`window.__flowmapToast`); silent when none is bound. */
function notify(msg: string): void {
  window.__flowmapToast?.(msg);
}

/**
 * Adds an alert at a level the user chose (typed, or the crosshair probe). The live
 * reference sets the direction, so without one the add is refused; a level exactly on
 * the market would fire at once, so it is refused too, and the reason is said.
 */
function addAlertAtLevel(key: string, price: number, t: TFn): void {
  // The reference sets the direction. Without a live price there is none, so refuse.
  const ref = referencePriceNow();
  if (ref === null) {
    notify(t('alerts.noReferenceToast'));
    return;
  }
  // The price may have reached the market since the popover drew its hint.
  // addAlert would refuse it silently, so say why here instead.
  if (price === ref) {
    notify(t('alerts.atMarketToast'));
    return;
  }
  addAlert(key, price, ref);
}

type EpochScale = ReturnType<typeof scaleFromEpoch>;

/**
 * Pixel placement of each alert's marker line (price → row → canvas CSS px).
 * Empty until both the grid scale and the renderer exist. Shared by the render
 * path and the poll, so the poll can tell whether anything on screen moved.
 */
function markerLines(
  alerts: readonly PriceAlert[],
  scale: EpochScale | null,
  renderer: Renderer | null,
): { alert: PriceAlert; y: number }[] {
  if (scale === null || renderer === null) return [];
  return alerts.flatMap((a) => {
    const row = scalePriceToRow(scale, a.price);
    if (!Number.isFinite(row)) return [];
    const y = renderer.overlayRowCss(row);
    if (!Number.isFinite(y)) return [];
    return [{ alert: a, y }];
  });
}

interface AlertPollOptions {
  key: string | null;
  soundEnabled: boolean | undefined;
  rendererRef: MutableRefObject<Renderer | null>;
  open: boolean;
}

/**
 * The ~10 Hz poll for one market:symbol. It evaluates the alerts against the live
 * price, pulses and chimes on a fire, and re-renders only when something on screen
 * can change. Returns the `now` clock the popover's countdowns read, and the ids of
 * the alerts that fired within the pulse window.
 */
function usePriceAlertPoll({ key, soundEnabled, rendererRef, open }: AlertPollOptions): {
  now: number;
  pulsing: ReadonlySet<string>;
} {
  const [now, setNow] = useState(() => Date.now());
  const [pulsing, setPulsing] = useState<ReadonlySet<string>>(new Set());
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The poll reads these without re-subscribing its interval: whether the
  // popover (which shows the `now` countdowns) is open, and the marker placement
  // last committed to the screen.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const markerSigRef = useRef('');

  useEffect(() => {
    if (key === null) return;
    const alertKey = key;
    const id = window.setInterval(() => {
      // Replay honesty: in replay the book carries HISTORICAL prices. Evaluating
      // alerts against them would fire a "live" alert on replayed data and
      // latch it against the real crossing later (docs/user-guide.md documents
      // live-price semantics only). Read the mode live so a replay toggle
      // takes effect without re-creating the interval.
      const live = !inReplay();
      const px = marketPriceNow();
      if (live && px !== null) {
        const fired = evaluateAlerts(alertKey, px);
        if (fired.length > 0) {
          const ids = new Set(fired.map((e) => e.alertId));
          setPulsing(ids);
          if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
          pulseTimer.current = setTimeout(() => setPulsing(new Set()), PULSE_MS);
          // One chime per fired BATCH (alertSound.ts rate-limits bursts besides).
          if (soundEnabled ?? alertSoundEnabled()) playAlertSound();
        }
      }
      // Re-render only when something on screen can change: the popover (its
      // countdown badges read `now`), or a marker whose pixel row moved. An idle
      // chart with the popover closed costs no React work at this cadence.
      const st = useFlowMapStore.getState();
      const params = st.gridEpoch === null ? null : (st.epochs.get(st.gridEpoch) ?? null);
      const lines = markerLines(alertsFor(alertKey), params ? scaleFromEpoch(params) : null, rendererRef.current);
      const sig = lines.map((l) => `${l.alert.id}@${l.y}`).join('|');
      if (openRef.current || sig !== markerSigRef.current) {
        markerSigRef.current = sig;
        setNow(Date.now());
      }
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    };
  }, [key, soundEnabled, rendererRef]);

  return { now, pulsing };
}

/**
 * `A` creates an alert at the crosshair price, the price the user is pointing at.
 * Only a probe from the live pointer position counts (see lastProbe.ts), and only on
 * the current market:symbol. Replay is refused, since its crosshair reads a recording.
 */
function usePriceAKey(key: string | null, t: TFn): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A held key auto-repeats: one press is one alert, never a burst of them.
      if (e.repeat) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'create-alert') return;
      if (key === null) return;
      const alertKey = key;
      e.preventDefault();
      // The crosshair in replay reads a recorded book: refuse rather than latch
      // an alert whose level and direction came from history.
      if (inReplay()) {
        notify(t('alerts.replayBlocked'));
        return;
      }
      // Only a probe from the live pointer position counts (see lastProbe.ts).
      // A probe read on another market:symbol is no price for this chart.
      const spot = lastProbeSpot();
      if (spot === null || spot.price === null || spot.key !== alertKey) {
        notify(t('alerts.pressAHint'));
        return;
      }
      addAlertAtLevel(alertKey, spot.price, t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, t]);
}

/**
 * The crosshair probe belongs to one market:symbol. A probe recorded on the previous
 * symbol must never anchor an alert on this one, and the pointer leaving the chart
 * stage ends the probe (see `containerRef` on PriceAlerts).
 */
function useProbeLifetime(key: string | null, containerRef: RefObject<HTMLElement | null> | undefined): void {
  // Only a real symbol change clears it (not the mount): the probe loop keeps the
  // probe fresh while the pointer is over the chart.
  const prevKeyRef = useRef(key);
  useEffect(() => {
    if (prevKeyRef.current !== key) clearProbeSpot();
    prevKeyRef.current = key;
  }, [key]);

  useEffect(() => {
    const stage = containerRef?.current;
    if (!stage) return;
    stage.addEventListener('pointerleave', clearProbeSpot);
    return () => stage.removeEventListener('pointerleave', clearProbeSpot);
  }, [containerRef]);
}

interface PriceAlertsProps {
  /** Renderer ref — marker lines position through `overlayRowCss`. */
  rendererRef: MutableRefObject<Renderer | null>;
  /**
   * Override the persisted `alertSound` setting (tests / host wiring). When
   * omitted, the flag is read from settings at each fired batch.
   */
  soundEnabled?: boolean;
  /**
   * The chart stage. Leaving it forgets the crosshair probe at once, so `A` cannot
   * anchor an alert on a price the pointer left behind. The probe's freshness
   * window alone would still allow a 2 s old price.
   */
  containerRef?: RefObject<HTMLElement | null>;
}

export function PriceAlerts({ rendererRef, soundEnabled, containerRef }: PriceAlertsProps): JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState(false);

  const sub = useFlowMapStore((s) => s.subscription);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const epochs = useFlowMapStore((s) => s.epochs);
  const key = sub === null ? null : `${sub.market}:${sub.symbol}`;

  // Re-render on every store bump; alertsFor lazily loads the persisted list for
  // `key` on first touch, so the list is read fresh after each one.
  useSyncExternalStore(subscribeAlerts, getAlertsSnapshot);
  const alerts = key === null ? [] : alertsFor(key);

  const params = gridEpoch === null ? null : (epochs.get(gridEpoch) ?? null);
  const { now, pulsing } = usePriceAlertPoll({ key, soundEnabled, rendererRef, open });
  usePriceAKey(key, t);
  useProbeLifetime(key, containerRef);

  // The popover reads this as its add-row reason, so the field stays disabled
  // with an explanation in replay instead of silently discarding a typed level.
  const addBlockedReason = sub !== null && sub.mode === 'replay' ? t('alerts.replayBlocked') : null;

  const createAt = useCallback(
    (price: number) => {
      if (key === null) return;
      // Defence in depth: the popover disables the add row in replay, but a
      // level anchored on the replayed book must never become a live alert.
      if (inReplay()) {
        notify(t('alerts.replayBlocked'));
        return;
      }
      addAlertAtLevel(key, price, t);
    },
    [key, t],
  );

  // Position each alert's line: price → row → canvas CSS px (view-transformed
  // fresh every poll, so pan/zoom/epoch re-anchor all stay glued).
  const scale = params ? scaleFromEpoch(params) : null;
  const renderer = rendererRef.current;
  const lines = markerLines(alerts, scale, renderer);

  if (key === null) return null;
  const refPx = referencePriceNow();

  return (
    <>
      <div className="alert-lines" data-testid="alert-lines" aria-hidden="true">
        {lines.map(({ alert, y }) => (
          <div
            key={alert.id}
            className={`alert-line${alert.triggered ? ' alert-line--triggered' : ''}${
              pulsing.has(alert.id) ? ' alert-line--pulse' : ''
            }`}
            data-testid={`alert-line-${alert.id}`}
            style={{ top: `${y}px` }}
          >
            <span className="alert-line__tag">
              {alert.above ? '↑' : '↓'} {alertPriceText(alert.price)}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={`alerts-chip${open ? ' is-open' : ''}`}
        data-testid="alerts-chip"
        aria-expanded={open}
        aria-label={t('alerts.listLabel', { n: alerts.length })}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M8 1.75a4 4 0 0 0-4 4v2.1L2.9 10.6h10.2L12 7.85v-2.1a4 4 0 0 0-4-4Zm-1.5 10.5a1.5 1.5 0 0 0 3 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className="alerts-chip__count">{alerts.length}</span>
      </button>

      {open && (
        <AlertsPopover
          alerts={alerts}
          refPx={refPx}
          group={sub === null ? '' : marketGroup(sub.market)}
          addBlockedReason={addBlockedReason}
          now={now}
          onClose={() => setOpen(false)}
          onCreate={createAt}
          onDelete={(id) => void removeAlert(id)}
          onSnooze={(id) => void snoozeAlert(id)}
          onRearm={(id) => void rearmAlert(id)}
          onClearFired={() => {
            for (const a of alerts) {
              if (a.triggered) removeAlert(a.id);
            }
          }}
        />
      )}
    </>
  );
}
