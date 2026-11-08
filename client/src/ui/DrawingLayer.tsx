/**
 * DrawingLayer — a 2D-canvas overlay that carries the chart's drawing
 * annotations above the GL heatmap, mapped through the renderer's contracts.
 *
 * MAPPING — the SAME contract as MeasureTool: App passes
 * `chartMap={rendererChartMap(rendererRef)}` (ChartMapPair:
 * container px ⇄ fractional grid col/row). This component converts between
 * that GRID space and true DATA space (time-ns, price) using
 *   - `getTimeBase`  → the renderer's column⇄time anchor
 *     (`rendererRef.current?.timeline()?.timeBase ?? null`), and
 *   - the epoch's price scale straight from `state/store`
 *     (gl/priceScale accessors — hybrid-scale safe),
 * so anchors are stored as {tNs, price} and survive pan / zoom / replay seek
 * / reload (see drawings/types.ts for why). With BOTH mappings absent the
 * layer degenerates to the identity map and still works standalone in tests.
 *
 * POINTER POLICY — the layer is `pointer-events: none` unless a tool is
 * ARMED; while armed it takes the pointer for placement (drag = draw, or
 * click-click). In select mode the layer itself stays transparent to the
 * pointer (chart gestures own the canvas); DrawingLayer listens on the
 * CONTAINER instead and only intercepts a pointerdown that actually HITS a
 * drawing (hit-test first, then stopPropagation) — so panning never fights
 * the annotations, and dragging a drawing (body = move, handle = resize)
 * works without arming anything.
 *
 * KEYBOARD (scoped — documented for App; nothing is hijacked globally):
 *   - Esc                 cancel draft → disarm tool → deselect (guarded
 *                         against editable targets + open dialogs, like
 *                         MeasureTool; never fires while the text editor is
 *                         open — the input owns Escape);
 *   - Delete / Backspace  remove the SELECTED drawing (only while the layer
 *                         has focus or a drawing is selected);
 *   - Ctrl/Cmd+Z          undo; Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo (same
 *                         scope guard).
 * App may register `D` (toolbar toggle) in input/keys.ts via
 * `toggleDrawToolbar()` from drawings/store — DrawToolbar already self-
 * listens, so do NOT bind it in both places.
 *
 * The paint loop, the select-mode gestures and the keyboard bindings live in
 * DrawingLayerHooks; the projection in DrawingLayerProjection; the text editor
 * in DrawingLayerEditor. This file owns the React state and the armed-placement
 * pointer handlers.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useFlowMapStore } from '../state/store';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import { useT } from '../i18n/useT';
import { toast } from './Toaster';
import type { DrawingTool } from '../drawings/types';
import type { ChartMapPair } from './MeasureTool';
import { DrawingTextEditor } from './DrawingLayerEditor';
import {
  createLayerRefs,
  dataAtOf,
  handlePlacementKey,
  localXYOf,
  useDrawingShortcuts,
  usePaintLoop,
  useSelectMode,
} from './DrawingLayerHooks';
import type { TimeBaseLike } from './DrawingLayerProjection';
import '../drawings/drawings.css';

export { makeProjection, type TimeBaseLike } from './DrawingLayerProjection';

/** Toolbar chip text per armed tool (catalogue keys, drawings.tool.*). */
const TOOL_LABEL_KEY: Record<DrawingTool, string> = {
  trendline: 'drawings.tool.trendline',
  hline: 'drawings.tool.hline',
  hray: 'drawings.tool.hray',
  rect: 'drawings.tool.rect',
  fib: 'drawings.tool.fib',
  text: 'drawings.tool.text',
};

interface DrawingLayerProps {
  /** The chart container (position:relative) this overlay is anchored to. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Container px ⇄ grid space — the SAME contract as MeasureTool. App passes
   * `rendererChartMap(rendererRef)`; default is the identity map (standalone
   * tests / stories).
   */
  chartMap?: ChartMapPair;
  /** Persistence scope: drawings are stored per market:symbol. */
  symbol: string;
  /** Market half of the scope; defaults to the store subscription's market. */
  market?: string;
  /**
   * The renderer's column⇄time anchor, re-read every frame. App passes
   * `() => rendererRef.current?.timeline()?.timeBase ?? null`.
   */
  getTimeBase?: () => TimeBaseLike | null;
}

