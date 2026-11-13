/**
 * Time axis along the bottom edge.
 *
 * A thin bottom gutter whose `<canvas>` the {@link Renderer} draws wall-clock time
 * ticks into every dirty frame (see gl/overlays/axes.ts `drawTimeAxis`), derived
 * from each column's `t0_ns`. The gutter shares the heatmap viewport's WIDTH, so a
 * column maps to the same x in both — the labels stay pinned under pan/zoom. React
 * owns only the chrome + the canvas element; the renderer paints the pixels.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { fmtClockMs } from '../gl/overlays/axisTicks';
import { exchangeZoneFor, formatZonedDayTime, useTimeZone } from '../i18n/format';
import { useFlowMapStore } from '../state/store';
import { useCrosshairProbe } from './crosshairStore';
import { marketGroup } from './symbols';

interface TimeAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
}

interface Measured {
  /** Width of the axis gutter, CSS px. */
  axis: number;
  /** Width of the crosshair time tag, CSS px. */
  tag: number;
}

/**
 * The tag's horizontal centre, pulled in so the whole tag stays inside the
 * gutter. Before the first measurement (widths zero) the centre is the cursor.
 */
function clampCentre(x: number, tagWidth: number, axisWidth: number): number {
  if (tagWidth <= 0 || axisWidth <= 0) return x;
  const half = tagWidth / 2;
  return Math.min(Math.max(x, half), Math.max(half, axisWidth - half));
}

export function TimeAxis({ canvasRef }: TimeAxisProps): JSX.Element {
  const probe = useCrosshairProbe();
  const zonePref = useTimeZone();
  const market = useFlowMapStore((s) => s.subscription?.market ?? '');
  const exchangeZone = exchangeZoneFor(marketGroup(market));
  const axisRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured>({ axis: 0, tag: 0 });

  const timeNs = probe?.timeNs ?? null;
  let text = '';
  if (probe && timeNs !== null) {
    // A session-relative sim time reads the T+ clock with no date, as the readout box does.
    text = probe.sessionRelative
      ? fmtClockMs(timeNs)
      : formatZonedDayTime(Number(timeNs / 1_000_000n), zonePref, exchangeZone);
  }

  // The clamp needs the widths on screen. The tag's width changes with its text,
  // so the widths are read whenever the text changes. A width change costs one
  // extra render, which React runs before the browser paints.
  useLayoutEffect(() => {
    const axis = axisRef.current?.clientWidth ?? 0;
    const tag = tagRef.current?.offsetWidth ?? 0;
    if (axis !== measured.axis || tag !== measured.tag) setMeasured({ axis, tag });
  }, [text, measured.axis, measured.tag]);

  return (
    <div className="time-axis" aria-hidden="true" ref={axisRef}>
      <canvas ref={canvasRef} className="axis-canvas" />
      {probe !== null && timeNs !== null && (
        <div
          ref={tagRef}
          className="axis-tag axis-tag--time"
          data-testid="crosshair-time-tag"
          aria-hidden="true"
          style={{ left: `${clampCentre(probe.x, measured.tag, measured.axis)}px` }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
