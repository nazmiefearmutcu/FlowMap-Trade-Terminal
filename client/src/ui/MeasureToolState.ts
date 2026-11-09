/**
 * The measure tool's interaction state: the armed flag, the pointer drag, the
 * keyboard cursor and the readout geometry. The overlay (MeasureTool.tsx) renders
 * what these hooks hold; the math lives in MeasureMath.ts.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import { classifyTarget, routeGlobalKey } from '../input/keys';
import { useT } from '../i18n/useT';
import { getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { depthIsSynthetic } from './heatLegendModel';
import { fmtDeltaPct, fmtDeltaPrice, fmtDeltaTime, priceAtRow, sumDepthInBand, type DeltaTimeUnits } from './MeasureMath';

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

/** The identity mapping: the component renders standalone in tests and stories. */
const IDENTITY: Required<ChartMapPair> = {
  fromChart: (x, y) => ({ col: x, row: y }),
  toChart: (col, row) => ({ x: col, y: row }),
};

interface DragState {
  /** Anchor point in data space (set on pointerdown). */
  anchor: { col: number; row: number };
  /** Live end point (follows the pointer until release). */
  end: { col: number; row: number };
  /** Anchor + end in container px, frozen at drag start/end for placement. */
  px: { anchor: { x: number; y: number }; end: { x: number; y: number } };
  dragging: boolean;
}

/** A settled or in-progress measurement in container px. */
type Rect = DragState['px'];

/** The keyboard cursor: the data-space cell and its container px. */
interface KeyCursor {
  col: number;
  row: number;
  px: { x: number; y: number };
}

/** Which keyboard corner step was announced last, so the status line says the right thing. */
type KeyNotice = 'start' | 'done' | null;

type Setter<T> = Dispatch<SetStateAction<T>>;

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

/** The chart's mapping of a data-space point to container px (identity when absent). */
function toChartPx(map: ChartMapPair | undefined, col: number, row: number): { x: number; y: number } {
  return map?.toChart ? map.toChart(col, row) : IDENTITY.toChart(col, row);
}

/**
 * A client point as a data-space point, through the mapping. A supplied mapping is
 * authoritative: its null ("cannot be placed yet", e.g. no renderer) means no point,
 * never a fallback to raw CSS pixels read as grid coordinates. Only an ABSENT mapping
 * uses the identity; a map without fromChart cannot place a point either.
 */
function dataPointAt(
  host: HTMLElement | null,
  map: ChartMapPair | undefined,
  clientX: number,
  clientY: number,
): { col: number; row: number; px: { x: number; y: number } } | null {
  if (host === null) return null;
  const r = host.getBoundingClientRect();
  const x = clientX - r.left;
  const y = clientY - r.top;
  const p = map === undefined ? IDENTITY.fromChart(x, y) : (map.fromChart?.(x, y) ?? null);
  if (p === null || !Number.isFinite(p.col) || !Number.isFinite(p.row)) return null;
  return { col: p.col, row: p.row, px: toChartPx(map, p.col, p.row) };
}

export interface MeasureState {
  armed: boolean;
  rect: Rect | null;
  readout: DragState | null;
  cursor: KeyCursor | null;
  notice: KeyNotice;
  setRect: Setter<Rect | null>;
  setReadout: Setter<DragState | null>;
  setCursor: Setter<KeyCursor | null>;
  setNotice: Setter<KeyNotice>;
  dragRef: MutableRefObject<DragState | null>;
  cursorRef: MutableRefObject<KeyCursor | null>;
  armedRef: MutableRefObject<boolean>;
  rafRef: MutableRefObject<number>;
}

/**
 * The armed flag, the drag and the keyboard cursor. `M` arms and disarms; Esc
 * cancels (drag → reset to anchor; idle → exit and clear). Guards mirror the app
 * router: never while typing or when a dialog is open.
 */
