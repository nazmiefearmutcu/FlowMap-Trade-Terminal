/**
 * `Status.capability` keys the server sets while the session's recording writer
 * is wedged (core/session.py `_recording_wedged`): rows are no longer being
 * persisted for this session, so a replay of it would have a gap. Both keys are
 * absent while recording is healthy.
 */
export const RECORDING_HEALTH_KEY = 'recording_health';
export const RECORDING_WEDGED = 'wedged';
export const RECORDING_DEGRADED_KEY = 'recording_degraded';

/**
 * True when a Status capability reports that recording has stopped persisting,
 * by either the health value or the explicit degraded flag.
 */
export function recordingDegraded(capability: Record<string, unknown> | null | undefined): boolean {
  return capability?.[RECORDING_HEALTH_KEY] === RECORDING_WEDGED || capability?.[RECORDING_DEGRADED_KEY] === true;
}
