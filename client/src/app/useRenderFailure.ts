import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { Renderer } from '../gl/renderer';

/** How often the renderer's failure state is sampled. */
export const RENDER_FAILURE_POLL_MS = 500;
/** Consecutive failed polls before the fallback replaces the chart (one bad frame never does). */
export const RENDER_FAILURE_POLLS = 3;

/**
 * The renderer records the last frame's error and clears it on the next clean
 * frame. Only a failure that survives {@link RENDER_FAILURE_POLLS} consecutive
 * polls is surfaced, so one bad frame never swaps the chart for the fallback.
 * `attempt` restarts the sampling whenever the renderer is re-created.
 */
export function useRenderFailure(
  rendererRef: { readonly current: Pick<Renderer, 'getRenderFailure'> | null },
  attempt: number,
): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [renderFailure, setRenderFailure] = useState<string | null>(null);
  useEffect(() => {
    let streak = 0;
    const id = window.setInterval(() => {
      const failure = rendererRef.current?.getRenderFailure?.() ?? null;
      streak = failure === null ? 0 : streak + 1;
      const next = streak >= RENDER_FAILURE_POLLS ? failure : null;
      setRenderFailure((prev) => (prev === next ? prev : next));
    }, RENDER_FAILURE_POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef, attempt]);
  return [renderFailure, setRenderFailure];
}
