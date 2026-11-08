import type { FlowMapState } from '../../state/store';
import type { HeatmapView } from '../heatmap';

/**
 * Per-frame state shared by the renderer and its render/* helpers. Renderer owns
 * the one record and every helper holds the same reference, so a view move or a
 * dirty mark made by any helper is seen by every other reader.
 */
export interface FrameState {
  /** Drawn view uniforms (includes the eased live-edge lag). */
  view: HeatmapView;
  /** Redraw on the next rAF tick (new column, view change, resize). */
  dirty: boolean;
  /** The view moved this frame, so the HistoryLoader must ensure the visible range. */
  viewMoved: boolean;
  /** Newest absolute col_seq appended (or -1 before any column). */
  newestSeq: number;
  /** Start time (ns) of the newest appended column. */
  newestT0Ns: bigint;
}

/** The flow store as the helpers see it: read-only state access. */
export interface StateSource {
  getState(): FlowMapState;
}

/** A fresh frame record: nothing dirty, no column yet. */
export function createFrameState(view: HeatmapView): FrameState {
  return { view, dirty: false, viewMoved: false, newestSeq: -1, newestT0Ns: 0n };
}