export function DrawingLayer({
  containerRef,
  chartMap,
  symbol,
  market,
  getTimeBase,
}: DrawingLayerProps): JSX.Element {
  const [refs] = useState(() => createLayerRefs({ containerRef, chartMap, getTimeBase }));
  refs.props.current = { containerRef, chartMap, getTimeBase };

  // --- reactive slices (low-frequency: tool, editor, mode chip) ---------------
  const tool = useDrawingsStore((s) => s.tool);
  const draftLen = useDrawingsStore((s) => s.draftPoints.length);
  const editingTextId = useDrawingsStore((s) => s.editingTextId);
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const [focused, setFocused] = useState(false);

  // A placement refused at the per-symbol limit says so once per try.
  const t = useT();
  const limitRefusals = useDrawingsStore((s) => s.limitRefusals);
  const refusalsSeen = useRef(limitRefusals);
  useEffect(() => {
    if (limitRefusals === refusalsSeen.current) return;
    refusalsSeen.current = limitRefusals;
    toast(t('drawings.limitReached'), { kind: 'warn' });
  }, [limitRefusals, t]);

  // Scope: follow the passed symbol (App passes the active chart's symbol).
  const sub = useFlowMapStore((s) => s.subscription);
  const scopeMarket = market ?? sub?.market ?? 'na';
  useEffect(() => {
    useDrawingsStore.getState().setScope(scopeMarket, symbol);
  }, [scopeMarket, symbol]);

  // Any store mutation repaints the next frame.
  useEffect(() => {
    const unsub = useDrawingsStore.subscribe(() => {
      refs.dirty.current = true;
    });
    return unsub;
  }, [refs]);

  usePaintLoop(refs);
  useSelectMode(refs);
  useDrawingShortcuts(refs, focused);

  // --- armed placement (overlay pointer events) -------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const ds = useDrawingsStore.getState();
    if (ds.tool === null || e.button !== 0) return;
    const p = dataAtOf(refs, e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const draftLenNow = ds.draftPoints.length;
    const created = ds.addDraftPoint(p);
    if (created !== null) {
      refs.cursor.current = null; // finalized (arity-1 tool or completing click)
      return;
    }
    if (draftLenNow === 0) {
      // First anchor of a two-point tool: track the press for drag-vs-click.
      const local = localXYOf(refs, e.clientX, e.clientY);
      if (local !== null) {
        refs.placing.current = { startX: local.x, startY: local.y, moved: false };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (useDrawingsStore.getState().tool === null) return;
    const p = dataAtOf(refs, e.clientX, e.clientY);
    if (p === null) return;
    refs.cursor.current = p;
    const placing = refs.placing.current;
    if (placing !== null) {
      const local = localXYOf(refs, e.clientX, e.clientY);
      if (local !== null) {
        const dx = local.x - placing.startX;
        const dy = local.y - placing.startY;
        if (dx * dx + dy * dy > 16) placing.moved = true; // > 4 px = a drag
      }
    }
    refs.dirty.current = true;
  };

  const finishPlacement = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const placing = refs.placing.current;
    refs.placing.current = null;
    if (placing === null) return;
    if (!placing.moved) return; // click-click mode: keep the draft for click 2
    const p = refs.cursor.current;
    if (p !== null) useDrawingsStore.getState().addDraftPoint(p);
    refs.cursor.current = null;
  };

  // Double-click opens the text editor for an existing text label.
  const onDoubleClick = (): void => {
    // The preceding pointerdown already selected the drawing under the cursor.
    const ds = useDrawingsStore.getState();
    const d = ds.items.find((x) => x.id === ds.selectedId);
    if (d !== undefined && d.tool === 'text') ds.editText(d.id);
  };

  // --- inline text editor ------------------------------------------------------

  const editing = useMemo(() => {
    if (editingTextId === null) return null;
    const d = useDrawingsStore.getState().items.find((x) => x.id === editingTextId);
    if (d === undefined || d.tool !== 'text') return null;
    return d;
  }, [editingTextId]);
  const armed = tool !== null;
  const cls = `draw-layer${armed ? ' is-armed' : ''}${focused ? ' has-focus' : ''}`;

  return (
    <div
      ref={refs.wrapper}
      className={cls}
      data-testid="drawing-layer"
      // A tab stop only while it has something to act on (a tool armed or a
      // drawing selected); an idle layer is no longer an invisible focus trap.
      tabIndex={armed || selectedId !== null ? 0 : -1}
      role="application"
      aria-label={t('drawings.layerAria')}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPlacement}
      onPointerCancel={finishPlacement}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => handlePlacementKey(refs, e)}
    >
      <canvas ref={refs.canvas} className="draw-layer__canvas" />
      {editing !== null && <DrawingTextEditor editing={editing} editorRef={refs.editor} />}
      {/* Always mounted: a live region must exist before its text changes, or
          screen readers do not announce the armed mode. Idle = visually
          hidden but still in the accessibility tree. */}
      <div
        className={`draw-layer__mode${armed ? '' : ' is-idle'}`}
        data-testid="drawing-mode"
        role="status"
        aria-live="polite"
      >
        {tool === null
          ? ''
          : t('drawings.mode.line', {
              tool: t(TOOL_LABEL_KEY[tool]),
              place: t('drawings.mode.place'),
              second: draftLen > 0 ? t('drawings.mode.second') : '',
              keys: t('drawings.mode.keys'),
            })}
      </div>
    </div>
  );
}

/** Toolbar-visible convenience re-export so App needs only this module's import list. */
export { toggleDrawToolbar };
