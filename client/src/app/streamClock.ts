import { useEffect, useState } from 'react';

import type { Renderer } from '../gl/renderer';

/** How often the stream clock re-reads the renderer's time map. */
export const STREAM_CLOCK_TICK_MS = 1000;

/** Format an absolute (session-relative for sim) ns timestamp as HH:MM:SS, or null when out of range. */
export function fmtStreamClock(ns: bigint): string | null {
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().slice(11, 19);
  } catch {
    return null;
  }
}

/** The newest stream column's wall-clock time as HH:MM:SS, refreshed at ≤1 Hz. Null until data arrives. */
export function useStreamClock(rendererRef: { readonly current: Pick<Renderer, 'timeline'> | null }): string | null {
  const [streamClock, setStreamClock] = useState<string | null>(null);
  useEffect(() => {
    const tick = (): void => {
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) {
        setStreamClock((c) => (c === null ? c : null));
        return;
      }
      const { anchorSeq, anchorT0Ns, dtNs } = tl.timeBase;
      const ns = anchorT0Ns + BigInt(Math.round((tl.newestSeq - anchorSeq) * dtNs));
      const next = fmtStreamClock(ns);
      setStreamClock((c) => (c === next ? c : next));
    };
    const id = window.setInterval(tick, STREAM_CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);
  return streamClock;
}
