/**
 * The parts of the transport strip: the play and speed buttons, the state pill with
 * its waiting line and readout, and the minimap track with the seek scrubber.
 * Timeline.tsx decides what the strip may claim; these only render it.
 */

import type { ChangeEvent, MouseEvent, RefObject } from 'react';

import type { TFn } from '../i18n/useT';
import { SCRUB_STEPS } from './useTimelineSync';
import { closeReasonText } from './ReconnectBanner';
import type { TransportPhase } from './replay';
import type { TransportDisplay } from './Timeline';

type CloseInfo = Parameters<typeof closeReasonText>[0];

interface TransportButtonsProps {
  t: TFn;
  isReplay: boolean;
  attached: boolean;
  playing: boolean;
  speed: number;
  playTitle: string;
  onPlayToggle: () => void;
  onCycleSpeed: (e: MouseEvent) => void;
}

/** Play or pause and the speed cycle. Replay only: live has no transport to drive. */
export function TransportButtons({
  t,
  isReplay,
  attached,
  playing,
  speed,
  playTitle,
  onPlayToggle,
  onCycleSpeed,
}: TransportButtonsProps): JSX.Element {
  return (
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
            title={playTitle}
            disabled={!attached}
            onClick={onPlayToggle}
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
  );
}

/** The translated pill key for a transport phase. */
function phaseKey(phase: TransportPhase): string {
  switch (phase) {
    case 'live-following':
      return 'transport.following';
    case 'live-detached':
      return 'transport.scrolledBack';
    case 'replay-playing':
      return 'transport.replayPlaying';
    default:
      return 'transport.replayPaused';
  }
}

interface PillCopy {
  pillText: string;
  pillTitle: string | undefined;
  waitText: string;
}

/**
 * The state pill, its tooltip and the waiting line, for what the transport may
 * claim. Pre-attach the copy says what is really happening, never a playing state.
 */
function pillCopy(
  t: TFn,
  display: TransportDisplay,
  isReplay: boolean,
  phase: TransportPhase,
  ended: boolean,
  speed: number,
  lastClose: CloseInfo | null,
): PillCopy {
  let pillText: string;
  switch (display) {
    case 'attached':
      pillText = ended && isReplay ? t('transport.replayEnded', { speed }) : t(phaseKey(phase), { speed });
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
  return { pillText, pillTitle, waitText };
}

interface MinimapLabelProps {
  t: TFn;
  display: TransportDisplay;
  phase: TransportPhase;
  ended: boolean;
  speed: number;
  isReplay: boolean;
  pillClass: string;
  waiting: boolean;
  lastClose: CloseInfo | null;
  /** A live session's span readout (rather than an elapsed-time readout). */
  live: boolean;
  readout: string;
}

/** The state pill, the waiting line and the time readout above the minimap. */
export function MinimapLabel({
  t,
  display,
  phase,
  ended,
  speed,
  isReplay,
  pillClass,
  waiting,
  lastClose,
  live,
  readout,
}: MinimapLabelProps): JSX.Element {
  const { pillText, pillTitle, waitText } = pillCopy(t, display, isReplay, phase, ended, speed, lastClose);
  return (
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
      {live && (
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
  );
}

interface MinimapTrackProps {
  t: TFn;
  windowRef: RefObject<HTMLDivElement>;
  isReplay: boolean;
  attached: boolean;
  scrub: number;
  readout: string;
  onScrub: (e: ChangeEvent<HTMLInputElement>) => void;
  onScrubCommit: () => void;
}

/** The minimap track: the session extent, the drawn window and, in replay, the seek scrubber. */
export function MinimapTrack({
  t,
  windowRef,
  isReplay,
  attached,
  scrub,
  readout,
  onScrub,
  onScrubCommit,
}: MinimapTrackProps): JSX.Element {
  return (
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
          max={SCRUB_STEPS}
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
  );
}
