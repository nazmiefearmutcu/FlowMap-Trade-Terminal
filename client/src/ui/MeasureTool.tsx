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
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import {
  rowToPrice as scaleRowToPrice,
  scaleFromEpoch,
  stepAtRow as scaleStepAtRow,
} from '../gl/priceScale';
import type { EpochParams } from '../proto/types';
import { quoteDecimals } from '../gl/overlays/axisTicks';
import { formatFixed, formatPrice } from '../i18n/format';
import { useT } from '../i18n/useT';
import { BookBuffer, getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { routeGlobalKey, classifyTarget } from '../input/keys';
import { depthIsSynthetic } from './heatLegendModel';
import { formatSizeReadout } from '../i18n/format';
import './features.css';

// --- chart mapping contract (identity by default) ------------------

/**
 * Chart-container CSS px ⇄ chart data space. `col` is the fractional absolute
 * column (column c spans [c, c+1)); `row` is the fractional grid row with row 0
 * at the BOTTOM of the price grid (renderer conventions).
 */
export interface ChartMapPair {
  /** Container px → data space; null when the point cannot be placed (no data yet). */
  fromChart?: (x: number, y: number) => { col: number; row: number } | null;
  /** Data space → container px (places the overlay rectangle / readout). */
  toChart?: (col: number, row: number) => { x: number; y: number };
}

const IDENTITY: Required<ChartMapPair> = {
  fromChart: (x, y) => ({ col: x, row: y }),
  toChart: (col, row) => ({ x: col, y: row }),
};

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

// --- pure math helpers (unit-tested) ---------------------------------------------

/** Price at a grid row through the epoch scale, + the decimals to print it with. */
export function priceAtRow(
  row: number,
  params: EpochParams | null,
): { price: number; decimals: number } | null {
  if (params === null || !Number.isFinite(row)) return null;
  const scale = scaleFromEpoch(params);
  const price = scaleRowToPrice(scale, row);
  if (!Number.isFinite(price)) return null;
  // The venue tick sets the precision (exact for 0.25-style ticks, up to 12
  // places); a fixed 8-place cap printed sub-tick noise on tiny-priced coins.
  const decimals = quoteDecimals(scaleStepAtRow(scale, row));
  return { price, decimals };
}

/** Unit suffixes for {@link fmtDeltaTime}: English by default, the UI passes its own table. */
export interface DeltaTimeUnits {
  ns: string;
  ms: string;
  s: string;
  m: string;
  h: string;
  d: string;
}

export const EN_DELTA_TIME_UNITS: DeltaTimeUnits = { ns: 'ns', ms: 'ms', s: 's', m: 'm', h: 'h', d: 'd' };

/** Human Δtime for a non-negative nanosecond span, in the given unit suffixes. */
export function fmtDeltaTime(ns: bigint, units: DeltaTimeUnits = EN_DELTA_TIME_UNITS): string {
  if (ns < 0n) ns = -ns;
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ns}${units.ns}`;
  if (ms < 1_000) return `${Math.round(ms)}${units.ms}`;
  if (ms < 10_000) return `${formatFixed(ms / 1_000, 1)}${units.s}`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}${units.s}`;
  const totalMin = Math.floor(ms / 60_000);
  const totalHr = Math.floor(ms / 3_600_000);
  if (totalHr < 1) return `${totalMin}${units.m} ${Math.round((ms % 60_000) / 1_000)}${units.s}`;
  if (totalHr < 24) return `${totalHr}${units.h} ${totalMin % 60}${units.m}`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}${units.d} ${totalHr % 24}${units.h}`;
}

/** Signed Δprice formatted against the grid's decimals (the price format: always '.'). */
export function fmtDeltaPrice(delta: number, decimals: number): string {
  if (!Number.isFinite(delta)) return '—';
  return `${delta >= 0 ? '+' : '−'}${formatPrice(Math.abs(delta), decimals)}`;
}

/** Δ as a percent of the start price, two decimals, signed, in the UI locale. */
export function fmtDeltaPct(delta: number, base: number): string {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return '—';
  const pct = (delta / base) * 100;
  return `${pct >= 0 ? '+' : '−'}${formatFixed(Math.abs(pct), 2)}%`;
}

/** Summed resting depth inside a half-open row band of the current book. */
export function sumDepthInBand(
  book: BookBuffer | null,
  rowLo: number,
  rowHi: number,
): { bid: number; ask: number | null } | null {
  if (book === null) return null;
  const lo = Math.max(0, Math.floor(Math.min(rowLo, rowHi)));
  const hi = Math.min(book.bid.length, Math.ceil(Math.max(rowLo, rowHi)));
  if (hi <= lo) return null;
  let bid = 0;
  let ask = book.ask === null ? null : 0;
  for (let r = lo; r < hi; r += 1) {
    bid += book.bid[r];
    if (ask !== null && book.ask !== null) ask += book.ask[r];
  }
  if (ask !== null && !Number.isFinite(ask)) ask = null;
  return { bid, ask };
}

// --- the component ----------------------------------------------------------------

interface DragState {
  /** Anchor point in data space (set on pointerdown). */
  anchor: { col: number; row: number };
  /** Live end point (follows the pointer until release). */
  end: { col: number; row: number };
  /** Anchor + end in container px, frozen at drag start/end for placement. */
  px: { anchor: { x: number; y: number }; end: { x: number; y: number } };
  dragging: boolean;
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

/** A settled or in-progress measurement in container px. */
type Rect = DragState['px'];

/** Cells the arrow keys move the virtual cursor per press, and per press with Shift. */
const KEY_STEP = 1;
const KEY_STEP_FAST = 10;

/** Arrow key → the (col, row) step it moves the cursor by. Row 0 is the bottom, so Up adds a row. */
const ARROW_STEP: Readonly<Record<string, { dCol: number; dRow: number }>> = {
  ArrowLeft: { dCol: -1, dRow: 0 },
  ArrowRight: { dCol: 1, dRow: 0 },
  ArrowUp: { dCol: 0, dRow: 1 },
  ArrowDown: { dCol: 0, dRow: -1 },
};

/**
 * Keyboard measuring acts only on the chart itself (the body, the window or the
 * chart canvas), never while focus sits on a control such as a toolbar button that
 * needs its own Enter and arrow keys.
 */
function isChartKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target === document.body) return true;
  return target.closest('.gl-canvas, .measure') !== null;
}

/** The keyboard cursor: the data-space cell and its container px. */
interface KeyCursor {
  col: number;
  row: number;
  px: { x: number; y: number };
}

/** Which keyboard corner step was announced last, so the status line says the right thing. */
type KeyNotice = 'start' | 'done' | null;

export function MeasureTool({ containerRef, map }: MeasureToolProps): JSX.Element {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [readout, setReadout] = useState<DragState | null>(null);
  const [cursor, setCursor] = useState<KeyCursor | null>(null);
  const [notice, setNotice] = useState<KeyNotice>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const cursorRef = useRef<KeyCursor | null>(null);

  // `M` arms/disarms; Esc cancels (drag → reset to anchor; idle → exit+clear).
  // Guards mirror the app router: never while typing or when a dialog is open.
  useEffect(() => {
    const clearAll = (): void => {
      dragRef.current = null;
      cursorRef.current = null;
      setRect(null);
      setReadout(null);
      setCursor(null);
      setNotice(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type === 'toggle-measure') {
        e.preventDefault();
        // A held M must not flip the tool on and off on every auto-repeat.
        if (e.repeat) return;
        const next = !armedRef.current;
        armedRef.current = next;
        setArmed(next);
        if (!next) clearAll();
        return;
      }
      if (e.key !== 'Escape') return;
      if (classifyTarget(e.target).editable) return;
      const target = e.target as HTMLElement | null;
      if (typeof target?.closest === 'function' && target.closest('[role="dialog"]') !== null) {
        return; // a modal owns Escape (the drawer/shortcuts close themselves)
      }
      if (dragRef.current?.dragging || armedRef.current) {
        // Esc exits the tool outright: an in-progress drag is discarded and a
        // settled rectangle is cleared.
        armedRef.current = false;
        setArmed(false);
        clearAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pointAt = useCallback(
    (clientX: number, clientY: number): { col: number; row: number; px: { x: number; y: number } } | null => {
      const host = containerRef.current;
      if (host === null) return null;
      const r = host.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;
      // A supplied mapping is authoritative: its null ("cannot be placed yet",
      // e.g. no renderer) means no point, never a fallback to raw CSS pixels read
      // as grid coordinates. Only an ABSENT mapping uses the identity.
      // A map without fromChart cannot place a point either: it is not the identity.
      const p = map === undefined ? IDENTITY.fromChart(x, y) : map.fromChart?.(x, y) ?? null;
      if (p === null || !Number.isFinite(p.col) || !Number.isFinite(p.row)) return null;
      const px = map?.toChart ? map.toChart(p.col, p.row) : IDENTITY.toChart(p.col, p.row);
      return { col: p.col, row: p.row, px };
    },
    [containerRef, map],
  );

  /** Put the keyboard cursor on a data-space cell and move an open measurement's end there. */
  const placeKeyCursor = useCallback(
    (col: number, row: number): KeyCursor => {
      const px = map?.toChart ? map.toChart(col, row) : IDENTITY.toChart(col, row);
      const next: KeyCursor = { col, row, px };
      cursorRef.current = next;
      setCursor(next);
      const st = dragRef.current;
      if (st?.dragging) {
        st.end = { col, row };
        st.px.end = px;
        setRect({ ...st.px });
        setReadout({ ...st });
      }
      return next;
    },
    [map],
  );

  /** The cursor starts at the middle of the chart the first time a key moves it. */
  const ensureKeyCursor = useCallback((): KeyCursor | null => {
    if (cursorRef.current !== null) return cursorRef.current;
    const host = containerRef.current;
    if (host === null) return null;
    const r = host.getBoundingClientRect();
    const mid = pointAt(r.left + r.width / 2, r.top + r.height / 2);
    if (mid === null) return null;
    return placeKeyCursor(mid.col, mid.row);
  }, [containerRef, pointAt, placeKeyCursor]);

  /** Enter sets the first corner, then the opposite corner; the next Enter starts a new measurement. */
  const pressEnterAtCursor = useCallback((): void => {
    const here = ensureKeyCursor();
    if (here === null) return;
    const st = dragRef.current;
    if (st?.dragging) {
      st.end = { col: here.col, row: here.row };
      st.px.end = here.px;
      st.dragging = false;
      setRect({ ...st.px });
      setReadout({ ...st });
      setNotice('done');
      return;
    }
    const started: DragState = {
      anchor: { col: here.col, row: here.row },
      end: { col: here.col, row: here.row },
      px: { anchor: here.px, end: here.px },
      dragging: true,
    };
    dragRef.current = started;
    setRect(started.px);
    setReadout(started);
    setNotice('start');
  }, [ensureKeyCursor]);

  // Keyboard: arrows move the cursor and Enter sets corners. The listener runs in
  // the capture phase, so while the tool is armed on the chart the arrows drive the
  // measurement and do not also pan the chart through the canvas key handler.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent): void => {
    if (!armedRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
    if (classifyTarget(e.target).editable || !isChartKeyTarget(e.target)) return;
    const step = ARROW_STEP[e.key];
    if (step !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      const here = ensureKeyCursor();
      if (here === null) return;
      const k = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
      placeKeyCursor(here.col + step.dCol * k, here.row + step.dRow * k);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      pressEnterAtCursor();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // A drag sample still queued for the next frame must not land after unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!armed || e.button !== 0) return;
    const p = pointAt(e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const st: DragState = {
      anchor: { col: p.col, row: p.row },
      end: { col: p.col, row: p.row },
      px: { anchor: p.px, end: p.px },
      dragging: true,
    };
    dragRef.current = st;
    setRect(st.px);
    setReadout(st);
    setNotice(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    if (rafRef.current) return; // coalesce to ≤ one sample per frame
    const { clientX, clientY } = e;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const cur = dragRef.current;
      if (!cur?.dragging) return;
      const p = pointAt(clientX, clientY);
      if (p === null) return;
      cur.end = { col: p.col, row: p.row };
      cur.px.end = p.px;
      setRect({ ...cur.px });
      setReadout({ ...cur });
    });
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    st.dragging = false;
    setReadout({ ...st });
    setNotice('done');
    // The rectangle stays on the chart until the next click (or Esc).
  };

  // Geometry for the readout (epoch scale, dt, book depth) — all from the stores.
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const epochs = useFlowMapStore((s) => s.epochs);
  const capability = useFlowMapStore((s) => s.capability);
  const params = gridEpoch === null ? null : (epochs.get(gridEpoch) ?? null);
  const dtNs = params?.dt_ns ?? null;

  const st = readout;
  const dCol = st ? st.end.col - st.anchor.col : 0;
  const startPx = priceAtRow(st?.anchor.row ?? Number.NaN, params);
  const endPx = priceAtRow(st?.end.row ?? Number.NaN, params);
  const dPrice = startPx && endPx ? endPx.price - startPx.price : null;
  const dtTime = dtNs !== null && st ? BigInt(Math.round(dCol * dtNs)) : null;
  const book = st ? getSnapshot().book : null;
  const depth =
    st && book !== null
      ? sumDepthInBand(book, Math.min(st.anchor.row, st.end.row), Math.max(st.anchor.row, st.end.row))
      : null;
  const isSynth = depth !== null && depthIsSynthetic(capability, book?.mode ?? null);
  const deltaTimeUnits: DeltaTimeUnits = {
    ns: t('unit.ns'),
    ms: t('unit.ms'),
    s: t('unit.s'),
    m: t('unit.min'),
    h: t('unit.h'),
    d: t('unit.d'),
  };
  const deltaPriceText =
    dPrice === null || !startPx || !endPx
      ? '—'
      : `${fmtDeltaPrice(dPrice, endPx.decimals)} (${fmtDeltaPct(dPrice, startPx.price)})`;
  const deltaTimeText = dtTime === null ? '—' : fmtDeltaTime(dtTime, deltaTimeUnits);

  const statusText =
    notice === 'start'
      ? t('measure.keyStart')
      : notice === 'done' && st
        ? t('measure.keyDone', { delta: deltaPriceText, time: deltaTimeText })
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
      {st && rect && (
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
          <div className="measure__box" data-testid="measure-readout" style={boxStyle(containerRef, rect)}>
            <div className="measure__row">
              <span className="measure__k">{t('measure.deltaPrice')}</span>
              <span className="measure__v" data-testid="measure-dprice">
                {deltaPriceText}
              </span>
            </div>
            <div className="measure__row">
              <span className="measure__k">{t('measure.deltaTime')}</span>
              <span className="measure__v" data-testid="measure-dtime">
                {deltaTimeText}
              </span>
            </div>
            <div className="measure__row">
              <span className="measure__k">{isSynth ? t('measure.vol') : t('measure.depth')}</span>
              <span className="measure__v" data-testid="measure-ddepth">
                {depth === null ? (
                  '—'
                ) : isSynth ? (
                  formatSizeReadout(depth.bid)
                ) : (
                  <>
                    <span className="measure__bid">{formatSizeReadout(depth.bid)}</span>
                    {' · '}
                    <span className="measure__ask">
                      {depth.ask === null ? '—' : formatSizeReadout(depth.ask)}
                    </span>
                  </>
                )}
              </span>
            </div>
            {startPx && endPx && (
              <div className="measure__row measure__row--dim" data-testid="measure-endpoints">
                <span className="measure__k">{t('measure.endpoints')}</span>
                <span className="measure__v">
                  {formatPrice(startPx.price, startPx.decimals)} → {formatPrice(endPx.price, endPx.decimals)}
                </span>
              </div>
            )}
          </div>
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

/** Place the readout box beside the rectangle, flipping away from the near edges. */
function boxStyle(
  containerRef: RefObject<HTMLElement | null>,
  rect: Rect,
): React.CSSProperties {
  const w = containerRef.current?.clientWidth ?? 0;
  const h = containerRef.current?.clientHeight ?? 0;
  const right = Math.max(rect.anchor.x, rect.end.x);
  const bottom = Math.max(rect.anchor.y, rect.end.y);
  const flipX = right > w - 170;
  const flipY = bottom > h - 96;
  return flipX || flipY
    ? {
        right: flipX ? `${w - Math.min(rect.anchor.x, rect.end.x) + 10}px` : undefined,
        bottom: flipY ? `${h - Math.min(rect.anchor.y, rect.end.y) + 10}px` : undefined,
      }
    : { left: `${right + 10}px`, top: `${bottom + 10}px` };
}
