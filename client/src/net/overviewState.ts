/**
 * `Status.capability` key the server sets while an overview step overruns its
 * budget (core/session_history.py): the session keeps streaming, but the coarse
 * overview lags until a step completes again. The key is absent while it keeps up.
 */
export const OVERVIEW_DEGRADED_KEY = 'overview_degraded';

/** True when a Status capability reports that the overview is running behind. */
export function overviewDegraded(capability: Record<string, unknown> | null | undefined): boolean {
  return capability?.[OVERVIEW_DEGRADED_KEY] === true;
}
