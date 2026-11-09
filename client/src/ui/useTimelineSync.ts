/**
 * The minimap's live state for the transport strip: the session extent and the
 * drawn-window geometry from a ≤4 Hz poll, the replay playhead, the camera's
 * follow flag, and the scrubber's drag-and-seek handlers.
 *
 * The drawn window's left and width are written straight to the DOM by a view
 * listener (`paintWindow`), never through React styles, so a hot pan or zoom does
 * not re-render the strip.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MutableRefObject, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import type { ReplayPlayback } from '../proto/types';
import { fractionOfExtent, seekTargetNs, type TimeExtent } from './replay';

/** Minimap poll interval (ms). */
const POLL_MS = 250;
/** Trailing throttle for a scrub drag: one Seek per this many ms, not one per input event. */
const SCRUB_SEEK_MS = 250;
/** The scrubber's resolution: the range input runs from 0 to SCRUB_STEPS. */
export const SCRUB_STEPS = 1000;

export interface MinimapGeom {
  leftPct: number;
  widthPct: number;
  extent: TimeExtent | null;
}

export const EMPTY_GEOM: MinimapGeom = { leftPct: 0, widthPct: 100, extent: null };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface TimelineSync {
  geom: MinimapGeom;
  /** Scrubber thumb position, from 0 to SCRUB_STEPS. */
  scrub: number;
  /** The camera follows the live edge. */
  following: boolean;
  /** Attached to the drawn-window element the view listener paints. */
  windowRef: RefObject<HTMLDivElement>;
  onScrub: (e: ChangeEvent<HTMLInputElement>) => void;
  onScrubCommit: () => void;
}

/**
 * Paints the drawn window (the viewport on the minimap) straight to the DOM from the
 * renderer's view notifications, and runs the coarse refresh on the same poll.
 * Returns the ref the window element mounts on.
 *
 * Ref assignment does not render React: the existing poll also owns renderer
 * attachment. Hot notifications only paint scalar drawn-window geometry.
 */
function useDrawnWindowPainter(
  rendererRef: RefObject<Renderer | null>,
  refreshRef: MutableRefObject<() => void>,
): RefObject<HTMLDivElement> {
  const windowRef = useRef<HTMLDivElement>(null);

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
  }, [rendererRef, refreshRef]);

  return windowRef;
}

/**
 * Drives the minimap for one renderer. `seek` is the store action the scrubber
 * sends; the hook owns the drag gate so the poll does not fight the thumb.
 */
export function useTimelineSync(
  rendererRef: RefObject<Renderer | null>,
  isReplay: boolean,
  seek: (targetNs: bigint) => void,
): TimelineSync {
  const [geom, setGeom] = useState<MinimapGeom>(EMPTY_GEOM);
  const [scrub, setScrub] = useState(0);
  // Camera follow state, from the SAME poll as the extent (a plain boolean getter).
  const [following, setFollowing] = useState(true);
  const geomRef = useRef<MinimapGeom>(EMPTY_GEOM);
  const draggingRef = useRef(false); // true while the user actively scrubs
  const seekTimerRef = useRef<number | null>(null); // trailing-throttle handle
  const pendingFracRef = useRef(0); // latest scrub fraction awaiting a seek

  // Coarse refresh owns time mapping, playhead and labels. The drawn window's
  // left/width are owned only by the DOM writer below, never by React styles.
  const refresh = useCallback((): void => {
    const r = rendererRef.current;
    const tl = r?.timeline();
    const state = useFlowMapStore.getState();
    const replay: ReplayPlayback | null = state.subscription?.mode === 'replay' ? state.replayPlayback : null;
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
      const nv = Math.round(f * SCRUB_STEPS);
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
  const windowRef = useDrawnWindowPainter(rendererRef, refreshRef);

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
  const commitSeek = useCallback(
    (fraction: number): void => {
      const p = useFlowMapStore.getState().replayPlayback;
      const extent = p ? { startNs: p.startNs, endNs: p.endNs } : geomRef.current.extent;
      if (!extent) return;
      seek(seekTargetNs(fraction, extent));
    },
    [seek],
  );

  // While dragging: immediate thumb feedback (setScrub) but only a trailing,
  // throttled seek so we don't spam the connection with a Seek per input event.
  const onScrub = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    setScrub(v);
    draggingRef.current = true;
    pendingFracRef.current = v / SCRUB_STEPS;
    if (seekTimerRef.current === null) {
      seekTimerRef.current = window.setTimeout(() => {
        seekTimerRef.current = null;
        commitSeek(pendingFracRef.current);
      }, SCRUB_SEEK_MS);
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

  return { geom, scrub, following, windowRef, onScrub, onScrubCommit };
}
