/**
 * Test-only and e2e hooks for the renderer: the deterministic preload scenarios
 * (a synthetic perf history, the normalization scenario and the overlay scenario),
 * the scripted perf runs, forced view framing, the snapshot export and the
 * overlay ingest. Renderer keeps a one-line public delegate for each, so the unit
 * tests and the e2e specs reach them by the same names.
 *
 * Each preload bypasses the network: it releases the live ring objects, installs
 * a fresh ring, heatmap and extents for its fixed geometry, and writes its columns
 * through the real ingest path where the scenario needs the column cache and the
 * time anchor to fill in as they do live.
 */

import { COLS_PER_TILE, TileRing } from '../tileRing';
import { Heatmap } from '../heatmap';
import { RAMP_FLOW } from '../lut';
import { limitsFor, type Camera } from '../camera';
import type { ColumnCache } from '../columnCache';
import { clamp } from '../numeric';
import { fractionRow } from '../priceProjection';
import type { PerfResult } from '../rendererTypes';
import type { StreamMsg } from '../../net/connection';
import { MODE_L2, MsgType, type DepthColumn } from '../../proto/types';
import { columnExtent, type DepthIngest } from './depthIngest';
import type { AxisMap } from './axisMap';
import type { FollowPolicy } from './followPolicy';
import type { FrameState } from './frameState';
import type { FrameLoop } from './frameLoop';
import type { GpuLifecycle } from './gpuLifecycle';
import type { OverlayLayer } from './overlayLayer';
import type { Shading } from './shading';
import type { Viewport } from './viewport';

/** The live modules the hooks drive; Renderer passes the instances it owns. */
export interface TestHooksHost {
  readonly canvas: HTMLCanvasElement;
  readonly gpu: GpuLifecycle;
  readonly camera: Camera;
  readonly frameState: FrameState;
  readonly axis: AxisMap;
  readonly shading: Shading;
  readonly columnCache: ColumnCache;
  readonly overlayLayer: OverlayLayer;
  readonly ingest: DepthIngest;
  readonly follow: FollowPolicy;
  readonly frameLoop: FrameLoop;
  readonly viewport: Viewport;
}

/**
 * The hooks read and drive the collaborators that own each piece of state: `this.ctx`
 * is `this.gpu.ctx`, `this.normalizer` is `this.shading.normalizer`, and so on. The
 * Renderer's delegates keep the public names.
 */
export class TestHooks {
  private readonly canvas: HTMLCanvasElement;
  private readonly gpu: GpuLifecycle;
  private readonly camera: Camera;
  private readonly frameState: FrameState;
  private readonly axis: AxisMap;
  private readonly shading: Shading;
  private readonly columnCache: ColumnCache;
  private readonly overlayLayer: OverlayLayer;
  private readonly ingest: DepthIngest;
  private readonly follow: FollowPolicy;
  private readonly frameLoop: FrameLoop;
  private readonly viewport: Viewport;

  constructor(host: TestHooksHost) {
    this.canvas = host.canvas;
    this.gpu = host.gpu;
    this.camera = host.camera;
    this.frameState = host.frameState;
    this.axis = host.axis;
    this.shading = host.shading;
    this.columnCache = host.columnCache;
    this.overlayLayer = host.overlayLayer;
    this.ingest = host.ingest;
    this.follow = host.follow;
    this.frameLoop = host.frameLoop;
    this.viewport = host.viewport;
  }

  /** Deterministic time pan by `dCols` absolute columns (disables follow, like a
   * drag). Drives the real backfill on the next frame. e2e only. */
  panColumnsForTest(dCols: number): void {
    this.camera.pan(dCols, 0);
    this.follow.onCameraChanged();
  }

  /** Deterministic price zoom (factor>1 = zoom out → coarser mip). e2e only. */
  zoomPriceForTest(factor: number): void {
    this.follow.pendingOverviewFit = false;
    this.follow.preparePriceOverview();
    this.camera.zoomPrice(factor, fractionRow(this.frameState.view, this.camera.priceScale, 0.5));
    this.follow.onCameraChanged();
  }

