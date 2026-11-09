/**
 * The store's transport wiring: the Connection callbacks that fold server frames
 * into the session state, and the state a new subscription resets. Split out of
 * store.ts so the action map stays readable. It reads and writes only the store
 * (get/set); nothing here is rendered by React, and the high-frequency stream
 * never passes through it.
 */

import { pruneEpochs, type ConnectionOptions } from '../net/connection';
import { overviewDegraded } from '../net/overviewState';
import { recordingDegraded } from '../net/recordingState';
import { playbackFromCapability, type EpochParams } from '../proto/types';
import type { FlowMapState, Subscription } from './store';

type StoreGet = () => FlowMapState;
type StoreSet = (partial: Partial<FlowMapState>) => void;

/** A user entry into replay: the first Hello of that stream parks the selection at its beginning. */
let replayEntryPending = false;

/** A disconnect ends any replay entry that had not reached its first Hello. */
export function forgetReplayEntry(): void {
  replayEntryPending = false;
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

/** The Connection callbacks that write the store (everything except the stream fan-out). */
export function transportHandlers(get: StoreGet, set: StoreSet): Partial<ConnectionOptions> {
  return {
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
        overviewDegraded: overviewDegraded(status.capability),
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
  };
}

/**
 * The reset a DIFFERENT subscription performs (the caller has checked that the
 * identity changed): nothing the previous stream asserted may survive into it.
 */
export function beginSubscription(get: StoreGet, set: StoreSet, prev: Subscription | null, subscription: Subscription): void {
  const { market, symbol, mode } = subscription;
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
    overviewDegraded: false,
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
