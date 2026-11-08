/**
 * Timeline minimap + replay transport (bottom strip).
 *
 * **Mode-gated, deliberately.** The transport used to render a play/pause button
 * plus a six-rung speed ladder plus a scrubber unconditionally, every one of
 * them `disabled` in LIVE — eight dead controls in the mode the user is in
 * almost all the time, which is exactly what made the tool read as confusing.
 * Now:
 *   - LIVE   → one state pill (FOLLOWING / SCROLLED BACK). The return-to-edge
 *              action lives in the chart's LiveControls chip, not here.
 *   - REPLAY → play/pause + ONE cycling speed button (the 1–100× ladder is
 *              unchanged as the DOMAIN, only its presentation collapses) + the
 *              seek scrubber + the time readout.
 *
 * The pill replaces — rather than adds to — the old minimap LIVE/REPLAY label,
 * and is phrased about the CAMERA (FOLLOWING / SCROLLED BACK), because the top
 * bar's connection chip already owns feed health and a second widget saying
 * "LIVE" in a different sense would make the word meaningless.
 *
 * Right: a minimap of the loaded session extent with the current viewport window
 * marked, and — in replay — a seek scrubber over it. The window follows drawn
 * view notifications through a cheap DOM writer. Extent, playhead and `following`
 * share a ≤4 Hz poll, keeping React and time mapping off the renderer's
 * high-frequency path.
 *
 * **One GO LIVE control.** The in-chart chip in LiveControls is the
 * single GO LIVE affordance; this strip no longer repeats it in the footer.
 *
 * **Attach honesty.** The pill, time readout and controls
 * describe the CURRENT subscription only once it has actually ATTACHED — a
 * Hello for it has landed and the connection is live. Before that, every value
 * still belongs to the session whose frame is on screen (the previous live
 * chart). The old code claimed `REPLAY 1× PLAYING` and printed that dead
 * session's frozen span (`00:02:07.250 / 00:02:07.250`) for as long as the
 * server took to refuse — 1013 session-cap closes of a replay subscribe are
 * the measured repro. Now: pre-attach the pill says what is really happening
 * (`REPLAY CONNECTING…` / `REPLAY REFUSED` / `CONNECTING…`), the readout is
 * `—`, the controls that cannot reach a server are disabled, and a waiting
 * line with an indeterminate progress element carries the reason.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { useT } from '../i18n/useT';
import type { ConnStatus } from '../net/connection';
import { useFlowMapStore } from '../state/store';
import {
  formatDurationNs,
  fractionOfExtent,
  nextSpeed,
  seekTargetNs,
  transportPhase,
  type TimeExtent,
} from './replay';
import { closeReasonText } from './ReconnectBanner';

/** Minimap poll interval (ms). */
const POLL_MS = 250;

interface MinimapGeom {
  leftPct: number;
  widthPct: number;
  extent: TimeExtent | null;
}

const EMPTY_GEOM: MinimapGeom = { leftPct: 0, widthPct: 100, extent: null };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * What the transport is ALLOWED to claim, given the attach state.
 * Pure so the honesty contract is unit-locked:
 *
 * - `attached`  — a Hello for the CURRENT subscription has landed AND the
 *                 connection is live. The ONLY state where the pill may say
 *                 PLAYING/PAUSED and the readout may print a span.
 * - `refused`   — close 1013 arrived while the desired subscription is a
 *                 replay: the server's try-again-later refusal of THAT
 *                 subscription (session limit). Distinct from a dropped
 *                 connection: the transport keeps retrying (backoff), so the
 *                 pill must say refused, not "playing" and not "reconnecting"
 *                 as if a working session dropped.
 * - `reconnecting` / `connecting` — the socket is down / being opened; a
 *                 live fallback lands here (the empty chart).
 * - `no-feed`   — no connection attempt is up (idle / closed terminal).
 */
export type TransportDisplay = 'attached' | 'connecting' | 'reconnecting' | 'refused' | 'no-feed';

export function transportDisplay(
  attached: boolean,
  isReplay: boolean,
  status: ConnStatus,
  lastCloseCode: number | null,
): TransportDisplay {
  if (attached) return 'attached';
  if (status === 'idle' || status === 'closed') return 'no-feed';
  if (isReplay && lastCloseCode === 1013) return 'refused';
  return status === 'reconnecting' ? 'reconnecting' : 'connecting';
}

interface TimelineProps {
  rendererRef: RefObject<Renderer | null>;
  /**
   * Retained so the shell's call site stays valid. This strip no longer renders
   * a GO LIVE button: LiveControls (in the chart) owns that action.
   */
  onGoLive?: () => void;
}

