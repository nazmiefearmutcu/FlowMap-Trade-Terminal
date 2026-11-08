/**
 * The drawing layer's behaviour, split out of the component: the per-frame
 * paint loop, the select-mode gestures on the chart container, the layer's
 * scoped keyboard bindings, and the arrow-key placement cursor. The component
 * keeps its React state and the armed-placement pointer handlers.
 *
 * Every piece shares one {@link LayerRefs} bundle. Its refs are created once per
 * component instance and never replaced, so effects keyed on it run exactly once.
 */

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type RefObject } from 'react';

import { classifyTarget } from '../input/keys';
import { hitTestDrawings, paintDraft, paintLayer, type DrawProjection } from '../drawings/painter';
import { flushDrawingsPersist, useDrawingsStore } from '../drawings/store';
import { quoteDecimals } from '../gl/overlays/axisTicks';
import type { ChartPoint } from '../drawings/types';
import { useFlowMapStore } from '../state/store';
import type { ChartMapPair } from './MeasureTool';
import { IDENTITY, clampCursor, makeProjection, type TimeBaseLike } from './DrawingLayerProjection';

/** Internal drag bookkeeping for select-mode moves (body or handle). */
export interface SelectDrag {
  id: string;
  kind: 'body' | 'handle';
  handle: number;
  /** Last pointer position in data space (streamed deltas). */
  last: ChartPoint;
}

/** A press that started a two-point placement: the drag-vs-click decision. */
export interface PlacingPress {
  startX: number;
  startY: number;
  moved: boolean;
}

/** The props the layer reads on every frame or gesture, kept current by the component. */
export interface LayerProps {
  containerRef: RefObject<HTMLElement | null>;
  chartMap?: ChartMapPair;
  getTimeBase?: () => TimeBaseLike | null;
}

/** The layer's mutable state. Refs only: the paint loop and gestures own them between renders. */
export interface LayerRefs {
  props: MutableRefObject<LayerProps>;
  wrapper: MutableRefObject<HTMLDivElement | null>;
  canvas: MutableRefObject<HTMLCanvasElement | null>;
  /** The open text editor, placed by the paint loop. */
  editor: MutableRefObject<HTMLInputElement | null>;
  proj: MutableRefObject<DrawProjection | null>;
  sig: MutableRefObject<string>;
  dirty: MutableRefObject<boolean>;
  raf: MutableRefObject<number>;
  /** Draft ghost cursor (data space) while a two-point tool is dragging. */
  cursor: MutableRefObject<ChartPoint | null>;
  /** Keyboard placement cursor, in layer CSS px (null until the first key). */
  kb: MutableRefObject<{ x: number; y: number } | null>;
  /** Placement-drag state for the armed two-point tools. */
  placing: MutableRefObject<PlacingPress | null>;
  /** Select-mode drag (body translate / anchor resize). */
  selectDrag: MutableRefObject<SelectDrag | null>;
  cleanupWindowDrag: MutableRefObject<(() => void) | null>;
}

/** A fresh, stable ref bundle for one layer instance. */
export function createLayerRefs(initial: LayerProps): LayerRefs {
  return {
    props: { current: initial },
    wrapper: { current: null },
    canvas: { current: null },
    editor: { current: null },
    proj: { current: null },
    sig: { current: '' },
    dirty: { current: true },
    raf: { current: 0 },
    cursor: { current: null },
    kb: { current: null },
    placing: { current: null },
    selectDrag: { current: null },
    cleanupWindowDrag: { current: null },
  };
}