  /** Deterministic time zoom through the same path as a centered user gesture. */
  zoomTimeForTest(factor: number): void {
    this.viewport.makeController().zoomTimeCentered(factor);
  }

  /**
   * Preload `count` deterministic synthetic columns (wall + noise) straight into
   * a fresh ring sized to hold them at `rows` height — bypassing the network so
   * the perf gate can measure pan/zoom over a real 10 k-column history.
   * Returns the ring geometry + allocation bytes for the memory gate.
   */
  preloadSynthetic(count: number, rows: number): {
    rows: number;
    layers: number;
    capacityCols: number;
    ringBytes: number;
    resident: number;
  } {
    if (rows > this.gpu.ctx.caps.maxTextureSize) {
      throw new Error(`preloadSynthetic: rows ${rows} > MAX_TEXTURE_SIZE ${this.gpu.ctx.caps.maxTextureSize}`);
    }
    // Perf harness bypasses the network — no scroll-back backfill in this mode.
    this.gpu.releaseRingObjects();

    const wantLayers = Math.ceil(count / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.gpu.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.gpu.ctx.gl, rows, layers);
    const heatmap = new Heatmap(this.gpu.ctx, ring, this.gpu.lut);
    this.gpu.ring = ring;
    this.gpu.heatmap = heatmap;
    heatmap.normalizer = this.shading.normalizer;
    heatmap.levelFloor = this.shading.tickGroupingLevel();
    heatmap.pixel = this.shading.getChartStyle() === 'pixel';
    heatmap.dpr = this.viewport.devicePixelRatio;
    const cap = ring.capacityCols;
    this.gpu.extents.allocate(cap);
    this.axis.slots.allocate(cap);
    this.camera.setLimits(limitsFor(rows, cap));

    this.ingest.partialGate.clear();
    const bid = new Float32Array(rows);
    const ask = new Float32Array(rows);
    const n = Math.min(count, cap);
    for (let s = 0; s < n; s++) {
      fillSyntheticColumn(bid, ask, s, rows);
      ring.append(s, 0, bid, ask, rows);
      const slot = s % cap;
      const [lo, hi] = columnExtent(bid, ask, rows);
      this.gpu.extents.write(slot, lo, hi, s);
    }
    this.frameState.newestSeq = n - 1;
    heatmap.encoding = { decodeScale: 1, norm: 150, ramp: RAMP_FLOW };
    this.camera.reset(ring.residentRange(), rows);
    this.follow.updateView();
    this.frameState.dirty = true;

    // RG32F storage: colsPerTile × rows × layers texels × 2 channels × 4 bytes.
    const ringBytes = ring.fullResBytes();
    return { rows, layers, capacityCols: cap, ringBytes, resident: n };
  }