export function Timeline({ rendererRef }: TimelineProps): JSX.Element {
  const t = useT();
  const mode = useFlowMapStore((s) => s.subscription?.mode ?? 'live');
  const paused = useFlowMapStore((s) => s.paused);
  const speed = useFlowMapStore((s) => s.speed);
  const pause = useFlowMapStore((s) => s.pause);
  const resume = useFlowMapStore((s) => s.resume);
  const setSpeed = useFlowMapStore((s) => s.setSpeed);
  const seek = useFlowMapStore((s) => s.seek);
  const status = useFlowMapStore((s) => s.status);
  const sessionId = useFlowMapStore((s) => s.sessionId);
  const lastClose = useFlowMapStore((s) => s.lastClose);
  const playback = useFlowMapStore((s) => s.replayPlayback);

  const [geom, setGeom] = useState<MinimapGeom>(EMPTY_GEOM);
  const [scrub, setScrub] = useState(0); // 0..1000 scrubber position (replay)
  // Camera follow state, from the SAME ≤4 Hz poll as the extent (a plain boolean getter).
  const [following, setFollowing] = useState(true);
  const geomRef = useRef<MinimapGeom>(EMPTY_GEOM);
  const draggingRef = useRef(false); // true while the user actively scrubs
  const seekTimerRef = useRef<number | null>(null); // trailing-throttle handle
  const pendingFracRef = useRef(0); // latest scrub fraction awaiting a seek
  const windowRef = useRef<HTMLDivElement | null>(null);
  const isReplay = mode === 'replay';

  // Coarse refresh owns time mapping, playhead and labels. The drawn window's
  // left/width are owned only by the DOM writer below, never by React styles.
  const refresh = useCallback((): void => {
    const r = rendererRef.current;
    const tl = r?.timeline();
    const state = useFlowMapStore.getState();
    const replay = state.subscription?.mode === 'replay' ? state.replayPlayback : null;
    if (r) setFollowing((f) => (f === r.following ? f : r.following));
    if (!tl) {
      if (geomRef.current !== EMPTY_GEOM) {
        geomRef.current = EMPTY_GEOM;
        setGeom(EMPTY_GEOM);
      }
      return;
    }
    const span = Math.max(1, tl.newestSeq - tl.oldestSeq);
    const leftPct = clamp01((tl.viewStartCol - tl.oldestSeq) / span) * 100;
    const rightPct = clamp01((tl.viewEndCol - tl.oldestSeq) / span) * 100;
    let extent: TimeExtent | null = null;
    let toNs: ((col: number) => bigint) | null = null;
    if (tl.timeBase) {
      const { anchorSeq, anchorT0Ns, dtNs } = tl.timeBase;
      toNs = (col: number): bigint =>
        r?.timestampAtColumn?.(col) ?? anchorT0Ns + BigInt(Math.round((col - anchorSeq) * dtNs));
      extent = { startNs: toNs(tl.oldestSeq), endNs: toNs(tl.newestSeq) };
    }
    if (state.subscription?.mode === 'replay') extent = replay ? { startNs: replay.startNs, endNs: replay.endNs } : null;
    // Advance the playhead: map the newest column to ns and drive the scrubber
    // from its fraction of the session extent — unless the user is scrubbing.
    // Also self-corrects a stale thumb across session/symbol switches.
    if (extent && toNs && !draggingRef.current) {
      const f = fractionOfExtent(replay?.positionNs ?? toNs(tl.newestSeq), extent);
      const nv = Math.round(f * 1000);
      setScrub((prev) => (prev === nv ? prev : nv));
    }
    const next: MinimapGeom = {
      leftPct,
      widthPct: Math.max(0.6, rightPct - leftPct),
      extent,
    };
    const prev = geomRef.current;
    // Skip a re-render unless something moved perceptibly.
    if (
      Math.abs(prev.leftPct - next.leftPct) > 0.3 ||
      Math.abs(prev.widthPct - next.widthPct) > 0.3 ||
      (prev.extent === null) !== (next.extent === null) ||
      prev.extent?.startNs !== next.extent?.startNs || prev.extent?.endNs !== next.extent?.endNs
    ) {
      geomRef.current = next;
      setGeom(next);
    }
  }, [rendererRef]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Ref assignment does not render React: the existing poll also owns renderer
  // attachment. Hot notifications only paint scalar drawn-window geometry.
  useEffect(() => {
    let boundRenderer: Renderer | null = null;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    let attachment = 0;
    let paintedWindow: HTMLDivElement | null = null;
    let paintedLeft = NaN;
    let paintedWidth = NaN;

    const paintWindow = (r: Renderer | null): void => {
      const node = windowRef.current;
      if (!node) return;
      let leftPct = EMPTY_GEOM.leftPct;
      let widthPct = EMPTY_GEOM.widthPct;
      const range = r?.residentRange();
      if (r && range != null) {
        const newest = Math.max(range.newest, r.newestColSeq);
        const view = r.viewSnapshot;
        const right = view.colOffset + view.colScale;
        if (!Number.isFinite(newest) || !Number.isFinite(view.colOffset) ||
            !Number.isFinite(view.colScale) || !Number.isFinite(right)) return;
        // Match timeline(): session oldest=0, newest=max(resident, appended).
        const span = Math.max(1, newest);
        leftPct = clamp01(view.colOffset / span) * 100;
        const rightPct = clamp01(right / span) * 100;
        widthPct = Math.max(0.6, rightPct - leftPct);
      }
      if (node === paintedWindow && leftPct === paintedLeft && widthPct === paintedWidth) return;
      node.style.left = `${leftPct}%`;
      node.style.width = `${widthPct}%`;
      paintedWindow = node;
      paintedLeft = leftPct;
      paintedWidth = widthPct;
    };

    const syncAttachment = (): void => {
      const r = rendererRef.current;
      if (r === boundRenderer) return;
      const token = ++attachment;
      unsubscribe?.();
      unsubscribe = null;
      boundRenderer = r;
      if (r) {
        unsubscribe = r.onViewChanged(() => {
          // The token also rejects a stale callback after A→B→A reattachment.
          if (disposed || token !== attachment || rendererRef.current !== r) return;
          paintWindow(r);
        });
      }
    };

    syncAttachment();
    paintWindow(boundRenderer);
    const id = window.setInterval(() => {
      syncAttachment();
      refreshRef.current();
      paintWindow(boundRenderer);
    }, POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(id);
      unsubscribe?.();
      unsubscribe = null;
      boundRenderer = null;
    };
  }, [rendererRef]);

  // Reset the scrub gate on a mode switch, and drop any pending throttled seek.
  // Keyed on `isReplay` — NOT `[]` — because Timeline never unmounts (App renders
  // it unconditionally): a replay→live switch mid-drag would otherwise leak a
  // Seek onto a LIVE subscription and leave draggingRef stuck true, freezing the
  // playhead for the rest of the session.
  useEffect(() => {
    return () => {
      draggingRef.current = false;
      if (seekTimerRef.current !== null) {
        window.clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, [isReplay]);

  // Emit a Seek at the given scrubber fraction. Early-return on a null extent so
  // no bogus Seek{0} (1970 epoch) is sent before a session's timebase is known.
  const commitSeek = (fraction: number): void => {
    const p = useFlowMapStore.getState().replayPlayback;
    const extent = p ? { startNs: p.startNs, endNs: p.endNs } : geomRef.current.extent;
    if (!extent) return;
    seek(seekTargetNs(fraction, extent));
  };

  // While dragging: immediate thumb feedback (setScrub) but only a trailing,
  // throttled seek so we don't spam the connection with a Seek per input event.
  const onScrub = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    setScrub(v);
    draggingRef.current = true;
    pendingFracRef.current = v / 1000;
    if (seekTimerRef.current === null) {
      seekTimerRef.current = window.setTimeout(() => {
        seekTimerRef.current = null;
        commitSeek(pendingFracRef.current);
      }, 250);
    }
  };

  // Pointer/key release: flush any pending throttled seek and release the drag
  // gate so the poll effect resumes driving the playhead.
  const onScrubCommit = (): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (seekTimerRef.current !== null) {
      window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    commitSeek(pendingFracRef.current);
  };

  // Read the speed at CLICK time, not from the render closure, so a fast
  // double-click steps 1→2→5 instead of emitting SetSpeed(2) twice.
  const onCycleSpeed = (e: React.MouseEvent): void => {
    const current = useFlowMapStore.getState().speed;
    setSpeed(nextSpeed(current, e.shiftKey ? -1 : 1));
  };

  const extent = isReplay ? (playback ? { startNs: playback.startNs, endNs: playback.endNs } : null) : geom.extent;
  // The transport may describe the CURRENT subscription only once it has
  // attached: before that, every value still belongs to the PREVIOUS session
  // whose frame is on screen (the frozen `00:02:07` span under a
  // `REPLAY 1× PLAYING` pill over the stale live chart).
  const attached = status === 'live' && sessionId !== null;
  const display = transportDisplay(attached, isReplay, status, lastClose?.code ?? null);
  const waiting =
    display === 'connecting' || display === 'reconnecting' || display === 'refused';
  const durationNs = extent ? extent.endNs - extent.startNs : 0n;
  const positionNs = extent ? (playback?.positionNs ?? seekTargetNs(scrub / 1000, extent)) - extent.startNs : 0n;
  const playing = attached && isReplay && !paused && !playback?.ended;
  const phase = transportPhase(isReplay, paused, following);
  // `—` until an attached session has produced real geometry — never the dead
  // session's span, and never an invented `00:00:00.000` for "nothing yet".
  const readout =
    attached && extent
      ? isReplay
        ? `${formatDurationNs(positionNs)} / ${formatDurationNs(durationNs)}`
        : formatDurationNs(durationNs)
      : '—';
  const pillClass =
    display === 'attached'
      ? `state-pill state-pill--${phase}`
      : display === 'refused'
        ? 'state-pill state-pill--live-detached'
        : 'state-pill';
  // Translated pill text per phase (replay.ts's phaseLabel is English-only).
  const phaseKey =
    phase === 'live-following' ? 'transport.following'
      : phase === 'live-detached' ? 'transport.scrolledBack'
        : phase === 'replay-playing' ? 'transport.replayPlaying'
          : 'transport.replayPaused';
  let pillText: string;
  switch (display) {
    case 'attached':
      pillText = playback?.ended && isReplay ? t('transport.replayEnded', { speed }) : t(phaseKey, { speed });
      break;
    case 'refused':
      pillText = t('transport.replayRefused');
      break;
    case 'no-feed':
      pillText = t('transport.noFeed');
      break;
    case 'reconnecting':
      pillText = isReplay ? t('transport.replayConnecting') : t('transport.reconnecting');
      break;
    default:
      pillText = isReplay ? t('transport.replayConnecting') : t('transport.connecting');
      break;
  }
  const pillTitle =
    display === 'refused'
      ? t('transport.refusedTitle', { reason: closeReasonText(lastClose) })
      : display === 'reconnecting'
        ? t('transport.waitingReason', { reason: closeReasonText(lastClose) })
        : display === 'connecting'
          ? t('transport.waitingTitle')
          : undefined;
  const waitText =
    display === 'refused'
      ? t('transport.capacity')
      : display === 'reconnecting'
        ? t('transport.waitingReason', { reason: closeReasonText(lastClose) })
        : t('transport.waitingFeed');

  return (
    <footer className="timeline" data-testid="timeline">
      <div className="transport" data-testid="transport">
        {isReplay && (
          <>
            <button
              type="button"
              className={`transport__play${playing ? ' is-playing' : ''}`}
              data-testid="transport-play"
              // The name is the action the button performs now (Pause while playing);
              // no aria-pressed, which would announce the same state a second time.
              aria-label={playing ? t('transport.pause') : t('transport.play')}
              title={
                attached
                  ? playing
                    ? t('transport.pause')
                    : playback?.ended === true
                      ? t('transport.restart')
                      : t('transport.play')
                  : t('transport.attachWait')
              }
              disabled={!attached}
              onClick={() => {
                // A finished replay restarts from its first moment and plays on.
                if (playback?.ended === true && extent) {
                  seek(seekTargetNs(0, extent));
                  resume();
                } else if (paused) {
                  resume();
                } else {
                  pause();
                }
              }}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              className="speed-cycle"
              data-testid="speed-cycle"
              data-speed={speed}
              aria-label={t('transport.speedAria', { speed })}
              title={t('transport.speedTitle')}
              disabled={!attached}
              onClick={onCycleSpeed}
            >
              {speed}×
            </button>
          </>
        )}
      </div>

      <div className={`minimap${isReplay ? ' minimap--replay' : ''}`}>
        <div className="minimap__label">
          <span
            tabIndex={-1}
            className={pillClass}
            data-testid="transport-state"
            data-transport={display}
            title={pillTitle}
          >
            {pillText}
          </span>
          {waiting && (
            <span
              className="minimap__waiting"
              data-testid="transport-waiting"
              role="status"
              aria-live="polite"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              <progress
                data-testid="transport-progress"
                aria-label={t('transport.waitingTitle')}
                style={{ width: 64, height: 6, accentColor: 'var(--accent)' }}
              />
              {waitText}
            </span>
          )}
          {!isReplay && attached && extent && (
            // In live mode the readout is the loaded session's SPAN, not elapsed time.
            <span className="minimap__readout-k" style={{ opacity: 0.6 }}>{t('transport.span')}</span>
          )}
          <span
            className="minimap__readout"
            data-testid="time-readout"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {readout}
          </span>
        </div>
        <div className="minimap__track" data-testid="minimap-track">
          <div className="minimap__extent" style={{ left: 0, width: '100%' }} />
          <div
            ref={windowRef}
            className="minimap__window"
            data-testid="minimap-window"
          />
          {isReplay && (
            <input
              type="range"
              className="minimap__scrub"
              min={0}
              max={1000}
              step={1}
              value={scrub}
              disabled={!attached}
              data-testid="seek-scrubber"
              aria-label={t('transport.seekAria')}
              aria-valuetext={readout}
              onChange={onScrub}
              onPointerUp={onScrubCommit}
              onKeyUp={onScrubCommit}
              onBlur={onScrubCommit}
            />
          )}
        </div>
      </div>
    </footer>
  );
}
