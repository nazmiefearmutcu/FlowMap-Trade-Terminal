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

import {
  Connection,
  pruneEpochs,
  type CloseInfo,
  type ConnStatus,
  type ConnectionOptions,
  type StreamMsg,
  type SubscribeWindow,
} from '../net/connection';
import { recordingDegraded } from '../net/recordingState';
import { holdWhileSidecarDown } from '../net/sidecarHold';
import { playbackFromCapability, type ReplayPlayback, type EpochParams, type FeedState, type HistoryResponse, type StreamMode } from '../proto/types';

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

/**
 * The GRID a subscription renders, for the revision counter: market, symbol,
 * band and replay window, but NOT mode. A live⇄replay toggle keeps the grid, so
 * it must not bump {@link FlowMapState.sessionRevision} (scroll-back survives).
 */
function gridIdentity(sub: Subscription | null): string | null {
  if (sub === null) return null;
  return `${sub.market}:${sub.symbol}:${sub.band}:${sub.startNs ?? ''}-${sub.endNs ?? ''}`;
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
let replayEntryPending = false;
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
        onHello: (hello) => {
          // Captured BEFORE the set() below clears them: they say whether this
          // Hello is a RECONNECT (the first handshake has no drop behind it).
          const wasReconnect =
            get().lastClose !== null || get().reconnectAttempts > 0;
          const playback = playbackFromCapability(hello.capability);
          const changed = get().sessionId !== hello.session_id;
          const epochs = changed ? new Map<number, EpochParams>() : new Map(get().epochs);
          epochs.set(hello.epoch_params.epoch, hello.epoch_params);
          pruneEpochs(epochs, hello.grid_epoch);
          set({
            sessionId: hello.session_id,
            attachEpoch: get().attachEpoch + 1,
            protocolVersion: hello.protocol_version,
            capability: hello.capability,
            normSeed: hello.norm_seed,
            gridEpoch: hello.grid_epoch,
            epochs,
            replayPlayback: playback,
            ...(playback ? { speed: playback.speed, paused: playback.paused } : {}),
            // The handshake completed: whatever drop the banner was counting
            // is over, and its close info is stale.
            reconnectAttempts: 0,
            lastClose: null,
            // NOTE `replayUnavailable` is deliberately NOT cleared here. The
            // live fallback triggered by the refusal lands its own handshake
            // moments later — clearing on Hello would erase the refusal the
            // instant it is shown. It retires on a NEW replay attempt or a
            // different stream instead (see connectAndSubscribe).
          });
          // User entry resets a reused parked selection to paused beginning.
          // Network reconnect accepts authoritative state without rewinding;
          // older servers lacking playback metadata retain the legacy echo.
          const freshEntry = replayEntryPending;
          replayEntryPending = false;
          if (freshEntry && playback && get().subscription?.startNs != null) {
            get().pause();
            get().setSpeed(1);
            get().seek(playback.startNs);
          } else if (!playback && wasReconnect && get().subscription?.mode === 'replay') {
            get().setSpeed(get().speed);
            if (get().paused) get().pause();
            else get().resume();
          }
        },
        onEpochStart: (ev) => {
          // Advance the grid epoch to the newest re-anchored frame so the price
          // axis + overlays follow it (e.g. an equity grid re-anchoring from its
          // nominal $100 p0 to the symbol's real price mid-stream). Only ever
          // advance: history responses batch EpochStarts for OLDER epochs
          // and must not regress the live price frame.
          const cur = get().gridEpoch;
          const gridEpoch = cur === null ? ev.epoch : Math.max(cur, ev.epoch);
          // No-op guard: reconnect snapshots re-send EpochStarts we already hold.
          // Epoch geometry is immutable per epoch (a re-anchor is a NEW epoch),
          // so a known epoch whose grid cursor wouldn't advance carries zero new
          // information — skipping it avoids a fresh Map + set() (and the
          // re-render of every `epochs` subscriber) for a duplicate.
          if (get().epochs.has(ev.epoch) && gridEpoch === cur) return;
          const epochs = new Map(get().epochs);
          epochs.set(ev.epoch, ev.epoch_params);
          // Bounded like the transport's own map: the copy above is O(n) per
          // re-anchor, so an unbounded session would turn it quadratic.
          pruneEpochs(epochs, gridEpoch);
          set({ epochs, gridEpoch });
        },
        onStatus: (status) => {
          const playback = playbackFromCapability(status.capability);
          set({
            // The server sends feed_state 'reconnecting' only as a pre-Hello progress
            // Status while a subscribe prepares, never for a real reconnect (that is the
            // transport's connection status). Surfacing it would make the startup gate
            // read "reconnecting" on a healthy cold subscribe, so it is not a feed state.
            feedState: status.feed_state === 'reconnecting' ? null : status.feed_state,
            // Only a closed Status carries a next open; a live/degraded Status
            // clears any stale countdown target.
            nextOpenTs: status.next_open_ts ?? null,
            capability: status.capability,
            recordingDegraded: recordingDegraded(status.capability),
            latencyMs: status.latency_ms,
            clockSkewMs: status.clock_skew_ms,
            replayPlayback: playback,
            ...(playback ? { speed: playback.speed, paused: playback.paused } : {}),
          });
        },
        onConnStatus: (status) => set({ status }),
        // Every unexpected close updates the banner's reason text (the code /
        // clean flag is the honest "what happened" the user can act on).
        onCloseInfo: (info) => set({ lastClose: info }),
        // Fired on every scheduled reconnect (consecutive ones keep the status
        // at 'reconnecting', so onConnStatus alone would go stale).
        onReconnectScheduled: (attempt) => set({ reconnectAttempts: attempt }),
        // The pre-close Status said feed_state='closed' — NO feed exists for
        // this market. Terminal: do NOT re-subscribe (a live fallback would be
        // refused exactly the same); leave the (dead) subscription in place so
        // the banner can name the market, and let the ClosedBanner's no-feed
        // variant state the truth. A DIFFERENT subscription from the user is
        // the only way forward, and it clears the flag in the reset below.
        onNoFeed: () => set({ noFeed: true }),
        // A live subscription the server refused for good (1003 + degraded): the
        // transport has stopped retrying. Surface the server's reason.
        onRefused: (reason) => set({ refusal: { reason } }),
        // Another wire version: parked, not retried. The banner names both.
        onProtocolMismatch: (info) => set({ protocolMismatch: info }),
        // The server honestly refused the replay subscribe (1003 — no recording
        // for this session). Fall back to LIVE right away so the user is not
        // stranded on a "reconnecting · degraded" loop that can never succeed,
        // and flag it so the TopBar can say WHY the replay did not start. The
        // flag clears on the next accepted handshake (the live re-subscribe's).
        onReplayRefused: () => {
          set({ replayUnavailable: true });
          const sub = get().subscription;
          if (sub && sub.mode === 'replay') {
            // Mode belongs to the reset identity, so LIVE fallback clears the
            // replay ring and restores the user's live camera policy.
            get().connectAndSubscribe(sub.market, sub.symbol, 'live', sub.band);
          }
        },
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
      // A grid-identity change is a new revision; a mode-only change is not
      // (`sessionResetKey` excludes the mode on purpose).
      const gridChanged = gridIdentity(prev) !== gridIdentity(subscription);
      set({
        subscription,
        sessionRevision: get().sessionRevision + (gridChanged ? 1 : 0),
        replayPlayback: null,
        speed: 1,
        paused: false,
        feedState: null,
        nextOpenTs: null,
        latencyMs: null,
        clockSkewMs: null,
        // Re-asserted by the new session's Hello on attach.
        sessionId: null,
        capability: null,
        recordingDegraded: false,
        epochs: new Map(),
        gridEpoch: null,
        // A different stream is a new question: its refusal (if any) is not ours.
        refusal: null,
        protocolMismatch: null,
        // normSeed belongs to this list for the same reason and matters more
        // than most of it: gl/renderer.ts latches the seed ONCE behind a
        // one-shot flag, so a survivor is not a stale frame — the new session
        // normalises its entire life against the previous symbol's density
        // scale (a $60k book's p99 against a $180 stock's).
        normSeed: null,
        // A different stream is a NEW question: a previous stream's terminal
        // no-feed refusal and its drop/retry history must not shadow it.
        noFeed: false,
        lastClose: null,
        reconnectAttempts: 0,
      });
      replayEntryPending = mode === 'replay';
      // `replayUnavailable` is deliberately NOT in the reset block: the live
      // fallback below (a mode change) passes through here, and wiping the flag
      // the same instant it is set would hide the refusal from the TopBar. It
      // is cleared only where its meaning genuinely ends — a fresh REPLAY
      // attempt (a new "maybe this one has a recording") and the next accepted
      // handshake — and retired when a DIFFERENT stream is subscribed (a new
      // symbol/recording pair).
      if (mode === 'replay') set({ replayUnavailable: false });
      else if (
        prev !== null &&
        (prev.market !== market || prev.symbol !== symbol)
      ) {
        set({ replayUnavailable: false });
      }
    }
    conn.subscribe(market, symbol, mode, band, window);
  },

  requestHistory(before_t, n, overview, signal) {
    if (conn === null) {
      return Promise.reject(new Error('flowmap: not connected'));
    }
    return conn.requestHistory(before_t, n, overview, signal);
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
    replayEntryPending = false;
    set({ status: 'closed', subscription: null });
  },

  onStream(handler) {
    streamListeners.add(handler);
    return () => {
      streamListeners.delete(handler);
    };
  },
}));
