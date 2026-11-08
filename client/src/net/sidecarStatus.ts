/**
 * Desktop-shell sidecar status.
 *
 * The Tauri shell supervises the Python engine and publishes every phase change
 * as the `sidecar-status` event; `sidecar_status` returns the latest value for a
 * window that opened late, and `retry_sidecar` asks the supervisor to restart the
 * engine (the failed-state Retry button). The client reaches both through the
 * webview's own IPC bridge (`window.__TAURI_INTERNALS__`, present in every Tauri 2
 * webview whether or not `withGlobalTauri` is enabled). In a plain browser
 * (vite dev, tests) the bridge is absent and every helper degrades to a no-op.
 *
 * Only plain IPC is used: no Tauri plugin API is granted beyond `core:default`.
 */

export type SidecarState = 'starting' | 'live' | 'restarting' | 'failed' | 'external';

export interface SidecarStatus {
  state: SidecarState;
  port: number | null;
  /** Engine log file the shell writes; shown in the failed state. */
  logPath: string | null;
  detail: string;
}

/** Event name the shell emits on every phase change (app/src-tauri STATUS_EVENT). */
export const SIDECAR_STATUS_EVENT = 'sidecar-status';

const STATES: ReadonlySet<string> = new Set<SidecarState>(['starting', 'live', 'restarting', 'failed', 'external']);

/** Validate a payload from the shell; anything malformed is ignored (null). */
export function parseSidecarStatus(value: unknown): SidecarStatus | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== 'string' || !STATES.has(v.state)) return null;
  return {
    state: v.state as SidecarState,
    port: typeof v.port === 'number' && Number.isFinite(v.port) ? v.port : null,
    logPath: typeof v.logPath === 'string' && v.logPath !== '' ? v.logPath : null,
    detail: typeof v.detail === 'string' ? v.detail : '',
  };
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
}

declare global {
  interface Window {
    /** The webview's Tauri IPC bridge; absent outside the desktop shell. */
    __TAURI_INTERNALS__?: Partial<TauriInternals>;
  }
}

function isBridge(i: Partial<TauriInternals> | null | undefined): i is TauriInternals {
  return !!i && typeof i.invoke === 'function' && typeof i.transformCallback === 'function';
}

function internals(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const i = window.__TAURI_INTERNALS__;
  return isBridge(i) ? i : null;
}

/** True when this webview runs inside the desktop shell. */
export function inDesktopShell(): boolean {
  return internals() !== null;
}

/** The shell's latest sidecar status, or null outside the shell / on any failure. */
export async function readSidecarStatus(): Promise<SidecarStatus | null> {
  const i = internals();
  if (i === null) return null;
  try {
    return parseSidecarStatus(await i.invoke('sidecar_status'));
  } catch {
    return null;
  }
}

/** Ask the shell to restart the engine now. False when it cannot (no shell, or refused). */
export async function retrySidecar(): Promise<boolean> {
  const i = internals();
  if (i === null) return false;
  try {
    await i.invoke('retry_sidecar');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the shell to open the app-data folder, which holds the engine log and the
 * recordings. True when the file manager was started; false when no
 * shell is present or the command was refused, so the caller can say so.
 */
export async function openLogFolder(): Promise<boolean> {
  const i = internals();
  if (i === null) return false;
  try {
    await i.invoke('open_log_folder');
    return true;
  } catch {
    return false;
  }
}

/**
 * How long the first WebSocket connect waits for the desktop engine before it
 * connects anyway and lets the reconnect ladder take over.
 */
export const SIDECAR_READY_WAIT_MS = 20_000;

/** True when the shell reports an engine that serves requests (`live`, or `external` in dev). */
function engineAnswering(status: SidecarStatus | null): boolean {
  return status !== null && (status.state === 'live' || status.state === 'external');
}

/**
 * Run `start` once the desktop engine answers, so the first connect does not race
 * a cold sidecar and climb the reconnect ladder. Outside the shell,
 * `start` runs at once. Inside it, `start` runs when the shell reports `live` (or
 * `external`), or after `timeoutMs` whichever comes first: a failed or silent
 * engine still gets its start. A failed engine's connect attempts are then parked
 * by the connection until it is live (see `sidecarHold`). Returns a cancel
 * function for effect cleanup; cancelling before `start` ran prevents it.
 */
export function whenSidecarReady(start: () => void, timeoutMs: number = SIDECAR_READY_WAIT_MS): () => void {
  if (!inDesktopShell()) {
    start();
    return () => {};
  }
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: () => void = () => {};
  const release = (): void => {
    settled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unlisten();
  };
  const finish = (): void => {
    if (settled) return;
    release();
    start();
  };
  unlisten = listenSidecarStatus((status) => {
    if (engineAnswering(status)) finish();
  });
  timer = setTimeout(finish, timeoutMs);
  void readSidecarStatus().then((status) => {
    if (engineAnswering(status)) finish();
  });
  return () => {
    if (!settled) release();
  };
}

/**
 * Subscribe to the shell's phase changes. Returns the unlisten function; a no-op
 * outside the shell. Malformed payloads never reach the callback.
 */
export function listenSidecarStatus(onStatus: (status: SidecarStatus) => void): () => void {
  const i = internals();
  if (i === null) return () => {};
  let eventId: number | null = null;
  let disposed = false;
  const handler = i.transformCallback((event: unknown) => {
    const status = parseSidecarStatus((event as { payload?: unknown } | null)?.payload);
    if (status !== null) onStatus(status);
  });
  i.invoke('plugin:event|listen', { event: SIDECAR_STATUS_EVENT, target: { kind: 'Any' }, handler })
    .then((id) => {
      if (typeof id !== 'number') return;
      if (disposed) void i.invoke('plugin:event|unlisten', { event: SIDECAR_STATUS_EVENT, eventId: id }).catch(() => {});
      else eventId = id;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    if (eventId !== null) {
      void i.invoke('plugin:event|unlisten', { event: SIDECAR_STATUS_EVENT, eventId }).catch(() => {});
      eventId = null;
    }
  };
}
