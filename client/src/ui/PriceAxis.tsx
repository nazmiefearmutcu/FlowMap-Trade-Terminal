/**
 * Price axis: the right-hand gutter and its auto-scale control surface.
 *
 * A thin right-hand gutter whose `<canvas>` the {@link Renderer} draws price
 * ticks into every dirty frame (see gl/overlays/axes.ts `drawPriceAxis`). The
 * gutter shares the heatmap viewport's HEIGHT, so a price row maps to the same y
 * in both — the labels stay pinned to the heatmap under pan/zoom. React only owns
 * the chrome + the canvas element; the pixels are painted imperatively by the
 * renderer (no per-frame React re-render, matching the store's high-freq policy).
 *
 * The gutter is also a CONTROL surface, the way it is in TradingView and
 * Bookmap: wheel scales price at the cursor row, a vertical drag scales price
 * about the viewport centre (it does NOT pan — an axis drag stretches the axis),
 * and a double-click restores auto-fit. Those listeners are attached by the
 * renderer in `attachOverlaySurfaces`, so this component stays declarative.
 *
 * The chip on top reports which mode the price axis is in and toggles auto-scale
 * off/on. It is a SIBLING of the canvas, not an overlay on it, so a click lands
 * on the button and never reaches the gesture listeners underneath.
 *
 * Chip truth:
 *   - The label must not claim `TRACK` while tracking cannot act. `track` is
 *     gated by `stepPriceFollow` on the newest column being inside the view, so
 *     when `renderer.liveEdgeVisible === false` the chip reads `TRK·WAIT`
 *     (armed, waiting for the edge) instead of a state that never moves.
 *   - The toggle is routed through the App's `onSetPriceFollow` when provided,
 *     so the persisted `followPrice` setting (and therefore the settings drawer
 *     toggle + the next boot) can never disagree with the camera. Standalone
 *     (no callback) it falls back to driving the renderer directly.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';
import { observeCanvasBox } from '../gl/canvasBox';
import { useT } from '../i18n/useT';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';

/** Poll interval (ms) for the chip's state. Short: the chip must not visibly lag
 *  the gesture that changed it (a wheel over the gutter changes it instantly). */
const POLL_MS = 100;

/** Minimum gap between two gutter rebinds (ms). A rebind re-runs the App's
 *  attach path (fresh TextLayer wrapper + gesture handlers) and re-dirties the
 *  frame, so a persistent box mismatch must not thrash it every poll tick. */
const HEAL_COOLDOWN_MS = 1000;

/** Chip text key per mode (translated; decorative — the accessible name is static, see below). */
const CHIP_KEY: Record<PriceFollow, string> = {
  fit: 'desk.chip.fit',
  track: 'desk.chip.track',
  off: 'desk.chip.lock',
};

/**
 * Heal surface. `overlays` is TS-private on the Renderer, so this is a
 * STANDALONE structural view (casting) rather than an intersection — a
 * `Renderer & { overlays }` intersection collapses to `never` (private member
 * in one constituent, public in the other). `syncGutters` is the manager's
 * public re-match primitive; it stays optional so the heal degrades to a
 * rebind + redirty on a build without it.
 */
type AxisHealView = {
  attachOverlaySurfaces: (price: HTMLCanvasElement | null, time: HTMLCanvasElement | null) => void;
  /**
   * The DPR the renderer last sized its backing stores with.
   * Optional: a build without the getter degrades to the live window ratio.
   */
  readonly dpr?: number;
  overlays?: {
    readonly timeAxis?: { readonly canvas: HTMLCanvasElement } | null;
    syncGutters?: (dpr: number) => boolean;
  } | null;
};

/**
 * The device-pixel ratio the gutter bitmap must match. Reads the renderer's
 * cached ratio so the axis sizes its canvas with the SAME ratio the chart
 * uses; a window-ratio read can disagree after a monitor move until the
 * renderer's next resize.
 */
function gutterDpr(r: AxisHealView): number {
  const cached = r.dpr;
  if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) return cached;
  return window.devicePixelRatio || 1;
}

interface PriceAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: RefObject<Renderer | null>;
  /** Persist and apply a chip-driven mode change through the App (settings
   *  patch semantics). Absent = drive the renderer directly (standalone/tests). */
  onSetPriceFollow?: (mode: PriceFollow) => void;
}

