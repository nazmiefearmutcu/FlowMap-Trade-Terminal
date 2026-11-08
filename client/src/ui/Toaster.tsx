/**
 * Toast stack: dependency-free global notifications, pinned bottom-right above
 * the timeline rail. The store is module-level, so any code can push a toast
 * through the exported {@link toast}.
 *
 * - kinds: info (default) / success / warn / error, severity on the left
 *   accent border (teal/teal/amber/red — the shell's own channels).
 * - auto-dismiss after `ttlMs` (default 5s; errors 10s); hovering or focusing a
 *   toast PAUSES its timer and leaving resumes the remainder.
 * - max 5 visible; when a sixth arrives the oldest non-error toast drops first.
 * - two ANNOUNCER regions stay mounted while the stack is empty (a region
 *   inserted together with its first message is often not read out): a polite
 *   role="status" one for info/success/warn, and a role="alert" one for errors.
 *   Each announces the newest toast of its kind, once, when it is pushed. The
 *   visible stack mounts only while toasts exist.
 * - keyboard focus inside a toast pauses its timer, like the mouse does (WCAG
 *   2.2.1 Timing Adjustable). Pointer and focus holds are counted separately, so
 *   the timer restarts only when neither is still on the toast. Errors get a
 *   double ttl and are evicted only when no other kind is visible.
 * - on mount binds `window.__flowmapToast = (msg, kind?) => toast(...)`, the
 *   hook that alert delivery calls from outside React, and unbinds on unmount.
 * - renders an empty live region while the stack is empty (no visible cost).
 */

import { useEffect, useSyncExternalStore } from 'react';

import { useT } from '../i18n/useT';
import '../theme/shell.css';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** Auto-dismiss delay; non-positive / non-finite falls back to the default. */
  ttlMs?: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  ttlMs: number;
}

export const MAX_TOASTS = 5;
export const DEFAULT_TTL_MS = 5000;
/** Errors stay on screen twice as long unless a caller states a ttl. */
export const ERROR_TTL_MS = DEFAULT_TTL_MS * 2;

declare global {
  interface Window {
    /** Toast hook for code outside React, assigned by <Toaster/> on mount. */
    __flowmapToast?: (message: string, kind?: ToastKind) => void;
  }
}

/* ---------------------------------------------------------------- store */

let seq = 0;
let entries: Toast[] = [];
const listeners = new Set<() => void>();
/** Newest pushed toast per announcer; changed only by {@link toast}, never by dismissal. */
let announced: { polite: Toast | null; error: Toast | null } = { polite: null, error: null };
/** id → live timer bookkeeping (handle 0 = paused). */
const timers = new Map<number, { handle: number; remainingMs: number; startedAt: number }>();
/**
 * Why each toast's timer is held. The pointer and keyboard focus are independent
 * reasons: leaving the toast with the mouse must not restart the timer while the
 * keyboard focus is still inside it, and vice versa (WCAG 2.2.1).
 */
const holds = new Map<number, Set<'hover' | 'focus'>>();

function notify(): void {
  listeners.forEach((l) => l());
}

function expire(id: number): void {
  timers.delete(id);
  dismissToast(id);
}

function schedule(id: number, delayMs: number): void {
  timers.set(id, {
    handle: window.setTimeout(() => expire(id), delayMs),
    remainingMs: delayMs,
    startedAt: Date.now(),
  });
}

/**
 * Push a toast (caps the stack at {@link MAX_TOASTS}). When full, the oldest
 * non-error toast is evicted first, so a burst of info messages cannot push out
 * an error; an error is evicted only when every visible toast is an error.
 * Eviction goes through {@link dismissToast}, which also clears the evicted
 * toast's timer; the old splice left that timer running.
 */
export function toast(message: string, opts: ToastOptions = {}): Toast {
  const kind: ToastKind = opts.kind ?? 'info';
  const ttlMs =
    opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? opts.ttlMs
      : kind === 'error' ? ERROR_TTL_MS : DEFAULT_TTL_MS;
  const entry: Toast = { id: ++seq, message, kind, ttlMs };
  while (entries.length >= MAX_TOASTS) {
    const victim = entries.find((e) => e.kind !== 'error') ?? entries[0];
    dismissToast(victim.id);
  }
  entries = [...entries, entry];
  announced = kind === 'error' ? { ...announced, error: entry } : { ...announced, polite: entry };
  schedule(entry.id, ttlMs);
  notify();
  return entry;
}

