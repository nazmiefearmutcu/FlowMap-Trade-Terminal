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

import type { RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { useT } from '../i18n/useT';
import type { ConnStatus } from '../net/connection';
import { useFlowMapStore } from '../state/store';
import { formatDurationNs, nextSpeed, seekTargetNs, transportPhase } from './replay';
import { MinimapLabel, MinimapTrack, TransportButtons } from './TimelineParts';
import { SCRUB_STEPS, useTimelineSync } from './useTimelineSync';

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
  const isReplay = mode === 'replay';
  const { geom, scrub, following, windowRef, onScrub, onScrubCommit } = useTimelineSync(rendererRef, isReplay, seek);

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
  const positionNs = extent ? (playback?.positionNs ?? seekTargetNs(scrub / SCRUB_STEPS, extent)) - extent.startNs : 0n;
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

  // A finished replay restarts from its first moment and plays on.
  const onPlayToggle = (): void => {
    if (playback?.ended === true && extent) {
      seek(seekTargetNs(0, extent));
      resume();
    } else if (paused) {
      resume();
    } else {
      pause();
    }
  };
  const playTitle = attached
    ? playing
      ? t('transport.pause')
      : playback?.ended === true
        ? t('transport.restart')
        : t('transport.play')
    : t('transport.attachWait');

  return (
    <footer className="timeline" data-testid="timeline">
      <TransportButtons
        t={t}
        isReplay={isReplay}
        attached={attached}
        playing={playing}
        speed={speed}
        playTitle={playTitle}
        onPlayToggle={onPlayToggle}
        onCycleSpeed={onCycleSpeed}
      />
      <div className={`minimap${isReplay ? ' minimap--replay' : ''}`}>
        <MinimapLabel
          t={t}
          display={display}
          phase={phase}
          ended={playback?.ended === true}
          speed={speed}
          isReplay={isReplay}
          pillClass={pillClass}
          waiting={waiting}
          lastClose={lastClose}
          live={!isReplay && attached && extent !== null}
          readout={readout}
        />
        <MinimapTrack
          t={t}
          windowRef={windowRef}
          isReplay={isReplay}
          attached={attached}
          scrub={scrub}
          readout={readout}
          onScrub={onScrub}
          onScrubCommit={onScrubCommit}
        />
      </div>
    </footer>
  );
}
