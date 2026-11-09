/**
 * Measure tool — a chart ruler that works with the pointer or the keyboard.
 *
 * `M` arms the tool. A click-drag on the chart draws a rectangle, and so does the
 * keyboard: the arrow keys move a virtual cursor (Shift moves ten cells), Enter
 * sets the first corner, the arrows move the opposite corner, and a second Enter
 * sets it. The readout is Δprice (absolute + %), Δtime (human units) and, when
 * derivable from the store, the resting depth inside the row band (bid / ask sums
 * from the current settled book, labelled `vol` on SYNTH feeds). The status line
 * announces each corner and the finished measurement. Esc exits (cancelling an
 * in-progress measurement); a finished measurement persists on the chart until
 * the next click or Enter starts a new one.
 *
 * It is a PURE DOM overlay (the Crosshair pattern): an absolutely-positioned
 * layer over the GL canvas that is `pointer-events: none` while disarmed — so
 * pan/zoom gestures on the canvas are untouched — and takes the pointer only
 * while armed. Coordinates flow through an injectable {@link ChartMapPair}
 * (`fromChart` / `toChart`): the host passes one built on the
 * renderer (see {@link rendererChartMap}); the DEFAULT is the identity map so
 * the component renders standalone in tests and stories.
 *
 * All data math reads the stores directly: Δtime = Δcol × epoch `dt_ns` (exact
 * within an epoch — no renderer probe needed), prices from the epoch scale,
 * depth from the shared book buffer. Works identically in replay: the view
 * transform already IS the replay camera.
 *
 * The parts: the interaction state (armed flag, drag, keyboard cursor) in
 * MeasureToolState.ts, the math and formatting in MeasureMath.ts, the readout box
 * in MeasureToolParts.tsx.
 */

import type { MutableRefObject, RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { useT } from '../i18n/useT';
import { useKeyboardCursor, useMeasureGeometry, useMeasureState, usePointerMeasure, type ChartMapPair } from './MeasureToolState';
import { boxStyle, MeasureReadout } from './MeasureToolParts';
import './features.css';

export type { ChartMapPair } from './MeasureToolState';
export {
  EN_DELTA_TIME_UNITS,
  fmtDeltaPct,
  fmtDeltaPrice,
  fmtDeltaTime,
  priceAtRow,
  sumDepthInBand,
  type DeltaTimeUnits,
} from './MeasureMath';

/**
 * The production mapping pair uses the continuous price projection. Drawing
 * a price must not snap it to a coarse depth bucket in a hybrid wing.
 */
export function rendererChartMap(rendererRef: MutableRefObject<Renderer | null>): ChartMapPair {
  return {
    fromChart: (x, y) => {
      const r = rendererRef.current;
      if (!r) return null;
      return r.canvasCssToGrid(x, y);
    },
    toChart: (col, row) => {
      const r = rendererRef.current;
      if (!r) return { x: 0, y: 0 };
      return r.gridToCanvasCss(col, row);
    },
  };
}

interface MeasureToolProps {
  /** The chart container (position:relative) this overlay is anchored to. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Container px ⇄ data space mapping. Defaults to the IDENTITY map; the
   * host passes `rendererChartMap(rendererRef)` in the real app.
   */
  map?: ChartMapPair;
}

export function MeasureTool({ containerRef, map }: MeasureToolProps): JSX.Element {
  const t = useT();
  const state = useMeasureState();
  useKeyboardCursor(state, containerRef, map);
  const { onPointerDown, onPointerMove, finishDrag } = usePointerMeasure(state, containerRef, map);
  const { armed, rect, readout, cursor, notice } = state;
  const geometry = useMeasureGeometry(readout);

  const statusText =
    notice === 'start'
      ? t('measure.keyStart')
      : notice === 'done' && readout
        ? t('measure.keyDone', { delta: geometry.deltaPriceText, time: geometry.deltaTimeText })
        : t('measure.modeHint');

  return (
    <div
      className={`measure${armed ? ' is-armed' : ''}`}
      data-testid="measure-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {readout && rect && (
        <>
          <div
            className="measure__rect"
            data-testid="measure-rect"
            style={{
              left: `${Math.min(rect.anchor.x, rect.end.x)}px`,
              top: `${Math.min(rect.anchor.y, rect.end.y)}px`,
              width: `${Math.abs(rect.end.x - rect.anchor.x)}px`,
              height: `${Math.abs(rect.end.y - rect.anchor.y)}px`,
            }}
          />
          <MeasureReadout style={boxStyle(containerRef, rect)} {...geometry} />
        </>
      )}
      {armed && cursor && (
        <div
          className="measure__cursor"
          aria-hidden="true"
          style={{
            left: `${cursor.px.x}px`,
            top: `${cursor.px.y}px`,
            width: 12,
            height: 12,
            transform: 'translate(-50%, -50%)',
            border: '1px solid var(--accent)',
            borderRadius: '50%',
            position: 'absolute',
            pointerEvents: 'none',
          }}
        />
      )}
      {armed && (
        <div className="measure__mode" data-testid="measure-mode" role="status" aria-live="polite">
          {statusText}
        </div>
      )}
    </div>
  );
}
