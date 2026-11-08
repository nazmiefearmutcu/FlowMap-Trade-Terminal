/**
 * IndicatorOverlayCanvas — draws the ACTIVE indicators.
 *
 * One 2D canvas riding the chart stack inside a positioned host (the parent is
 * `position:relative`), `pointer-events:none`, so
 * pan/zoom/crosshair gestures are untouched. Two visual zones:
 *
 *  - OVERLAY pane (SMA / EMA / VWAP / Bollinger): polylines mapped through the
 *    SAME price scale and camera as the heatmap, via the injected
 *    {@link ChartMapPair} (the MeasureTool contract — App passes the identical
 *    `rendererChartMap(rendererRef)` pair it already builds for MeasureTool;
 *    the DEFAULT is the identity map so the canvas renders standalone).
 *  - SUB pane (RSI / MACD / ATR / OBV): a translucent strip pinned to the
 *    BOTTOM of the canvas with its own per-lane y-scale, a zero line for
 *    histograms, and text labels. Height is configurable ({@link subPaneHeight}).
 *
 * Data path: candles from candles/store (live + replayed trades), indicator
 * math from streaming kernels (indicators/kernels) — O(1) per candle push. The
 * closed-candle history is fed once into per-instance value rings and each
 * repaint only PEEKS the forming candle. Repaints follow the CvdPane pattern:
 * a cheap signature (size, DPR, candle version, active list, epoch, camera
 * probe) gates the paint and an idle backoff stops the rAF spin.
 */

import { useEffect, useRef } from 'react';

import { getSnapshot, subscribe, type CandleSnapshot } from '../candles/store';
import { scaleFromEpoch } from '../gl/priceScale';
import { slotTsToCol, type TimeMap } from '../gl/overlays/coords';
import {
  SLOT_CAP,
  feedNew as feedInstances,
  needsRebuild,
  peekForming as peekInstances,
  rebuildAll as rebuildInstances,
} from '../indicators/feed';
import { defById, type OutputSpec } from '../indicators/registry';
import type { IndicatorKernel } from '../indicators/kernels/types';
import { useIndicatorStore } from '../indicators/store';
import { useFlowMapStore } from '../state/store';
import type { ChartMapPair } from './MeasureTool';
import {
  paintOverlayLines,
  paintSubPanes,
  type InstanceState,
  type PaintFrame,
} from './IndicatorOverlayCanvasPaint';
import '../indicators/indicators.css';

/**
 * Literal fallbacks when a --indi-cN var is not resolvable (tests, exotic hosts).
 * Mirrors the midnight block of theme/themes.css, the default theme.
 */
export const FALLBACK_COLORS: Readonly<Record<string, string>> = {
  '--indi-c1': '#4cc2b5',
  '--indi-c2': '#e0a94e',
  '--indi-c3': '#9a86e8',
  '--indi-c4': '#5aa2e0',
  '--indi-c5': '#e8635f',
  '--indi-c6': '#67c96a',
};

/** Last-resort series colour for a token that is neither resolvable nor listed. */
const UNKNOWN_SERIES = '#8ea0b5';

/** The literal fallback for a series token. */
export function fallbackSeriesColor(colorVar: string): string {
  return FALLBACK_COLORS[colorVar] ?? UNKNOWN_SERIES;
}

const IDENTITY_TO = (col: number, row: number): { x: number; y: number } => ({ x: col, y: row });

export interface IndicatorOverlayCanvasProps {
  /**
   * Container px ⇄ data space. App passes the same `rendererChartMap(rendererRef)`
   * pair the other chart overlays use; defaults to the identity map.
   */
  chartMap?: ChartMapPair;
  /**
   * The renderer column-time map (renderer.timeline() timeBase). When it carries
   * piecewise slots (reconstructed history), candles are placed through them, the
   * same way the heatmap and markers are. Absent: the candle store affine is used.
   */
  getTimeBase?: () => TimeMap | null;
  /** Sub-pane strip height in CSS px (clamped to ≥ 40). Default 96. */
  subPaneHeight?: number;
}