export function useMeasureState(): MeasureState {
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

  return {
    armed, rect, readout, cursor, notice, setRect, setReadout, setCursor, setNotice,
    dragRef, cursorRef, armedRef, rafRef,
  };
}

/**
 * Keyboard measuring: the arrows move a virtual cursor (Shift moves ten cells) and
 * Enter sets the first corner, then the opposite corner; the next Enter starts a new
 * measurement. The listener is in the capture phase, so while the tool is armed on
 * the chart the arrows drive the measurement and do not also pan the chart.
 */
export function useKeyboardCursor(
  m: MeasureState,
  containerRef: RefObject<HTMLElement | null>,
  map: ChartMapPair | undefined,
): void {
  const { dragRef, cursorRef, armedRef, setCursor, setRect, setReadout, setNotice } = m;

  /** Put the keyboard cursor on a data-space cell and move an open measurement's end there. */
  const placeKeyCursor = useCallback(
    (col: number, row: number): KeyCursor => {
      const px = toChartPx(map, col, row);
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
    [map, cursorRef, dragRef, setCursor, setRect, setReadout],
  );

  /** The cursor starts at the middle of the chart the first time a key moves it. */
  const ensureKeyCursor = useCallback((): KeyCursor | null => {
    if (cursorRef.current !== null) return cursorRef.current;
    const host = containerRef.current;
    if (host === null) return null;
    const r = host.getBoundingClientRect();
    const mid = dataPointAt(host, map, r.left + r.width / 2, r.top + r.height / 2);
    if (mid === null) return null;
    return placeKeyCursor(mid.col, mid.row);
  }, [containerRef, map, cursorRef, placeKeyCursor]);

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
  }, [ensureKeyCursor, dragRef, setRect, setReadout, setNotice]);

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
}

/**
 * The pointer drag: press to anchor, move to extend (coalesced to one sample per
 * frame), release to finish. The rectangle stays on the chart until the next click
 * (or Esc).
 */
export function usePointerMeasure(
  m: MeasureState,
  containerRef: RefObject<HTMLElement | null>,
  map: ChartMapPair | undefined,
): {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  finishDrag: (e: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const { armed, dragRef, rafRef, setRect, setReadout, setNotice } = m;

  // A drag sample still queued for the next frame must not land after unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [rafRef]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!armed || e.button !== 0) return;
    const p = dataPointAt(containerRef.current, map, e.clientX, e.clientY);
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

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    if (rafRef.current) return; // coalesce to ≤ one sample per frame
    const { clientX, clientY } = e;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const cur = dragRef.current;
      if (!cur?.dragging) return;
      const p = dataPointAt(containerRef.current, map, clientX, clientY);
      if (p === null) return;
      cur.end = { col: p.col, row: p.row };
      cur.px.end = p.px;
      setRect({ ...cur.px });
      setReadout({ ...cur });
    });
  };

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    st.dragging = false;
    setReadout({ ...st });
    setNotice('done');
  };

  return { onPointerDown, onPointerMove, finishDrag };
}

/** The readout's numbers for the current measurement, all read from the stores. */
export interface MeasureGeometry {
  deltaPriceText: string;
  deltaTimeText: string;
  depth: { bid: number; ask: number | null } | null;
  isSynth: boolean;
  startPx: { price: number; decimals: number } | null;
  endPx: { price: number; decimals: number } | null;
}

/** Δprice, Δtime and the book depth in the band, from the epoch scale, dt and the shared book. */
export function useMeasureGeometry(st: DragState | null): MeasureGeometry {
  const t = useT();
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const epochs = useFlowMapStore((s) => s.epochs);
  const capability = useFlowMapStore((s) => s.capability);
  const params = gridEpoch === null ? null : (epochs.get(gridEpoch) ?? null);
  const dtNs = params?.dt_ns ?? null;

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
  return { deltaPriceText, deltaTimeText, depth, isSynth, startPx, endPx };
}
