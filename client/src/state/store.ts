/**
 * FlowMap session store (zustand).
 *
 * Holds ONLY low-frequency connection/session metadata — connection status,
 * capability, session id, epoch geometry, the current subscription. This is the
 * state React components render off.
 *
 * The high-frequency stream (DepthColumn / BarColumn / Trade / BBO / Marker) is
 * deliberately kept OUT of React state: pushing every column through zustand
 * would fire a `set()` per frame and storm re-renders. Instead the store owns the
 * Connection and fans the stream to a plain listener Set; the renderer subscribes
 * via `onStream(handler)` and reads those messages directly (e.g. into a WebGL
 * buffer), never through React.
 *
 * The Connection instance and the listener Set live in module scope, not in the
 * store's state, so touching them never triggers a store update.
 */

import { create } from 'zustand';
import { useIntelligenceStore } from './intelligenceStore';
import { beginSubscription, forgetReplayEntry, transportHandlers } from './storeTransport';

import {
  Connection,
  type CloseInfo,
  type ConnStatus,
  type ConnectionOptions,
  type StreamMsg,
  type SubscribeWindow,
} from '../net/connection';
import { holdWhileSidecarDown } from '../net/sidecarHold';
import { type ReplayPlayback, type EpochParams, type FeedState, type HistoryResponse, type StreamMode } from '../proto/types';

export interface Subscription {
  market: string;
  symbol: string;
  mode: StreamMode;
  /** Server price-grid coverage preset ('native' | 'wide' | 'full' | 'deep'). */
  band: string;
  /**
   * OPTIONAL replay window: inclusive start / exclusive end in
   * wall-clock ns. Absent (the default, and every caller without a window) means the
   * unbounded recording; the fields are only materialized when a caller actually
   * supplies one, so the store's observable subscription shape is unchanged for
   * existing consumers and tests.
   */
  startNs?: bigint | null;
  endNs?: bigint | null;
}

/**
 * The identity of the GRID a subscription renders — the key App.tsx watches to
 * decide when the GL ring and the shared book buffer must be torn down.
 *
 * Deliberately NOT the whole subscription. `mode` is excluded: a live⇄replay
 * toggle re-subscribes the same instrument on the same grid, and resetting there
 * would throw away the user's scrolled-back history for nothing.
 *
 * `band` IS included, and that is the fix: it is part of the subscription
 * identity in `connectAndSubscribe` below and in net/connection.ts, so changing
 * it genuinely starts a new server session — one whose grid may be a different
 * HEIGHT (`deep` is 4096 rows against the default 2048). Keying only on
 * market:symbol left the renderer holding a ring sized for the old grid, which
 * is exactly the geometry mismatch gl/sessionGate.ts then has to survive.
 *
 * A replay WINDOW is included too: a different slice is a
 * different server session whose col_seq restarts at 0, so it needs the same
 * tear-down. An unbounded subscription (no window) keeps the exact pre-window key.
 */
export function sessionResetKey(sub: Subscription | null): string | null {
  if (sub === null) return null;
  const base = `${sub.market}:${sub.symbol}:${sub.band}:${sub.mode}`;
  if (sub.startNs == null && sub.endNs == null) return base;
  return `${base}:${sub.startNs ?? ''}-${sub.endNs ?? ''}`;
}