/** Remove a toast now (close button, expiry). No-op for unknown ids. */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    window.clearTimeout(timer.handle);
    timers.delete(id);
  }
  holds.delete(id);
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) {
    entries = next;
    notify();
  }
}

/** Pause a toast's auto-dismiss timer (hover in). */
export function pauseToast(id: number): void {
  const timer = timers.get(id);
  if (!timer || timer.handle === 0) return;
  window.clearTimeout(timer.handle);
  timer.remainingMs -= Date.now() - timer.startedAt;
  timer.handle = 0;
}

/** Resume a paused toast's remaining ttl (hover out). */
export function resumeToast(id: number): void {
  const timer = timers.get(id);
  if (!timer || timer.handle !== 0) return;
  timer.startedAt = Date.now();
  timer.handle = window.setTimeout(() => expire(id), Math.max(timer.remainingMs, 0));
}

/** Hold a toast's timer for one reason (pointer over it, or keyboard focus inside it). */
function holdToast(id: number, reason: 'hover' | 'focus'): void {
  const set = holds.get(id) ?? new Set<'hover' | 'focus'>();
  set.add(reason);
  holds.set(id, set);
  pauseToast(id);
}

/** Drop one hold; the timer resumes only when no reason remains. */
function releaseToast(id: number, reason: 'hover' | 'focus'): void {
  const set = holds.get(id);
  if (!set) return;
  set.delete(reason);
  if (set.size > 0) return;
  holds.delete(id);
  resumeToast(id);
}

export function getToasts(): Toast[] {
  return entries;
}

/** The newest toast each announcer reads out (stable reference between pushes). */
export function getAnnouncements(): { polite: Toast | null; error: Toast | null } {
  return announced;
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: clear the stack and every pending timer. */
export function resetToasts(): void {
  for (const timer of timers.values()) window.clearTimeout(timer.handle);
  timers.clear();
  holds.clear();
  entries = [];
  announced = { polite: null, error: null };
  notify();
}

/* ----------------------------------------------------------- component */

export function Toaster(): JSX.Element {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const announcements = useSyncExternalStore(subscribeToasts, getAnnouncements);
  const t = useT();

  // Window hook for code outside React (alert delivery) that pushes toasts.
  useEffect(() => {
    window.__flowmapToast = (message: string, kind?: ToastKind) => toast(message, { kind });
    return () => {
      delete window.__flowmapToast;
    };
  }, []);

  // Announcers are always mounted; the visible stack exists only while toasts do.
  return (
    <>
      <div className="toast-announcer" role="status" aria-live="polite" data-testid="toast-announcer">
        {announcements.polite && <span key={announcements.polite.id}>{announcements.polite.message}</span>}
      </div>
      <div className="toast-announcer" role="alert" data-testid="toast-alert-announcer">
        {announcements.error && <span key={announcements.error.id}>{announcements.error.message}</span>}
      </div>
      {toasts.length > 0 && (
        <div className="toasts" data-testid="toasts">
          {toasts.map((toast_) => (
            <div
              key={toast_.id}
              className={`toast toast--${toast_.kind}`}
              data-testid={`toast-${toast_.id}`}
              onMouseEnter={() => holdToast(toast_.id, 'hover')}
              onMouseLeave={() => releaseToast(toast_.id, 'hover')}
              onFocus={() => holdToast(toast_.id, 'focus')}
              onBlur={(e) => {
                // Focus moving between the message and the close button stays held.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseToast(toast_.id, 'focus');
              }}
            >
              <span className="toast__message">{toast_.message}</span>
              <button
                type="button"
                className="toast__close"
                aria-label={t('toast.dismiss')}
                data-testid={`toast-close-${toast_.id}`}
                onClick={() => dismissToast(toast_.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