/** CSS-px position of a pointer event relative to the chart container. */
export function localXYOf(refs: LayerRefs, clientX: number, clientY: number): { x: number; y: number } | null {
  const host = refs.props.current.containerRef.current;
  if (host === null) return null;
  const r = host.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

/** Pointer position in data space, or null when the view cannot place it. */
export function dataAtOf(refs: LayerRefs, clientX: number, clientY: number): ChartPoint | null {
  const local = localXYOf(refs, clientX, clientY);
  const wrapper = refs.wrapper.current;
  if (local === null || wrapper === null) return null;
  // Empty layers sleep between interactions. A tool's very first click
  // must use today's epoch/camera, even before the next animation frame.
  const st = useFlowMapStore.getState();
  const params = st.gridEpoch === null ? null : (st.epochs.get(st.gridEpoch) ?? null);
  const proj = makeProjection(refs.props.current.chartMap ?? IDENTITY,
    refs.props.current.getTimeBase?.() ?? null, params,
    Math.max(1, wrapper.clientWidth), Math.max(1, wrapper.clientHeight));
  refs.proj.current = proj;
  if (proj === null) return null;
  const tNs = proj.tNsAt(local.x);
  const price = proj.priceAt(local.y);
  if (tNs === null || price === null || !Number.isFinite(price)) return null;
  return { tNs, price };
}

/**
 * The per-frame paint loop. A camera, anchor, epoch or size change rebuilds the
 * projection; a dirty flag repaints the canvas; a clean empty layer does nothing.
 */
export function usePaintLoop(refs: LayerRefs): void {
  useEffect(() => {
    /** Pin the open text editor to its anchor in the current projection. */
    const positionEditor = (): void => {
      const input = refs.editor.current;
      const proj = refs.proj.current;
      const st = useDrawingsStore.getState();
      if (input === null || proj === null || st.editingTextId === null) return;
      const d = st.items.find((x) => x.id === st.editingTextId);
      if (d === undefined || d.tool !== 'text') return;
      input.style.left = `${proj.xAt(d.points[0].tNs) + 2}px`;
      input.style.top = `${proj.yAt(d.points[0].price) - 11}px`;
    };
    const tick = (): void => {
      refs.raf.current = requestAnimationFrame(tick);
      const canvas = refs.canvas.current;
      const wrapper = refs.wrapper.current;
      if (canvas === null || wrapper === null) return;

      const drawings = useDrawingsStore.getState();
      if (drawings.tool === null && drawings.items.length === 0 && drawings.draftPoints.length === 0 &&
          refs.proj.current !== null && !refs.dirty.current) {
        // Initialize the pointer projection and clear removed drawings on a
        // dirty frame. A clean empty layer needs no per-frame layout/projection.
        return;
      }

      // Frame inputs: time anchor + epoch params + size + DPR.
      const st = useFlowMapStore.getState();
      const params =
        st.gridEpoch === null ? null : (st.epochs.get(st.gridEpoch) ?? null);
      const props = refs.props.current;
      const timeBase = props.getTimeBase?.() ?? null;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const cssW = Math.max(1, wrapper.clientWidth);
      const cssH = Math.max(1, wrapper.clientHeight);
      // Camera probe (two mapped corners), the same trick IndicatorOverlayCanvas
      // uses: the projection closures read the LIVE renderer, but without this
      // probe a zoom/pan changes NO other signature term — the layer would keep
      // painting drawings at their pre-gesture pixels until some store mutation
      // happened to set the dirty flag (drawings must move with zoom).
      const probeTo = props.chartMap?.toChart ?? IDENTITY.toChart;
      const p0 = probeTo(0, 0);
      const p1 = probeTo(1000, 1000);
      const sig = `${timeBase?.anchorSeq}|${timeBase?.anchorT0Ns}|${timeBase?.dtNs}|${params?.epoch}|${cssW}x${cssH}|${dpr}|${p0.x},${p0.y},${p1.x},${p1.y}`;

      if (sig !== refs.sig.current) {
        refs.sig.current = sig;
        refs.proj.current = makeProjection(
          props.chartMap ?? IDENTITY,
          timeBase,
          params,
          cssW,
          cssH,
        );
        refs.dirty.current = true;
        const dw = Math.max(1, Math.round(cssW * dpr));
        const dh = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== dw || canvas.height !== dh) {
          canvas.width = dw;
          canvas.height = dh;
        }
      }
      if (!refs.dirty.current) return;
      refs.dirty.current = false;
      positionEditor();

      const proj = refs.proj.current;
      const ctx = canvas.getContext('2d');
      if (proj === null || ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const ds = useDrawingsStore.getState();
      const priceDecimals = params === null ? undefined : quoteDecimals(params.tick);
      paintLayer(ctx, ds.items, proj, {
        width: cssW,
        height: cssH,
        selectedId: ds.selectedId,
        priceDecimals,
      });
      if (ds.tool !== null && ds.draftPoints.length > 0) {
        paintDraft(ctx, ds.tool, ds.draftPoints, refs.cursor.current, proj, {
          width: cssW,
          height: cssH,
          selectedColor: ds.defaultStyle.color,
          draftWidth: ds.defaultStyle.width,
        });
      }
    };
    refs.raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(refs.raf.current);
      refs.cleanupWindowDrag.current?.();
    };
  }, [refs]);
}

/**
 * Select mode: the layer is transparent to the pointer, so the container listens
 * instead and takes only a press that HITS a drawing (hit-test first, then
 * stopPropagation). Panning and empty-space clicks reach the chart untouched.
 */