export function PriceAxis({ canvasRef, rendererRef, onSetPriceFollow }: PriceAxisProps): JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<PriceFollow>('fit');
  const [edgeVisible, setEdgeVisible] = useState(true);
  const healedAtRef = useRef(0);
  const boxRef = useRef<ReturnType<typeof observeCanvasBox> | null>(null);

  /**
   * Keep the LIVE canvas bound to the renderer and its backing store
   * matched to the on-screen box — WITHOUT waiting for a window resize.
   *
   * Two failure shapes this closes: (a) a fresh boot whose first frames landed
   * before layout froze the bitmap at the browser default 300×150, leaving the
   * gutter with no tick labels and no last-price pill until something forced a
   * frame; (b) a hot remount replaced the canvas ELEMENT while the App's
   * mount-only `attachOverlaySurfaces` still holds the old (detached) node, so
   * the on-screen canvas never receives another sync. A rebind points the
   * manager at the live element again and re-dirties the renderer; the
   * manager's `syncGutters` re-matches the bitmap immediately, so the next ink
   * lands on the right grid even before the next data-driven frame.
   */
  const healAxis = useCallback((): void => {
    const r = rendererRef.current as unknown as AxisHealView | null;
    const c = canvasRef.current;
    if (r === null || c === null || typeof r.attachOverlaySurfaces !== 'function') return;
    const box = boxRef.current?.size();
    const cw = box?.width ?? 0;
    const ch = box?.height ?? 0;
    if (cw <= 0 || ch <= 0) return; // pre-layout / hidden: nothing to match yet
    const dpr = gutterDpr(r);
    const wantW = Math.max(1, Math.round(cw * dpr));
    const wantH = Math.max(1, Math.round(ch * dpr));
    if (c.width === wantW && c.height === wantH) return; // already in sync
    const now = Date.now();
    if (now - healedAtRef.current < HEAL_COOLDOWN_MS) return;
    healedAtRef.current = now;
    // Rebind (same element → fresh wrapper; replaced element → live again) and
    // redirty through the public attach API, then re-size the 2D backing store
    // immediately (requestAnimationFrame may be starved under CPU load; the
    // bitmap fix must not wait for it).
    const timeCanvas = r.overlays?.timeAxis?.canvas ?? null;
    r.attachOverlaySurfaces(c, timeCanvas);
    r.overlays?.syncGutters?.(dpr);
  }, [canvasRef, rendererRef]);

  // Callback ref: React hands us the element on mount AND on any replacement,
  // and the App-owned RefObject keeps its previous meaning for every other
  // consumer (mount attach, e2e hooks). A replacement heals immediately when
  // the renderer already exists (the detached-node case).
  const bindCanvas = useCallback(
    (el: HTMLCanvasElement | null): void => {
      boxRef.current?.dispose();
      boxRef.current = el ? observeCanvasBox(el) : null;
      (canvasRef as { current: HTMLCanvasElement | null }).current = el;
      if (el !== null && rendererRef.current !== null) healAxis();
    },
    [canvasRef, rendererRef, healAxis],
  );

  useEffect(() => {
    if (canvasRef.current) {
      boxRef.current?.dispose();
      boxRef.current = observeCanvasBox(canvasRef.current);
    }
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      setMode((m) => (m === r.priceFollow ? m : r.priceFollow));
      const edge = r.liveEdgeVisible;
      setEdgeVisible((e) => (e === edge ? e : edge));
      healAxis();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      boxRef.current?.dispose();
      boxRef.current = null;
    };
  }, [canvasRef, rendererRef, healAxis]);

  const onToggle = (): void => {
    const r = rendererRef.current;
    if (!r) return;
    // Enabling restores 'track' (keeps the user's zoom, recentres on drift), NOT
    // 'fit' (which re-frames to the book and discards the scale). Explicit auto-
    // fit stays on the axis double-click / Shift+P.
    const next: PriceFollow = r.priceFollow === 'off' ? 'track' : 'off';
    if (onSetPriceFollow) onSetPriceFollow(next);
    else r.setPriceFollow(next);
    setMode(next); // optimistic; the poll confirms
  };

  const on = mode !== 'off';
  const waiting = mode === 'track' && !edgeVisible;
  const label = waiting ? t('desk.chip.waiting') : t(CHIP_KEY[mode]);
  // The bare P and R keys work only while single-key shortcuts are on; the copy
  // names them only then, and points at the button otherwise.
  const singleKeys = useSingleKeyShortcuts();
  const hint = waiting
    ? t(singleKeys ? 'axis.autoWaiting' : 'axis.autoWaitingNoKey')
    : on
      ? t(singleKeys ? 'axis.autoOn' : 'axis.autoOnNoKey')
      : t(singleKeys ? 'axis.autoOff' : 'axis.autoOffNoKey');
  return (
    <div className="price-axis">
      {/* aria-hidden lives on the CANVAS, not the wrapper: an interactive button
          must never sit inside an aria-hidden subtree. The callback ref keeps
          the App-owned RefObject in sync (see bindCanvas). */}
      <canvas ref={bindCanvas} className="axis-canvas" aria-hidden="true" />
      <button
        type="button"
        className={`axis-auto${on ? ' is-on' : ''}`}
        data-testid="price-auto"
        // The name carries the VISIBLE mode word (the label in the name must
        // contain the visible text). aria-pressed still encodes ON/OFF, so the
        // word names the mode and the pressed state says whether auto-scale is on.
        aria-label={t('axis.autoAria', { mode: label })}
        aria-pressed={on}
        data-edge={waiting ? 'hidden' : 'visible'}
        title={hint}
        onClick={onToggle}
      >
        {label}
      </button>
    </div>
  );
}