export interface FlowMapState {
  // --- low-frequency session/connection metadata (React-rendered) ---
  status: ConnStatus;
  feedState: FeedState | null;
  /** Next RTH open (UTC ns) from a `Status{feed_state='closed'}`; else null. Drives the closed banner countdown. */
  nextOpenTs: bigint | null;
  capability: Record<string, unknown> | null;
  /**
   * The server reports that this session's recording has stopped persisting
   * (its writer is wedged): a replay of it would have a gap. Set from every
   * Status; cleared with the rest of the session on a new subscription.
   */
  recordingDegraded: boolean;
  /**
   * The server reports that an overview step is overrunning (capability
   * overview_degraded): the chart keeps streaming while its overview lags. Set
   * from every Status; cleared with the rest of the session on a new subscription.
   */
  overviewDegraded: boolean;
  sessionId: string | null;
  /**
   * Bumped on every Hello, including a same-session reconnect. Each Hello is
   * followed by an attach snapshot that re-sends the session's recent tape, so
   * anything that accumulates from the stream (candles, indicator inputs) must
   * restart when this changes or the re-sent trades are counted twice.
   */
  attachEpoch: number;
  /**
   * Wire protocol version from Hello. Deliberately NOT cleared on a
   * re-subscribe, unlike the rest of the Hello-asserted fields: it describes the
   * SERVER (one build, one version, identical across every session on the same
   * socket), not the session, and nothing in the client reads it — no component,
   * no renderer path, only the store test. Clearing it would add a state
   * transition with no observer.
   */
  protocolVersion: number | null;
  gridEpoch: number | null;
  normSeed: number | null;
  latencyMs: number | null;
  clockSkewMs: number | null;
  epochs: Map<number, EpochParams>;
  subscription: Subscription | null;
  /**
   * The server refused a replay subscribe with the unsupported close (1003) —
   * there is NO recording for this symbol/session (the server refuses
   * honestly). The store already fell back to live mode when this is set; the
   * TopBar surfaces it as an explanatory badge until the next successful
   * handshake clears it.
   */
  replayUnavailable: boolean;
  /**
   * Bumped whenever the GRID identity changes (`sessionResetKey`: market, symbol,
   * band or replay window). A live⇄replay toggle does NOT bump it (same grid,
   * scroll-back kept), and neither does the refused-replay live fallback.
   */
  sessionRevision: number;
  /**
   * The server refused the LIVE subscription with a terminal 1003 (degraded) —
   * e.g. an invalid symbol. `reason` is the server's own text when it sent one.
   * Null while no refusal is outstanding; cleared by a different subscription.
   */
  refusal: { reason: string | null } | null;
  /**
   * The server speaks another wire protocol version: nothing can be decoded, so
   * the connection parks instead of retrying. Null when the versions agree.
   */
  protocolMismatch: { got: number; expected: number } | null;
  /**
   * TERMINAL: the server refused this subscription with a pre-close Status
   * naming feed_state='closed' + close 1003 — NO feed exists for this market at
   * all (server ws.py NotImplementedError path). Unlike `replayUnavailable`
   * there is no fallback (live would be refused just the same), so the client
   * does NOT re-subscribe and the ClosedBanner states the truth. Cleared when a
   * different stream is subscribed — a new stream is a new question.
   */
  noFeed: boolean;
  /** How the last unexpected socket close happened (reconnect banner reason). */
  lastClose: CloseInfo | null;
  /** 1-based reconnect attempts since the last completed handshake. */
  reconnectAttempts: number;
  /** Replay transport (low-frequency UI state; ignored in live mode). */
  speed: number;
  paused: boolean;
  replayPlayback: ReplayPlayback | null;

  // --- actions ---
  connectAndSubscribe: (
    market: string,
    symbol: string,
    mode?: StreamMode,
    band?: string,
    /** Optional replay window; omitted/null = unbounded (today's behavior). */
    window?: SubscribeWindow,
  ) => void;
  requestHistory: (
    before_t: bigint,
    n: number,
    overview?: import('../proto/types').HistoryOverviewRequest,
    /** Aborts the request when the caller no longer wants the page. */
    signal?: AbortSignal,
  ) => Promise<HistoryResponse>;
  /** Replay transport controls — send the matching control message + track UI state. */
  setSpeed: (x: number) => void;
  pause: () => void;
  resume: () => void;
  seek: (t: bigint) => void;
  /** Skip the reconnect backoff and open the replacement socket now (banner button). */
  retryNow: () => void;
  disconnect: () => void;
  /** Subscribe to the raw high-frequency stream; returns an unsubscribe fn. */
  onStream: (handler: (msg: StreamMsg) => void) => () => void;
}

// --- module-scoped transport (never in React state) ----------------------------

let conn: Connection | null = null;
/** Stops following the desktop shell's sidecar status for the live connection. */
let sidecarHoldStop: (() => void) | null = null;
const streamListeners = new Set<(msg: StreamMsg) => void>();

/**
 * Transport overrides (WebSocket factory / timers / url) merged into the
 * Connection when it is created. Production leaves these empty (real WebSocket +
 * real timers); tests inject a FakeWebSocket factory and a deterministic clock.
 * The store's own state-wiring callbacks always take precedence.
 */
let transportOverrides: Partial<ConnectionOptions> = {};

/** Configure the Connection transport before connecting (primarily for tests). */
export function setFlowMapTransport(overrides: Partial<ConnectionOptions>): void {
  transportOverrides = overrides;
}

function fanoutStream(msg: StreamMsg): void {
  try {
    useIntelligenceStore.getState().handleStreamMsg(msg);
  } catch (err) {
    console.error('intelligence store stream handler failed', err);
  }
  for (const listener of streamListeners) {
    try {
      listener(msg);
    } catch (err) {
      // One misbehaving listener must not break the WS dispatch loop for the
      // others (and must not kill the connection's message pump) — log and
      // continue with the remaining listeners.
      console.error('stream listener failed', err);
    }
  }
}

