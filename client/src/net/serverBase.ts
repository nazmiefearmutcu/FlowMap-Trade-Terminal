/**
 * Resolve the FlowMap server's base URL.
 *
 * Two deployment shapes share one client build:
 *
 * - **Dev (vite dev server):** `vite.config.ts` injects the same global pointing
 *   straight at the server (`FLOWMAP_DEV_SERVER_PORT`, default 8720). The vite
 *   proxy stays only as a same-origin fallback, so dev runs the packaged app's
 *   path. With no global, REST calls would stay same-origin (`''`) and the WS
 *   URL would derive from `window.location`.
 *
 * - **Packaged desktop app (Tauri):** the webview loads the bundled static
 *   client from `tauri://localhost`, so there is no proxy and same-origin does
 *   not reach the server. The Tauri shell spawns the Python sidecar on a free
 *   loopback port and injects `window.__FLOWMAP_SERVER__ =
 *   "http://127.0.0.1:<port>"` before the page loads; the client reads that
 *   global as the absolute base for both REST and the WebSocket.
 *
 * - **Session token:** the packaged shell also injects a per-launch secret as
 *   `window.__FLOWMAP_SESSION_TOKEN__`. The sidecar refuses any request that does
 *   not carry it. REST calls send it in the {@link SESSION_TOKEN_HEADER} header
 *   ({@link sidecarFetch}). A browser WebSocket cannot set headers, so the token
 *   travels as a subprotocol ({@link wsProtocols}) and never in the URL, which
 *   access logs record. Absent in dev, where the server does not check.
 */

declare global {
  interface Window {
    /** Absolute server origin injected by the Tauri shell, e.g. `http://127.0.0.1:52791`. */
    __FLOWMAP_SERVER__?: string;
    /** Per-launch loopback session secret injected by the Tauri shell (64 lowercase hex). */
    __FLOWMAP_SESSION_TOKEN__?: string;
  }
}

/** REST header carrying the session token. */
export const SESSION_TOKEN_HEADER = 'X-FlowMap-Token';

/**
 * The injected session token, or `null` when none was injected (browser dev
 * mode, where the sidecar performs no token check).
 */
export function sessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = window.__FLOWMAP_SESSION_TOKEN__;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * `init` with the session header added when a token exists; otherwise `init`
 * unchanged. Every fetch to the sidecar goes through this (see {@link sidecarFetch}).
 */
export function withSessionHeader(init?: RequestInit): RequestInit | undefined {
  const token = sessionToken();
  if (token === null) return init;
  const headers = new Headers(init?.headers);
  headers.set(SESSION_TOKEN_HEADER, token);
  return { ...init, headers };
}

/**
 * The injected absolute server origin (no trailing slash), or `null` when
 * running same-origin in the browser dev server.
 */
export function serverOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const injected = window.__FLOWMAP_SERVER__;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected.replace(/\/+$/, ''); // tolerate a trailing slash in the injected value
  }
  return null;
}

/**
 * Base to prefix REST paths with, e.g. `` `${apiBase()}/api/symbols` ``. The
 * absolute injected origin in the packaged app; the empty string (same-origin)
 * in dev so the vite proxy handles it.
 */
export function apiBase(): string {
  return serverOrigin() ?? '';
}

/**
 * Longest a REST call waits for a restarting engine before it fails. The shell
 * reports `live` or `failed` well inside this bound; the bound only keeps a
 * silent shell from stalling every palette and replay request forever.
 */
export const SIDECAR_REST_HOLD_MS = 60_000;

/** Calls parked while the desktop engine restarts; `null` when nothing is held. */
let restHeld: Array<() => void> | null = null;

/**
 * Park or release REST calls while the desktop shell brings its engine back: the
 * same window in which the connection parks its socket opens. Held, a call waits
 * instead of sending the session token to whatever answers the port meanwhile.
 * Released, every parked call goes out at once. Driven by `holdWhileSidecarDown`.
 */
export function setSidecarRestHold(held: boolean): void {
  if (held) {
    restHeld ??= [];
    return;
  }
  const parked = restHeld;
  restHeld = null;
  if (parked === null) return;
  for (const release of parked.splice(0)) release();
}

/**
 * Resolves when a REST call may go out. Rejects when the hold outlasts
 * {@link SIDECAR_REST_HOLD_MS} or the call's signal aborts first.
 */
function whenSidecarAnswering(signal?: AbortSignal | null): Promise<void> {
  const parked = restHeld;
  if (parked === null) return Promise.resolve();
  const abortReason = (): unknown => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  if (signal?.aborted) return Promise.reject(abortReason());
  return new Promise<void>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const at = parked.indexOf(release);
      if (at >= 0) parked.splice(at, 1);
    };
    const release = (): void => {
      settle();
      resolve();
    };
    const onAbort = (): void => {
      settle();
      reject(abortReason());
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error('flowmap: sidecar did not come back'));
    }, SIDECAR_REST_HOLD_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    parked.push(release);
  });
}

/**
 * `fetch` against the sidecar REST surface, e.g. `sidecarFetch('/api/symbols')`.
 * Adds the session header when a token exists; otherwise a plain fetch. While
 * the desktop engine is restarting the call waits (see {@link setSidecarRestHold})
 * and only then sends the token.
 */
export async function sidecarFetch(path: string, init?: RequestInit): Promise<Response> {
  if (restHeld !== null) await whenSidecarAnswering(init?.signal);
  return fetch(`${apiBase()}${path}`, withSessionHeader(init));
}

/** The `/ws` URL without credentials (scheme + origin + path). */
function baseWsUrl(): string {
  const origin = serverOrigin();
  if (origin !== null) {
    const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:';
    const rest = origin.replace(/^https?:/, '');
    return `${scheme}${rest}/ws`;
  }
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, host } = window.location;
    const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${host}/ws`;
  }
  return 'ws://localhost/ws';
}

/**
 * Absolute URL for the `/ws` endpoint. Derived from the injected origin in the
 * packaged app (`http`→`ws`, `https`→`wss`); otherwise from `window.location`
 * (same-origin, proxied in dev). It never carries the session token: see
 * {@link wsProtocols}.
 */
export function wsUrl(): string {
  return baseWsUrl();
}

/** Subprotocol every client offers; the server echoes it on accept (browsers require an echo). */
export const WS_SUBPROTOCOL = 'flowmap.v1';
/** Prefix of the subprotocol that carries the session token: `flowmap.auth.<token>`. */
export const WS_AUTH_PROTOCOL_PREFIX = 'flowmap.auth.';

/**
 * Subprotocols to offer when opening `/ws`: the wire version, plus the session
 * token as `flowmap.auth.<token>` when one exists. The server accepts the token
 * from this entry and echoes only {@link WS_SUBPROTOCOL}, so the credential is
 * never reflected in a response header.
 */
export function wsProtocols(): string[] {
  const token = sessionToken();
  return token === null ? [WS_SUBPROTOCOL] : [WS_SUBPROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`];
}