  /**
   * Preload the normalization/crosshair e2e scenario (network bypassed): two
   * equal-shaped density regions whose scales differ ×50 (a DIM overnight-style
   * region and a BRIGHT live-edge-style region), plus one KNOWN wall cell with a
   * distinctive exact size for the crosshair assertion. Columns go through the
   * REAL {@link DepthIngest.writeColumn} path, so the ring, the per-tile histograms
   * (normalizer) AND the exact CPU cache are all populated exactly as live. The
   * caller sets the epoch params on the store, frames a region with
   * {@link setViewForTest}, and lets the real per-frame viewport normalization run.
   */
  preloadNormalizeScenario(): {
    rows: number;
    epoch: number;
    params: { epoch: number; tick: number; tick_multiple: number; dt_ns: number; p0: number; rows: number };
    dim: { colLo: number; colHi: number };
    bright: { colLo: number; colHi: number };
    /** Col windows strictly INSIDE each regime (inset from the mid-tile seam). */
    dimWindow: { colLo: number; colHi: number };
    brightWindow: { colLo: number; colHi: number };
    centerRow: number;
    band: { lo: number; hi: number };
    wall: { col: number; row: number; bid: number; price: number };
    capacityCols: number;
  } {
    const rows = 512;
    // Tile-aligned regions (colsPerTile = 256): dim = tiles 0-1, bright = tiles
    // 2-3. A regime boundary mid-tile would leak the brighter columns into the
    // dimmer viewport's merge (histograms are tile-granular by design, the
    // O(tiles) budget) — so the two regimes sit on whole-tile boundaries and the
    // measured windows are inset from the seam.
    const region = 512;
    const centerRow = 256;
    const tick = 0.5;
    const tickMultiple = 1;
    const dtNs = 25_000_000;
    const p0 = 100;
    const brightScale = 50;
    const wallCol = region + region / 2; // 768, mid of the bright region
    const wallRow = centerRow;
    const wallBid = 277; // distinctive exact value the crosshair must report

    this.gpu.releaseRingObjects();
    this.shading.normalizer.reset();
    this.columnCache.reset();
    this.ingest.normSeeded = false;

    const total = 2 * region;
    const wantLayers = Math.ceil(total / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.gpu.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.gpu.ctx.gl, rows, layers);
    this.gpu.ring = ring;
    const heatmap = new Heatmap(this.gpu.ctx, ring, this.gpu.lut);
    this.gpu.heatmap = heatmap;
    heatmap.normalizer = this.shading.normalizer;
    this.gpu.mips = this.gpu.createMips(rows, layers);
    heatmap.mips = this.gpu.mips;
    heatmap.levelFloor = this.shading.tickGroupingLevel();
    heatmap.pixel = this.shading.getChartStyle() === 'pixel';
    heatmap.dpr = this.viewport.devicePixelRatio;
    const cap = ring.capacityCols;
    this.gpu.extents.allocate(cap);
    this.axis.slots.allocate(cap);
    this.shading.resetEncoding();
    this.camera.setLimits(limitsFor(rows, cap));

    for (let s = 0; s < total; s++) {
      const scale = s < region ? 1 : brightScale;
      // Fresh arrays per column — the cache holds references (never scratch).
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - centerRow);
        let v = 0;
        if (d <= 2) v = 5 * scale; // the persistent wall band
        else if (d <= 20) v = 0.6 * scale * (1 - d / 20); // ladder falloff
        if (v > 0) {
          if (r <= centerRow) bid[r] = v;
          else ask[r] = v;
        }
      }
      if (s === wallCol) bid[wallRow] = wallBid; // the known crosshair cell
      const col: DepthColumn = {
        type: MsgType.DEPTH_COL,
        epoch: 0,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(dtNs),
        mode: MODE_L2,
        final: true,
        bid,
        ask,
      };
      this.ingest.writeColumn(col, rows);
    }
    this.frameState.newestSeq = total - 1;

    // Frame the bright region initially; the spec reframes to compare regions.
    this.setViewForTest(region, region, centerRow - 40, 80);

    return {
      rows,
      epoch: 0,
      params: { epoch: 0, tick, tick_multiple: tickMultiple, dt_ns: dtNs, p0, rows },
      dim: { colLo: 0, colHi: region - 1 },
      bright: { colLo: region, colHi: total - 1 },
      // Inset 20 cols so the framed window's tiles are pure (no seam leak).
      dimWindow: { colLo: 20, colHi: region - 21 },
      brightWindow: { colLo: region + 20, colHi: total - 21 },
      centerRow,
      band: { lo: centerRow - 40, hi: centerRow + 40 },
      wall: { col: wallCol, row: wallRow, bid: wallBid, price: p0 + wallRow * tick * tickMultiple },
      capacityCols: cap,
    };
  }

  /** Set the view directly from edge/scale form (e2e framing). Follow off. */
  setViewForTest(colOffset: number, colScale: number, rowOffset: number, rowScale: number): void {
    this.camera.state = {
      colCenter: colOffset + colScale / 2,
      colSpan: colScale,
      rowCenter: rowOffset + rowScale / 2,
      rowSpan: rowScale,
      followTime: false,
      followPrice: 'off',
    };
    this.frameState.view = this.camera.toView();
    this.frameState.dirty = true;
    this.frameState.viewMoved = true;
    this.viewport.notifyViewChanged();
  }

  /**
   * Force one synchronous full frame (heatmap + overlays) and return the canvas
   * as a PNG data URL — the snapshot contract the export and share flows build on. Returns null when the GL context is lost: there is no valid
   * back buffer to read and the restored context will repaint anyway.
   */
  snapshot(): string | null {
    if (this.gpu.glLost()) return null;
    this.shading.updateNormalization();
    if (this.gpu.heatmap !== null) {
      this.gpu.heatmap.priceScale = this.axis.overlayPriceMap()?.scale ?? null;
      this.gpu.heatmap.draw(this.frameState.view);
    }
    this.overlayLayer.drawOverlays();
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Ingest a synthetic overlay stream message (Trade/BBO/BarColumn/Marker) through
   * the real live path so the overlays populate exactly as from the socket. e2e
   * only — the spec builds the messages (with BigInt fields) in-page.
   */
  ingestForTest(msg: StreamMsg): void {
    this.ingest.onMessage(msg);
  }

  /**
   * Preload a deterministic overlay scenario (network bypassed): a fresh ring of
   * depth columns with a persistent wall band + ladder (through the REAL
   * DepthIngest.writeColumn path, so the column cache + time anchor populate as live), framed
   * to a recent window. The spec then publishes the epoch + capability to the
   * store and injects known Trade/BBO/BarColumn/Marker events via ingestForTest.
   * Returns plain numbers only (no BigInt — page.evaluate serializes to JSON).
   */
  preloadOverlayScenario(): {
    rows: number;
    epoch: number;
    params: { epoch: number; tick: number; tick_multiple: number; dt_ns: number; p0: number; rows: number };
    dtNs: number;
    p0: number;
    step: number;
    anchorSeq: number;
    anchorT0NsNum: number;
    oldest: number;
    newest: number;
    centerRow: number;
    view: { colOffset: number; colScale: number; rowOffset: number; rowScale: number };
    capacityCols: number;
  } {
    const rows = 256;
    const tick = 0.5;
    const tickMultiple = 1;
    const dtNs = 25_000_000;
    const p0 = 50;
    const centerRow = 100; // price 100.0 at step 0.5 → row (100-50)/0.5
    const total = 400;

    this.gpu.releaseRingObjects();
    this.shading.normalizer.reset();
    this.columnCache.reset();
    this.overlayLayer.overlays.reset();
    this.ingest.normSeeded = false;

    const wantLayers = Math.ceil(total / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.gpu.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.gpu.ctx.gl, rows, layers);
    this.gpu.ring = ring;
    const heatmap = new Heatmap(this.gpu.ctx, ring, this.gpu.lut);
    this.gpu.heatmap = heatmap;
    heatmap.normalizer = this.shading.normalizer;
    this.gpu.mips = this.gpu.createMips(rows, layers);
    heatmap.mips = this.gpu.mips;
    heatmap.levelFloor = this.shading.tickGroupingLevel();
    heatmap.pixel = this.shading.getChartStyle() === 'pixel';
    heatmap.dpr = this.viewport.devicePixelRatio;
    const cap = ring.capacityCols;
    this.gpu.extents.allocate(cap);
    this.axis.slots.allocate(cap);
    this.shading.resetEncoding();
    this.camera.setLimits(limitsFor(rows, cap));

    for (let s = 0; s < total; s++) {
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - centerRow);
        let v = 0;
        if (d <= 2) v = 6; // persistent wall band around the mid
        else if (d <= 24) v = 1.2 * (1 - d / 24); // ladder falloff
        if (v > 0) {
          if (r <= centerRow) bid[r] = v;
          else ask[r] = v;
        }
      }
      const col: DepthColumn = {
        type: MsgType.DEPTH_COL,
        epoch: 0,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(dtNs),
        mode: MODE_L2,
        final: true,
        bid,
        ask,
      };
      this.ingest.writeColumn(col, rows);
    }
    this.frameState.newestSeq = total - 1;
    heatmap.encoding = { decodeScale: 1, norm: 30, ramp: RAMP_FLOW };

    // Frame the recent ~200 columns and a price band around the mid.
    const colScale = 200;
    const colOffset = total - colScale;
    const rowScale = 120;
    const rowOffset = centerRow - 60;
    this.setViewForTest(colOffset, colScale, rowOffset, rowScale);

    return {
      rows,
      epoch: 0,
      params: { epoch: 0, tick, tick_multiple: tickMultiple, dt_ns: dtNs, p0, rows },
      dtNs,
      p0,
      step: tick * tickMultiple,
      anchorSeq: this.axis.overlayAnchorSeq,
      anchorT0NsNum: Number(this.axis.overlayAnchorT0Ns),
      oldest: 0,
      newest: total - 1,
      centerRow,
      view: { colOffset, colScale, rowOffset, rowScale },
      capacityCols: cap,
    };
  }

  /** Run a scripted continuous PAN for `durationMs`; resolves with frame timing. */
  perfPan(durationMs: number, panStepCols = 2): Promise<PerfResult> {
    this.camera.setFollowTime(false);
    this.camera.setPriceFollow('off');
    return new Promise((resolve) => {
      this.frameLoop.perf = {
        kind: 'pan',
        deadline: performance.now() + durationMs,
        deltas: [],
        drawMs: [],
        lastTs: 0,
        panStep: panStepCols,
        zoomAnchor: 0,
        zoomDir: -1,
        zoomMax: 0,
        resolve,
      };
    });
  }

  /** Run a scripted continuous time ZOOM for `durationMs`; resolves with timing. */
  perfZoom(durationMs: number): Promise<PerfResult> {
    this.camera.setFollowTime(false);
    this.camera.setPriceFollow('off');
    const range = this.gpu.residentRange();
    const zoomMax = Math.min(
      this.camera.limits.maxColSpan,
      range ? Math.max(64, range.count) : 2000,
    );
    return new Promise((resolve) => {
      this.frameLoop.perf = {
        kind: 'zoom',
        deadline: performance.now() + durationMs,
        deltas: [],
        drawMs: [],
        lastTs: 0,
        panStep: 0,
        zoomAnchor: this.camera.state.colCenter,
        zoomDir: -1,
        zoomMax,
        resolve,
      };
    });
  }
}

/**
 * Deterministic synthetic depth column for the perf preload: a slowly drifting
 * bright "wall" (a liquidity band) plus sparse low-density noise. Pure function
 * of (colSeq, row) so the preload is reproducible and cheap (O(rows)).
 */
function fillSyntheticColumn(bid: Float32Array, ask: Float32Array, s: number, rows: number): void {
  const center = (rows >> 1) + Math.round(Math.sin(s * 0.02) * rows * 0.1);
  for (let r = 0; r < rows; r++) {
    bid[r] = 0;
    ask[r] = 0;
    const dist = Math.abs(r - center);
    if (dist <= 2) {
      bid[r] = 100;
      ask[r] = 100;
    } else {
      // Cheap integer hash → sparse noise so the heatmap isn't a bare wall.
      const h = ((s * 2654435761 + r * 40503) >>> 0) % 1000;
      if (h < 150) {
        const v = (h / 1000) * 12;
        if (r < center) bid[r] = v;
        else ask[r] = v;
      }
    }
  }
}