export const useFlowMapStore = create<FlowMapState>((set, get) => ({
  status: 'idle',
  feedState: null,
  nextOpenTs: null,
  capability: null,
  recordingDegraded: false,
  overviewDegraded: false,
  sessionId: null,
  attachEpoch: 0,
  protocolVersion: null,
  gridEpoch: null,
  normSeed: null,
  latencyMs: null,
  clockSkewMs: null,
  epochs: new Map(),
  subscription: null,
  replayUnavailable: false,
  sessionRevision: 0,
  refusal: null,
  protocolMismatch: null,
  noFeed: false,
  lastClose: null,
  reconnectAttempts: 0,
  speed: 1,
  paused: false,
  replayPlayback: null,

  connectAndSubscribe(market, symbol, mode = 'live', band = 'native', window) {
    const startNs = window?.startNs ?? null;
    const endNs = window?.endNs ?? null;
    if (conn === null) {
      conn = new Connection({
        ...transportOverrides,
        // High-frequency stream: straight to the listener Set, never `set()`.
        onStream: fanoutStream,
        ...transportHandlers(get, set),
      });
      sidecarHoldStop = holdWhileSidecarDown(conn);
    }
    // A DIFFERENT stream is a different server session, so nothing the previous
    // one asserted may survive into it. Critical for the Status-derived fields:
    // a healthy session starts in `live` and the server broadcasts Status only on
    // a TRANSITION, so a fresh crypto session sends none at all and a stale
    // `closed` would keep the market-closed banner up forever. The epoch geometry
    // goes with it (the new grid restarts at epoch 0 — the old params must not
    // stay resolvable), as does the transport (a new replay clock starts at 1×,
    // playing; live mode ignores these but they must not carry over either).
    // Gated on the identity actually changing: an idempotent re-subscribe never
    // reaches the server, so nothing would ever re-assert what we cleared.
    const prev = get().subscription;
    if (
      prev === null ||
      prev.market !== market ||
      prev.symbol !== symbol ||
      prev.mode !== mode ||
      prev.band !== band ||
      (prev.startNs ?? null) !== startNs ||
      (prev.endNs ?? null) !== endNs
    ) {
      // Materialize the window fields ONLY when one was supplied: an unbounded
      // subscription keeps the exact pre-window state shape every consumer sees.
      const subscription: Subscription = { market, symbol, mode, band };
      if (startNs !== null || endNs !== null) {
        subscription.startNs = startNs;
        subscription.endNs = endNs;
      }
      beginSubscription(get, set, prev, subscription);
    }
    conn.subscribe(market, symbol, mode, band, window);
  },

  requestHistory(before_t, n, overview, signal) {
    if (conn === null) {
      return Promise.reject(new Error('flowmap: not connected'));
    }
    const degradedAtRequest = get().overviewDegraded;
    return conn.requestHistory(before_t, n, overview, signal).then((resp) => {
      // An overview step that overruns its budget is answered as an EMPTY page
      // (session_history.py), which reads as "nothing older" and would be memoized
      // as exhaustion: the zoomed-out range stays blank for the whole degradation.
      // While the server reports it, an empty overview page is a stall: reject it,
      // so the loader backs off and asks again instead of recording a hole.
      const stalled = degradedAtRequest || get().overviewDegraded;
      if (overview !== undefined && stalled && resp.depth_cols.length === 0) {
        throw new Error('flowmap: overview step stalled (overview_degraded)');
      }
      return resp;
    });
  },

  setSpeed(x) {
    // Reflect-on-send: the Connection drops control frames while the socket is
    // down, so an unconditional commit would let the pill claim "50×" the
    // server never received. Only a frame that actually went out updates state.
    if (conn?.setSpeed(x)) set({ speed: x });
  },

  pause() {
    if (conn?.pause()) set({ paused: true });
  },

  resume() {
    if (conn?.resume()) set({ paused: false });
  },

  seek(t) {
    conn?.seek(t);
  },

  retryNow() {
    conn?.reconnectNow();
  },

  disconnect() {
    conn?.close();
    conn = null;
    sidecarHoldStop?.();
    sidecarHoldStop = null;
    forgetReplayEntry();
    set({ status: 'closed', subscription: null });
  },

  onStream(handler) {
    streamListeners.add(handler);
    return () => {
      streamListeners.delete(handler);
    };
  },
}));