export function useSelectMode(refs: LayerRefs): void {
  useEffect(() => {
    const host = refs.props.current.containerRef.current;
    if (host === null) return undefined;

    const endDrag = (): void => {
      refs.selectDrag.current = null;
      if (refs.cleanupWindowDrag.current) {
        refs.cleanupWindowDrag.current();
        refs.cleanupWindowDrag.current = null;
      }
    };

    const onData = (clientX: number, clientY: number): ChartPoint | null => {
      const local = localXYOf(refs, clientX, clientY);
      const proj = refs.proj.current;
      if (local === null || proj === null) return null;
      const tNs = proj.tNsAt(local.x);
      const price = proj.priceAt(local.y);
      if (tNs === null || price === null || !Number.isFinite(price)) return null;
      return { tNs, price };
    };

    const onDown = (e: PointerEvent): void => {
      const ds = useDrawingsStore.getState();
      if (ds.tool !== null || e.button !== 0) return; // armed overlay owns input
      const local = localXYOf(refs, e.clientX, e.clientY);
      const proj = refs.proj.current;
      if (local === null || proj === null) return;
      const hit = hitTestDrawings(ds.items, local.x, local.y, proj);
      if (hit === null) {
        if (ds.selectedId !== null) ds.select(null); // empty click deselects
        return; // let the canvas gestures have it
      }
      e.preventDefault();
      e.stopPropagation();
      ds.select(hit.id);
      const p = onData(e.clientX, e.clientY);
      if (p === null) return;
      ds.pushUndo(); // one undo step per gesture
      refs.selectDrag.current = { id: hit.id, kind: hit.kind, handle: hit.handle, last: p };
      const onUp = (): void => {
        endDrag();
        flushDrawingsPersist(); // the drag's one write
      };
      const onMove = (ev: PointerEvent): void => {
        const drag = refs.selectDrag.current;
        const st = useDrawingsStore.getState();
        if (drag === null) return;
        const cur = onData(ev.clientX, ev.clientY);
        if (cur === null) return;
        if (drag.kind === 'handle') {
          st.moveAnchor(drag.id, drag.handle, cur);
        } else {
          const dtNs = cur.tNs - drag.last.tNs;
          const dPrice = cur.price - drag.last.price;
          if (dtNs !== 0n || dPrice !== 0) st.moveBy(drag.id, dtNs, dPrice);
        }
        drag.last = cur;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      refs.cleanupWindowDrag.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
    };

    // Hover affordance: cursor over a drawing, else hands the chart back.
    const onHover = (e: PointerEvent): void => {
      if (refs.selectDrag.current !== null) return;
      const ds = useDrawingsStore.getState();
      if (ds.tool !== null || ds.items.length === 0) {
        host.style.cursor = '';
        return;
      }
      const local = localXYOf(refs, e.clientX, e.clientY);
      const proj = refs.proj.current;
      if (local === null || proj === null) return;
      host.style.cursor = hitTestDrawings(ds.items, local.x, local.y, proj) !== null ? 'pointer' : '';
    };

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onHover);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onHover);
      endDrag();
    };
  }, [refs]);
}

/**
 * Window-level drawing keys, scoped to the layer (see the component's module
 * doc): Esc unwinds draft, then tool, then selection; Delete/Backspace removes
 * the selection; Ctrl/⌘+Z undoes, and Ctrl/⌘+Shift+Z or Ctrl/⌘+Y redoes.
 */
export function useDrawingShortcuts(refs: LayerRefs, focused: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = classifyTarget(e.target);
      if (target.editable || target.dialog) return;
      const ds = useDrawingsStore.getState();
      const engaged =
        focused ||
        ds.selectedId !== null ||
        (ds.tool !== null && ds.draftPoints.length > 0);
      if (e.key === 'Escape') {
        if (ds.editingTextId !== null) return; // the text input owns Escape
        if (ds.draftPoints.length > 0) {
          e.preventDefault();
          ds.cancelDraft();
          refs.cursor.current = null;
          return;
        }
        if (ds.tool !== null) {
          e.preventDefault();
          ds.armTool(null);
          return;
        }
        if (ds.selectedId !== null && focused) {
          e.preventDefault();
          ds.select(null);
        }
        return;
      }
      if (!engaged) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ds.selectedId !== null) {
        e.preventDefault();
        ds.remove(ds.selectedId);
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        ds.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        ds.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, refs]);
}

/**
 * Keyboard placement: while a tool is armed and the layer itself has focus, the
 * arrow keys move a placement cursor (Shift = 40 px) and Enter places a point
 * there, exactly as a click would. Child controls (the text editor) keep their
 * own keys because only keys aimed at the layer count.
 */
export function handlePlacementKey(refs: LayerRefs, e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (e.target !== e.currentTarget) return;
  const ds = useDrawingsStore.getState();
  if (ds.tool === null) {
    refs.kb.current = null;
    return;
  }
  const wrapper = refs.wrapper.current;
  if (wrapper === null) return;
  const cw = wrapper.clientWidth;
  const ch = wrapper.clientHeight;
  const cur = refs.kb.current ?? { x: cw / 2, y: ch / 2 };
  const step = e.shiftKey ? 40 : 8;
  let next: { x: number; y: number } | null = null;
  if (e.key === 'ArrowLeft') next = { x: cur.x - step, y: cur.y };
  else if (e.key === 'ArrowRight') next = { x: cur.x + step, y: cur.y };
  else if (e.key === 'ArrowUp') next = { x: cur.x, y: cur.y - step };
  else if (e.key === 'ArrowDown') next = { x: cur.x, y: cur.y + step };
  if (next !== null) {
    e.preventDefault();
    refs.kb.current = { x: clampCursor(next.x, cw), y: clampCursor(next.y, ch) };
    const r = wrapper.getBoundingClientRect();
    refs.cursor.current = dataAtOf(refs, r.left + refs.kb.current.x, r.top + refs.kb.current.y);
    refs.dirty.current = true;
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const r = wrapper.getBoundingClientRect();
    const p = dataAtOf(refs, r.left + cur.x, r.top + cur.y);
    if (p === null) return;
    refs.kb.current = cur;
    const created = ds.addDraftPoint(p);
    refs.cursor.current = created === null ? p : null;
    refs.dirty.current = true;
  }
}