/**
 * Identity of a column⇄time map for the paint signature. The
 * anchor alone cannot see a slot table: when reconstructed history adds or
 * re-indexes slots, the candles move without any camera or snapshot change, so
 * the signature must carry the table's shape and its end knots too.
 */
export function timeMapSig(tm: TimeMap | null): string {
  if (tm === null) return 'tm0';
  const base = `${tm.anchorSeq}:${tm.anchorT0Ns}:${tm.dtNs}`;
  const s = tm.slots;
  if (s === undefined || s.t0.length === 0) return base;
  const n = s.t0.length;
  return `${base}|s${s.startSeq}:${s.stride ?? 1}:${n}:${s.cols?.length ?? 0}:${s.t0[0]}:${s.t0[n - 1]}`;
}

export function IndicatorOverlayCanvas({
  chartMap,
  getTimeBase,
  subPaneHeight = 96,
}: IndicatorOverlayCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<ChartMapPair | undefined>(chartMap);
  mapRef.current = chartMap;
  const timeRef = useRef(getTimeBase);
  timeRef.current = getTimeBase;
  const stripRef = useRef(Math.max(40, Math.round(subPaneHeight)));
  stripRef.current = Math.max(40, Math.round(subPaneHeight));
  const hasActive = useIndicatorStore((s) => s.active.length > 0);

  // Keep the indicator store pointed at the CURRENT symbol: the active list is
  // per-symbol persisted (`flowmap.indicators.<symbol>`), so a symbol switch
  // must swap it. Effect-scoped vanilla subscription (no re-render — the draw
  // loop reads the store imperatively; `active.length` drives only visibility).
  const subscription = useFlowMapStore((s) => s.subscription);
  useEffect(() => {
    useIndicatorStore.getState().syncSymbol(subscription?.symbol ?? null);
  }, [subscription]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Keep-alive subscriber: the candles store wires its `onStream` feed and
    // session watcher lazily on its FIRST subscriber, and this canvas is the
    // only production consumer (it polls `getSnapshot()` — it never needs the
    // change callbacks). Without this the synth never sees a trade and every
    // indicator draws nothing (the wiring gap this subscription closes).
    const unsubCandles = subscribe(() => {});

    const instances = new Map<string, InstanceState>();
    let lastSig = '';
    let emptyCleared = false;
    let lastActiveSig = '';
    let snapVersion = -1;
    let cachedSnap: CandleSnapshot | null = null;
    let raf = 0;
    let pollTimer = 0;
    let idleStep = 0;
    const IDLE_MAX_MS = 250;

    const scheduleNext = (painted: boolean): void => {
      idleStep = painted ? 0 : Math.min(idleStep + 1, 8);
      const maxWait = useFlowMapStore.getState().subscription?.mode === 'live' ? 16 : IDLE_MAX_MS;
      const wait = painted ? 0 : Math.min(maxWait, 2 ** idleStep);
      if (wait === 0) raf = requestAnimationFrame(draw);
      else pollTimer = window.setTimeout(() => { raf = requestAnimationFrame(draw); }, wait);
    };

    // --- kernel instance management -------------------------------------------

    const makeInstance = (
      uid: string,
      defId: string,
      params: Record<string, number>,
      paramsSig: string,
    ): InstanceState | null => {
      const def = defById(defId);
      if (def === null) return null;
      let kernel: IndicatorKernel;
      try {
        kernel = def.create(params);
      } catch {
        return null; // unclappable param combo (e.g. MACD fast>=slow): draw nothing
      }
      const rings = def.outputs.map(() => new Float64Array(SLOT_CAP).fill(Number.NaN));
      return { uid, def, kernel, rings, paramsSig, lastFedBi: -1, lastClose: Number.NaN };
    };

    /** Sync the instance map to the active list; rebuilt instances refeed lazily. */
    const syncInstances = (active: readonly { uid: string; defId: string; params: Record<string, number> }[]): void => {
      const seen = new Set<string>();
      for (const a of active) {
        seen.add(a.uid);
        const sig = `${a.defId}|${JSON.stringify(a.params)}`;
        const cur = instances.get(a.uid);
        if (cur !== undefined && cur.paramsSig === sig) continue;
        instances.set(a.uid, makeInstance(a.uid, a.defId, a.params, sig) ?? {
          uid: a.uid,
          def: defById('sma')!,
          kernel: { outputKeys: ['x'], push: () => [null], peek: () => [null], reset: () => {} },
          rings: [new Float64Array(SLOT_CAP).fill(Number.NaN)],
          paramsSig: sig,
          lastFedBi: Number.MAX_SAFE_INTEGER, // broken entry: never fed, never drawn
          lastClose: Number.NaN,
        });
      }
      for (const uid of [...instances.keys()]) {
        if (!seen.has(uid)) instances.delete(uid);
      }
      snapVersion = -1; // force a feed pass so fresh instances load history
    };

    // --- feeding the kernels ----------------------------------------------------

    // The feed rules live in indicators/feed.ts (pure, unit-tested). These bind
    // them to this canvas's instance map.
    const feedNew = (snap: CandleSnapshot): void => feedInstances(instances.values(), snap);
    const rebuildAll = (snap: CandleSnapshot): void => rebuildInstances(instances.values(), snap);
    const peekForming = (snap: CandleSnapshot): void => peekInstances(instances.values(), snap);

    // --- drawing ----------------------------------------------------------------

    let styleEl: CSSStyleDeclaration | null = null;
    const resolveColor = (out: OutputSpec, override: string | null | undefined): string => {
      if (override !== null && override !== undefined && override.length > 0) return override;
      if (styleEl === null) styleEl = getComputedStyle(document.documentElement);
      const raw = styleEl.getPropertyValue(out.colorVar).trim();
      if (raw.length > 0) return raw;
      return fallbackSeriesColor(out.colorVar);
    };
    /** Resolve a chart token off <html>; the fallback literal when unavailable. */
    const themedVar = (name: string, fallback: string): string => {
      if (styleEl === null) styleEl = getComputedStyle(document.documentElement);
      const raw = styleEl.getPropertyValue(name).trim();
      return raw.length > 0 ? raw : fallback;
    };

    /**
     * Candle bucket-start time → fractional chart column (NaN when unmappable).
     * Piecewise through the time map's slots when they cover the candle (the same
     * rule the heatmap and markers use), else the affine.
     */
    const candleCol = (t0Ns: bigint, tfNs: number, tm: TimeMap | null): number => {
      if (tm === null) return Number.NaN;
      const mid = t0Ns + BigInt(Math.round(tfNs / 2));
      if (tm.slots !== undefined) {
        const piecewise = slotTsToCol(tm.slots, mid);
        if (piecewise !== null) return piecewise;
      }
      return tm.anchorSeq + Number(mid - tm.anchorT0Ns) / tm.dtNs;
    };

    const paint = (): void => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;
      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const active = useIndicatorStore.getState().active;
      const snap = getSnapshot();
      const cs = snap.candles;
      const tfNs = snap.timeframeNs;
      // Column of every candle, computed once per paint (candleCol is BigInt math
      // and the loops below would otherwise repeat it per output and per lane).
      const timeMap: TimeMap | null = timeRef.current?.() ?? snap.timeMap;
      const colAt = new Float64Array(cs.length);
      for (let i = 0; i < cs.length; i += 1) colAt[i] = candleCol(cs[i].t0Ns, tfNs, timeMap);
      const to = mapRef.current?.toChart ?? IDENTITY_TO;
      const fm = useFlowMapStore.getState();
      const ep = fm.gridEpoch === null ? undefined : fm.epochs.get(fm.gridEpoch);
      const scale = ep === undefined ? null : scaleFromEpoch(ep);

      styleEl = null; // re-resolve theme colors each paint
      // The sub-pane chrome follows the active chart tokens (fallback: the
      // midnight literals) so a light chart is not overlapped by a dark plate.
      const chipBg = themedVar('--chart-chip-bg', 'rgba(8, 11, 17, 0.82)');
      const chipBorder = themedVar('--chart-chip-border', '#1a2030');
      const gridInk = themedVar('--chart-grid', 'rgba(26, 32, 48, 0.55)');
      const inkDim = themedVar('--chart-ink-dim', 'rgba(111, 123, 140, 0.9)');
      const zeroInk = themedVar('--chart-axis', 'rgba(111, 123, 140, 0.35)');
      const titleInk = themedVar('--chart-ink-dim', 'rgba(230, 237, 243, 0.95)');

      const stripH = stripRef.current;
      const subActive = active.filter((a) => instances.get(a.uid)?.def.pane === 'sub');
      const chartBottom = subActive.length > 0 ? cssH - stripH : cssH;

      const lineColors = new Map<string, string>();
      const colorOf = (uid: string, out: OutputSpec): string => {
        const key = `${uid}|${out.key}`;
        let c = lineColors.get(key);
        if (c === undefined) {
          const a = active.find((x) => x.uid === uid);
          c = resolveColor(out, a?.colors[out.key]);
          lineColors.set(key, c);
        }
        return c;
      };

      const frame: PaintFrame = {
        ctx,
        cssW,
        cssH,
        candles: cs,
        colAt,
        to,
        scale,
        active,
        instances,
        colorOf,
        themedVar,
        chrome: { chipBg, chipBorder, gridInk, inkDim, zeroInk, titleInk },
      };
      paintOverlayLines(frame, chartBottom);
      if (subActive.length === 0) return;
      paintSubPanes(frame, subActive, stripH);
    };

    // --- the signature-gated loop (CvdPane pattern) -------------------------------

    const draw = (): void => {
      const store = useIndicatorStore.getState();
      if (store.active.length === 0) {
        if (!emptyCleared) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          syncInstances([]);
          lastActiveSig = '';
          lastSig = '';
          cachedSnap = null;
          snapVersion = -1;
          emptyCleared = true;
        }
        scheduleNext(false);
        return;
      }
      emptyCleared = false;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const activeSig = store.active
        .map((a) => `${a.uid}:${a.defId}:${JSON.stringify(a.params)}:${JSON.stringify(a.colors)}`)
        .join(',');
      if (activeSig !== lastActiveSig) {
        lastActiveSig = activeSig;
        syncInstances(store.active);
      }
      const snap = getSnapshot();
      if (snap.version !== snapVersion) {
        const prev = cachedSnap;
        cachedSnap = snap;
        if (prev !== null && needsRebuild(prev, snap)) rebuildAll(snap);
        else feedNew(snap);
        snapVersion = snap.version;
        peekForming(snap);
      }
      const fm = useFlowMapStore.getState();
      const ep = fm.gridEpoch === null ? undefined : fm.epochs.get(fm.gridEpoch);
      // Camera probe: two mapped corners catch pan, zoom, and scale changes.
      const to = mapRef.current?.toChart ?? IDENTITY_TO;
      const c0 = to(0, 0);
      const c1 = to(1000, 1000);
      // The LIVE time base is part of the signature, not only the snapshot's:
      // paint() resolves it the same way.
      const sig = `${cssW}x${cssH}|${dpr}|${stripRef.current}|${activeSig}|${snap.version}|${
        timeMapSig(timeRef.current?.() ?? snap.timeMap)
      }|${fm.gridEpoch}|${ep ? `${ep.p0}:${ep.rows}:${ep.dt_ns}:${ep.scale_kind ?? 0}` : 'ep0'}|${c0.x},${c0.y},${c1.x},${c1.y}`;
      let painted = false;
      // NOTE the gate is the SIGNATURE, not `active.length > 0`: when the last
      // indicator is removed the signature must still change (empty activeSig),
      // and paint()'s first op is a full clearRect — skipping the empty case
      // would leave the last EMA/RSI line inked on the canvas forever.
      if (cssW !== 0 && cssH !== 0 && sig !== lastSig) {
        lastSig = sig;
        paint();
        painted = true;
      }
      scheduleNext(painted);
    };

    scheduleNext(true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(pollTimer);
      instances.clear();
      unsubCandles();
    };
  }, []);

  return (
    <div className="indi-host" data-testid="indi-overlay" aria-hidden={!hasActive}>
      <canvas ref={canvasRef} className="indi-canvas" aria-hidden="true" />
    </div>
  );
}
