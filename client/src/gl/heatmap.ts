/**
 * The heatmap draw pass (rendering).
 *
 * Owns the shader program, a full-viewport quad VAO, and the uniform wiring
 * that ties the tile ring + LUT together. `draw(view)` renders the resident
 * columns: it binds the two textures, pushes the view transform + encoding /
 * normalization / ramp uniforms, and issues ONE draw call. Panning/zooming is
 * purely a matter of the `view` uniforms — this pass never touches tile
 * pixels, upholding the no-re-raster invariant.
 */

import { checkGLError, type GLContext } from './context';
import { RAMP_FLOW } from './lut';
import type { MipChain } from './mips';
import type { ViewportNormalizer } from './normalize';
import { heatmapProgram } from './heatmapProgram';
import { TileRing } from './tileRing';
import { rowToPrice, type PriceScale } from './priceScale';

import { HeatmapView, HeatmapEncoding, DEPTH_CHANNEL_CODE, pixelBlockPx, TILE_UNIT, LUT_UNIT, MIP1_UNIT, MIP2_UNIT, ROWMIP_UNIT, GEOMETRY_UNIT, RESOLUTION_UNIT, DEFAULT_DISPLAY_GAMMA, TRANSFER_LOG_SCALE, TRANSFER_LOW_SPAN, DEFAULT_KNEE_FRACTION, clampKneeFraction, TOLERANCE_MAX_FLOOR, floorForTolerance, selectLevel, levelBlendFor, SmoothPlan, smoothPlanFor, rowSmoothDyFor, gaussianTaps, effectiveRowMode, rowMipSoftenFor, SMOOTH_ROW_MIP_SIGMA_PX, rowMipWeightsFor, sanitizeDpr, uploadFloatArray } from './heatmapMath';
export * from './heatmapMath';

type UniformName =
  | 'u_tiles'
  | 'u_mip1'
  | 'u_mip2'
  | 'u_rowMip1'
  | 'u_lut'
  | 'u_colOffset'
  | 'u_colScale'
  | 'u_rowOffset'
  | 'u_rowScale'
  | 'u_priceProjection'
  | 'u_priceCore'
  | 'u_priceWings'
  | 'u_pricePixel'
  | 'u_geometry'
  | 'u_geometryEnabled'
  | 'u_priceOriginResidual'
  | 'u_resolution'
  | 'u_resolutionEnabled'
  | 'u_maxLevel'
  | 'u_levelFloor'
  | 'u_timeLevel'
  | 'u_rowMipUsable'
  | 'u_capacityCols'
  | 'u_colsPerTile'
  | 'u_rows'
  | 'u_validFrom'
  | 'u_residentNewest'
  | 'u_decodeScale'
  | 'u_norm'
  | 'u_gamma'
  | 'u_floor'
  | 'u_floorScale'
  | 'u_ramp'
  | 'u_channel'
  | 'u_pixelMode'
  | 'u_pixelBlock'
  | 'u_viewport'
  | 'u_level'
  | 'u_blk'
  | 'u_nRowTaps'
  | 'u_levelFade'
  | 'u_nRowTapsFine'
  | 'u_rowOnly'
  | 'u_rowFade'
  | 'u_knee'
  | 'u_logScale'
  | 'u_lowSpan'
  | 'u_smoothTaps'
  | 'u_smoothOffsets'
  | 'u_smoothWeights'
  | 'u_rowSmoothDy'
  | 'u_rowMipSoften'
  | 'u_rowMipWeights';

/** The sampling decisions one frame uploads, derived from the view (see Heatmap.planSampling). */
interface FramePlan {
  colsPerPixel: number;
  level: number;
  blk: number;
  nRowTaps: number;
  levelFade: number;
  nRowTapsFine: number;
  finerLevel: number;
  rowFade: number;
  smooth: SmoothPlan;
  taps: { offsets: Float32Array; weights: Float32Array };
  rowDy: number;
  rowMipSoften: number;
  rowMipWeights: Float32Array;
  rowMipSigma: number;
}

export class Heatmap {
  priceScale: PriceScale | null = null;
  readonly gl: WebGL2RenderingContext;
  private readonly tileRing: TileRing;
  private readonly lut: WebGLTexture;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly u: Record<UniformName, WebGLUniformLocation | null>;

  /** SUM-mip chain. null → the shader stays on the level-0 single-tap path. */
  mips: MipChain | null = null;

  encoding: HeatmapEncoding = { decodeScale: 1, norm: 1, ramp: RAMP_FLOW };

  /**
   * Perceptual display gamma applied to the normalized intensity before the LUT
   *. Kept separate from {@link encoding} so it survives the per-session
   * encoding reassignments; the settings drawer's Contrast control writes it.
   */
  gamma = DEFAULT_DISPLAY_GAMMA;

  /** Explicit normalized cut for diagnostic callers that bypass the slider. */
  floor = 0;

  /** Raw 0–100 noise-filter position; null retains the explicit floor API. */
  toleranceValue: number | null = null;

  /**
   * Depth channel mode: the `u_channel` code fed to the
   * fragment shader — 0 sum (the default, bit-identical to pre-channel
   * releases), 1 bid, 2 ask, 3 imbalance (divergent row). Kept outside
   * {@link encoding} like {@link gamma}: the renderer owns the setting
   * (`setDepthChannel`) and re-applies it after every Heatmap re-creation,
   * forcing 'sum' whenever the honesty ramp is SYNTH (— fabricated equity
   * depth never wears the directional bid/ask colors).
   */
  channel = DEPTH_CHANNEL_CODE.sum;

  /**
   * Pixel chart style: `false` is the smooth normal field
   * (the shader's `u_pixelMode` 0, bit-identical to before the option existed).
   * `true` snaps samples to {@link pixelBlockPx} device-pixel blocks and
   * posterizes the LUT coordinate. The renderer owns the setting
   * (`setChartStyle`) and re-applies it after every Heatmap re-creation.
   */
  pixel = false;

  /**
   * The device-pixel ratio the softness/selection footprints are denominated
   * against (the DPR handoff). The renderer owns the ONE cached
   * value: it syncs this on every resize and DPR change, so the
   * drawing buffer, the overlay gutters and this footprint math cannot read two
   * different ratios. A poisoned value degrades to 1 at draw time.
   */
  dpr = 1;

  /**
   * Tick-grouping floor on the SUM-mip level:
   * `Renderer.setTickGrouping(n)` sets this to the smallest level whose 4^level
   * block already groups ≥ n rows (`ceil(log4(n))`), clamped to `maxLevel` at
   * draw time. 0 (the default) is a no-op — every draw selects EXACTLY the
   * level the pre-tickGrouping code picked. Kept outside {@link encoding}, like
   * {@link gamma}, so a re-creation on session reset / context restore can
   * re-apply the user's setting.
   */
  levelFloor = 0;

  /**
   * Knee fraction uploaded when {@link normalizer} is NOT attached (unit tests,
   * synthetic e2e hook): {@link DEFAULT_KNEE_FRACTION}. With a normalizer
   * attached the draw computes `clamp(knee/white, 0.05, 0.95)` from the live
   * EMA pair instead (Bookmap-class overhaul).
   */
  knee = DEFAULT_KNEE_FRACTION;

  /**
   * Output span of the below-knee transfer segment (calibration fix
   * 2026-09-13): {@link TRANSFER_LOW_SPAN}. A per-Heatmap field so tests can
   * pin the upload without reaching into the shader constant.
   */
  lowSpan = TRANSFER_LOW_SPAN;

  /**
   * Optional viewport normalizer attachment: when set, the draw reads
   * `currentPercentiles` (the same EMA the renderer feeds `u_norm`) for the
   * per-frame `u_knee = clamp(knee/white, 0.05, 0.95)`. The renderer wires this
   * on creation; without it the {@link knee} fallback is used.
   */
  normalizer: ViewportNormalizer | null = null;

  /**
   * Gaussian sampler + cross-fade diagnostics from the LAST {@link draw}:
   * the time-axis footprint, the sampler plan, and the row/level fade
   * weights that were uploaded. Defaults to the plan at `colsPerPixel = 1`
   * before the first draw.
   */
  private lastSample = {
    colsPerPixel: 1,
    smoothSigma: smoothPlanFor(1).sigmaCols,
    smoothTaps: smoothPlanFor(1).taps,
    rowDy: 0,
    rowMipSoften: 0,
    rowMipSigma: 0,
    rowFade: 0,
    levelFade: 0,
    finerLevel: -1,
  };

  constructor(ctx: GLContext, tileRing: TileRing, lut: WebGLTexture) {
    const gl = ctx.gl;
    this.gl = gl;
    this.tileRing = tileRing;
    this.lut = lut;

    this.program = heatmapProgram(gl);

    // Full-viewport quad as a triangle strip: (pos.xy, uv.xy) interleaved.
    // uv spans 0..1 with y up (uv.y 0 = bottom of the price grid).
    // prettier-ignore
    const verts = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]);
    const quad = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!quad || !vao) throw new Error('flowmap/heatmap: buffer/VAO alloc failed');
    this.quad = quad;
    this.vao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const loc = (n: string) => gl.getUniformLocation(this.program, n);
    this.u = {
      u_tiles: loc('u_tiles'),
      u_mip1: loc('u_mip1'),
      u_mip2: loc('u_mip2'),
      u_rowMip1: loc('u_rowMip1'),
      u_lut: loc('u_lut'),
      u_colOffset: loc('u_colOffset'),
      u_colScale: loc('u_colScale'),
      u_rowOffset: loc('u_rowOffset'),
      u_rowScale: loc('u_rowScale'),
      u_priceProjection: loc('u_priceProjection'),
      u_priceCore: loc('u_priceCore'),
      u_priceWings: loc('u_priceWings'),
      u_pricePixel: loc('u_pricePixel'),
      u_geometry: loc('u_geometry'),
      u_geometryEnabled: loc('u_geometryEnabled'),
      u_priceOriginResidual: loc('u_priceOriginResidual'),
      u_resolution: loc('u_resolution'),
      u_resolutionEnabled: loc('u_resolutionEnabled'),
      u_maxLevel: loc('u_maxLevel'),
      u_levelFloor: loc('u_levelFloor'),
      u_timeLevel: loc('u_timeLevel'),
      u_rowMipUsable: loc('u_rowMipUsable'),
      u_capacityCols: loc('u_capacityCols'),
      u_colsPerTile: loc('u_colsPerTile'),
      u_rows: loc('u_rows'),
      u_validFrom: loc('u_validFrom'),
      u_residentNewest: loc('u_residentNewest'),
      u_decodeScale: loc('u_decodeScale'),
      u_norm: loc('u_norm'),
      u_gamma: loc('u_gamma'),
      u_floor: loc('u_floor'),
      u_floorScale: loc('u_floorScale'),
      u_ramp: loc('u_ramp'),
      u_channel: loc('u_channel'),
      u_pixelMode: loc('u_pixelMode'),
      u_pixelBlock: loc('u_pixelBlock'),
      u_viewport: loc('u_viewport'),
      u_level: loc('u_level'),
      u_blk: loc('u_blk'),
      u_nRowTaps: loc('u_nRowTaps'),
      u_levelFade: loc('u_levelFade'),
      u_nRowTapsFine: loc('u_nRowTapsFine'),
      u_rowOnly: loc('u_rowOnly'),
      u_rowFade: loc('u_rowFade'),
      u_knee: loc('u_knee'),
      u_logScale: loc('u_logScale'),
      u_lowSpan: loc('u_lowSpan'),
      u_smoothTaps: loc('u_smoothTaps'),
      u_smoothOffsets: loc('u_smoothOffsets[0]'),
      u_smoothWeights: loc('u_smoothWeights[0]'),
      u_rowSmoothDy: loc('u_rowSmoothDy'),
      u_rowMipSoften: loc('u_rowMipSoften'),
      u_rowMipWeights: loc('u_rowMipWeights[0]'),
    };
    checkGLError(gl, 'Heatmap.ctor');
  }

  /**
   * A default view that fills the viewport with all resident columns and the
   * full price grid (single epoch). Replaces this with the pan/zoom camera.
   */
  fitView(): HeatmapView {
    const range = this.tileRing.residentRange();
    const colOffset = range ? range.oldest : 0;
    const colScale = range ? range.count : 1;
    return { colOffset, colScale, rowOffset: 0, rowScale: this.tileRing.rows };
  }

  draw(view: HeatmapView): void {
    const gl = this.gl;
    const range = this.tileRing.residentRange();

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // A chain whose FBO went incomplete (MipChain.usable === false) is treated as
    // absent: the exact level-0 path instead of sampling broken mips.
    const mips = this.mips !== null && !this.mips.usable ? null : this.mips;
    this.bindSampleTextures(mips);
    this.uploadView(view);
    this.uploadGeometry();
    const scale = this.priceScale;
    const physicalProjection = scale?.kind === 'hybrid' || (scale !== null && this.tileRing.geometry.texture !== null);
    this.uploadPriceProjection(view, scale, physicalProjection);
    gl.uniform1i(this.u.u_maxLevel, mips?.maxLevel ?? 0);
    gl.uniform1i(this.u.u_rowMipUsable, mips?.rowUsable ? 1 : 0);
    gl.uniform1i(this.u.u_levelFloor, this.levelFloor);
    // Projected sampling can average native columns without square mips.
    // Time resolution must never force coarser price buckets in the wings.
    gl.uniform1i(this.u.u_timeLevel, selectLevel(0, 2, view.colScale / Math.max(1, gl.drawingBufferWidth) * sanitizeDpr(this.dpr)).level);
    this.uploadRingState(range);
    this.uploadTransfer();
    const plan = this.planSampling(view, mips);
    this.uploadSampling(plan);
    this.uploadFloor(physicalProjection, plan.nRowTaps, plan.blk);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    checkGLError(gl, 'Heatmap.draw', true);
  }

  /**
   * Bind the tile ring, the LUT and the SUM / row mip levels. With no usable chain
   * the ring texture is bound as a valid, complete stand-in: the shader never
   * samples it because level selection is forced to 0 (u_level == 0 reads u_tiles
   * only), and u_rowOnly is forced to 0 for the same reason.
   */
  private bindSampleTextures(mips: MipChain | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + TILE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileRing.texture);
    gl.uniform1i(this.u.u_tiles, TILE_UNIT);

    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.u.u_lut, LUT_UNIT);

    const mip1 = mips ? mips.tex1 : this.tileRing.texture;
    const mip2 = mips && mips.tex2 ? mips.tex2 : this.tileRing.texture;
    gl.activeTexture(gl.TEXTURE0 + MIP1_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip1);
    gl.uniform1i(this.u.u_mip1, MIP1_UNIT);
    gl.activeTexture(gl.TEXTURE0 + MIP2_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip2);
    gl.uniform1i(this.u.u_mip2, MIP2_UNIT);
    // Row-only chain, with the same stand-in as the SUM levels above.
    const rowMip = mips ? mips.texRow1 : this.tileRing.texture;
    gl.activeTexture(gl.TEXTURE0 + ROWMIP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, rowMip);
    gl.uniform1i(this.u.u_rowMip1, ROWMIP_UNIT);
  }

  private uploadView(view: HeatmapView): void {
    const gl = this.gl;
    gl.uniform1f(this.u.u_colOffset, view.colOffset);
    gl.uniform1f(this.u.u_colScale, view.colScale);
    gl.uniform1f(this.u.u_rowOffset, view.rowOffset);
    gl.uniform1f(this.u.u_rowScale, view.rowScale);
  }

  /** Bind the per-column geometry and resolution textures, with their enable flags. */
  private uploadGeometry(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + GEOMETRY_UNIT);
    this.tileRing.geometry.flush();
    gl.bindTexture(gl.TEXTURE_2D, this.tileRing.geometry.texture ?? this.lut);
    gl.uniform1i(this.u.u_geometry, GEOMETRY_UNIT);
    gl.uniform1i(this.u.u_geometryEnabled, this.tileRing.geometry.texture ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0 + RESOLUTION_UNIT);
    this.tileRing.geometry.flushResolution();
    gl.bindTexture(gl.TEXTURE_2D, this.tileRing.geometry.resolutionTexture ?? this.lut);
    gl.uniform1i(this.u.u_resolution, RESOLUTION_UNIT);
    gl.uniform1i(this.u.u_resolutionEnabled, this.tileRing.geometry.resolutionTexture ? 1 : 0);
  }

  /** The price-axis projection uniforms: the hybrid core/wings or the linear grid. */
  private uploadPriceProjection(view: HeatmapView, scale: PriceScale | null, physicalProjection: boolean): void {
    const gl = this.gl;
    const origin = scale?.kind === 'hybrid' ? scale.coreP0 : scale?.p0 ?? 0;
    gl.uniform1f(this.u.u_priceOriginResidual, origin - Math.fround(origin));
    gl.uniform1i(this.u.u_priceProjection, physicalProjection ? 1 : 0);
    if (scale?.kind === 'hybrid') {
      const low = rowToPrice(scale, view.rowOffset);
      const high = rowToPrice(scale, view.rowOffset + view.rowScale);
      const coreHi = scale.coreP0 + scale.coreRows * scale.coreStep;
      const dnLog = Math.log(scale.coreP0 / scale.loPrice) / Math.max(1, scale.dnRows);
      const upLog = Math.log(scale.hiPrice / coreHi) / Math.max(1, scale.rows - scale.dnRows - scale.coreRows);
      gl.uniform4f(this.u.u_priceCore, scale.dnRows, scale.coreRows, scale.coreStep, scale.coreP0);
      gl.uniform4f(this.u.u_priceWings, dnLog, upLog, low - scale.coreP0, high - low);
      gl.uniform1f(this.u.u_pricePixel, (high - low) * sanitizeDpr(this.dpr) / Math.max(1, gl.drawingBufferHeight));
    } else if (scale?.kind === 'linear' && physicalProjection) {
      const low = rowToPrice(scale, view.rowOffset - 0.5);
      const span = view.rowScale * scale.step;
      gl.uniform4f(this.u.u_priceCore, -1, scale.rows, scale.step, scale.p0);
      gl.uniform4f(this.u.u_priceWings, 0, 0, low - scale.p0, span);
      gl.uniform1f(this.u.u_pricePixel, span * sanitizeDpr(this.dpr) / Math.max(1, gl.drawingBufferHeight));
    }
  }

  /** The painting window is [validFrom, residentNewest]; see the comment in the body. */
  private uploadRingState(range: ReturnType<TileRing['residentRange']>): void {
    const gl = this.gl;
    gl.uniform1i(this.u.u_capacityCols, this.tileRing.capacityCols);
    gl.uniform1i(this.u.u_colsPerTile, this.tileRing.colsPerTile);
    gl.uniform1i(this.u.u_rows, this.tileRing.rows);
    // The painting window is [validFrom, residentNewest]: the resident window's
    // left edge, advanced past any gap whose slots still hold previous columns
    // (gl/tileRing validFromSeq). With no residents, validFrom(1) > newest(0)
    // makes every column out-of-range.
    gl.uniform1i(
      this.u.u_validFrom,
      range ? Math.max(this.tileRing.validFromSeq(), range.oldest) : 1,
    );
    gl.uniform1i(this.u.u_residentNewest, range ? range.newest : 0);
  }

  /** Encoding, gamma, transfer curve, colour ramp, channel and pixel-style uniforms. */
  private uploadTransfer(): void {
    const gl = this.gl;
    gl.uniform1f(this.u.u_decodeScale, this.encoding.decodeScale);
    gl.uniform1f(this.u.u_norm, this.encoding.norm);
    gl.uniform1f(this.u.u_gamma, this.gamma);
    // Two-segment transfer curve (low-span calibrated 2026-09-13): the
    // knee fraction comes from the normalizer's EMA pair when attached (the
    // SAME merged CDF the renderer feeds `u_norm` from), else the module-default
    // fallback. `u_lowSpan` fixes how much of the ramp the below-knee segment
    // owns (heavy-tail mid-field must not be capped at the knee fraction).
    const pcts = this.normalizer !== null ? this.normalizer.currentPercentiles : null;
    const kneeFraction =
      pcts !== null && Number.isFinite(pcts.white) && pcts.white > 0
        ? clampKneeFraction(pcts.knee / pcts.white)
        : clampKneeFraction(this.knee);
    gl.uniform1f(this.u.u_knee, kneeFraction);
    gl.uniform1f(this.u.u_logScale, TRANSFER_LOG_SCALE);
    gl.uniform1f(this.u.u_lowSpan, this.lowSpan);
    gl.uniform1i(this.u.u_ramp, this.encoding.ramp);
    gl.uniform1i(this.u.u_channel, this.channel);
    // Pixel chart style. The block is device pixels, so it follows the
    // live ratio; the viewport is the drawing buffer the full-viewport quad covers.
    gl.uniform1i(this.u.u_pixelMode, this.pixel ? 1 : 0);
    gl.uniform1f(this.u.u_pixelBlock, pixelBlockPx(sanitizeDpr(this.dpr)));
    gl.uniform2f(this.u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  /**
   * The frame's sampling decisions, computed from the view and the chart state
   * without touching GL. Rows AND columns collapsing into one device pixel drive
   * the mip level: a coarser level as either axis zooms out. The column half is
   * what keeps a time-zoomed-out + price-zoomed-in view from aliasing through the
   * level-0 blur. rowScale/colScale are uniforms and the buffer size is fixed, so
   * this is one selection for the whole frame. Mip *generation* is incremental
   * (append time); mip *sampling* is at most 4 texelFetch per pixel, keeping the
   * draw O(1) in history. `mips` (not this.mips): an unusable chain must
   * level-select to 0.
   */
  private planSampling(view: HeatmapView, mips: MipChain | null): FramePlan {
    const gl = this.gl;
    const maxLevel = mips ? mips.maxLevel : 0;
    const rowsPerPixel = view.rowScale / Math.max(1, gl.drawingBufferHeight);
    const colsPerPixel = view.colScale / Math.max(1, gl.drawingBufferWidth);
    // CSS-px denomination: every softness kernel AND the row-axis LOD regime are
    // defined in SCREEN = CSS pixels. The framebuffer footprints are scaled by the
    // device-pixel ratio here (the CPU scale factor) so a retina panel renders the
    // SAME CSS softness as DPR1. DPR1 reads exactly 1, and the SELECTION inputs
    // (selectLevel/levelBlendFor/effectiveRowMode) ride the same CSS quantities, so
    // the same CSS view picks the same level and row regime at every DPR.
    const dpr = sanitizeDpr(this.dpr);
    const rppCss = rowsPerPixel * dpr;
    const cppCss = colsPerPixel * dpr;
    const sel = selectLevel(rppCss, maxLevel, cppCss, this.levelFloor);
    // Row-mip cross-fade (see rowFadeFor/effectiveRowMode). The hard row-mip
    // threshold pops while zooming; instead the row-mip blend weight ramps smoothly
    // across the row-mip eligibility regime (sel.rowOnly: rpp >= 1.5, deep time
    // zoom, no tick-grouping floor), renormalized to 0 at the regime edge so the
    // switch has no step. Any fade > 0 forces level 0 with a 4-ROW block, because
    // the shader's blend branch ignores u_level for the row term. Ineligible frames
    // (no usable chain, cpp zoomed out, forced floor, rpp < 1.5) keep the legacy
    // selection verbatim.
    const rowEligible = sel.rowOnly === true && mips !== null && mips.rowUsable;
    const rowFade = effectiveRowMode(rppCss, rowEligible).rowFade;
    // SUM-mip level cross-fade (see levelBlendFor). The hard 4^k LOD switch is a
    // measured brightness pop; outside a transition band the blend is pure: `fade
    // <= 0` takes sel verbatim, `fade === 1` takes the coarse level k. Inside the
    // band the shader mixes the finer level in via u_levelFade / u_nRowTapsFine.
    // The row path owns the row axis, so the SUM blend is skipped while it is active.
    let level: number;
    let blk: number;
    let nRowTaps: number;
    let levelFade = 0;
    let nRowTapsFine = 1;
    let finerLevel = -1;
    if (rowFade > 0) {
      level = 0;
      blk = 4;
      nRowTaps = Math.max(1, Math.min(4, Math.ceil(rppCss / 4)));
    } else {
      const fp = Math.max(rppCss, cppCss);
      const blend = levelBlendFor(fp, maxLevel, this.levelFloor);
      if (blend.fade <= 0) {
        level = sel.level;
        blk = sel.blk;
        nRowTaps = sel.nRowTaps;
      } else {
        level = blend.level;
        blk = 4 ** level;
        nRowTaps = Math.max(1, Math.min(4, Math.ceil(rppCss / blk)));
        levelFade = blend.fade;
        nRowTapsFine = Math.max(1, Math.min(4, Math.ceil(rppCss / (blk / 4))));
        finerLevel = blend.finerLevel;
      }
    }
    // Gaussian field sampler (see smoothPlanFor): one width-scaled kernel on the
    // TIME axis, per-draw constants (sigma/weights computed here, no per-fragment
    // exp). The plan covers the whole zoom range coherently, with no crisp/blur handoff.
    const smooth = smoothPlanFor(cppCss);
    // Vertical softening (barcode fix; pixel-denominated, active at every zoom;
    // CSS-denominated via `rppCss`) — see rowSmoothDyFor.
    const rowDy = rowSmoothDyFor(rppCss);
    // Deep-row softening (barcode fix): 1 inside the row-mip regime so the 4-row
    // texel fetch gains the vertical Gaussian (see rowMipWeightsFor / rowMipSoftenFor).
    // Only the row-mip branches read it; 0 keeps their exact historical single-fetch output.
    const rowMipSoften = rowMipSoftenFor(rppCss);
    const rowMipWeights = rowMipWeightsFor(rppCss);
    const rowMipSigma = rowMipSoften > 0 ? (SMOOTH_ROW_MIP_SIGMA_PX * rppCss) / 4 : 0;
    return {
      colsPerPixel,
      level,
      blk,
      nRowTaps,
      levelFade,
      nRowTapsFine,
      finerLevel,
      rowFade,
      smooth,
      taps: gaussianTaps(smooth.sigmaCols, smooth.taps),
      rowDy,
      rowMipSoften,
      rowMipWeights,
      rowMipSigma,
    };
  }

  /** Upload the level, row-mip and Gaussian sampler uniforms, and record the sample for {@link sampleInfo}. */
  private uploadSampling(plan: FramePlan): void {
    const gl = this.gl;
    gl.uniform1i(this.u.u_level, plan.level);
    gl.uniform1i(this.u.u_blk, plan.blk);
    gl.uniform1i(this.u.u_nRowTaps, plan.nRowTaps);
    gl.uniform1f(this.u.u_levelFade, plan.levelFade);
    gl.uniform1i(this.u.u_nRowTapsFine, plan.nRowTapsFine);
    gl.uniform1i(this.u.u_rowOnly, plan.rowFade > 0 ? 1 : 0);
    gl.uniform1f(this.u.u_rowFade, plan.rowFade);
    this.lastSample = {
      // Framebuffer-denominated, as every earlier caller reported it; the
      // CSS-side footprint is `colsPerPixel · dpr` (see dpr).
      colsPerPixel: plan.colsPerPixel,
      smoothSigma: plan.smooth.sigmaCols,
      smoothTaps: plan.smooth.taps,
      rowDy: plan.rowDy,
      rowMipSoften: plan.rowMipSoften,
      rowMipSigma: plan.rowMipSigma,
      rowFade: plan.rowFade,
      levelFade: plan.levelFade,
      finerLevel: plan.finerLevel,
    };
    gl.uniform1i(this.u.u_smoothTaps, plan.smooth.taps);
    uploadFloatArray(gl, this.u.u_smoothOffsets, plan.taps.offsets);
    uploadFloatArray(gl, this.u.u_smoothWeights, plan.taps.weights);
    gl.uniform1f(this.u.u_rowSmoothDy, plan.rowDy);
    gl.uniform1f(this.u.u_rowMipSoften, plan.rowMipSoften);
    uploadFloatArray(gl, this.u.u_rowMipWeights, plan.rowMipWeights);
  }

  /**
   * The black point scales by the pixel's ROW footprint. `intensity` sums nRowTaps
   * rows of a blk-row block and divides only the COLUMN dimension by blk, and
   * normMipScale(level) is 1 by design (gl/normalize.ts), so an unscaled floor would
   * hide a different amount of size at every zoom. Clamped below 1 so the
   * re-expansion never degenerates. Hybrid pixels select their own local row
   * footprint in the shader; ordinary views keep the frame-wide floor semantics.
   */
  private uploadFloor(physicalProjection: boolean, nRowTaps: number, blk: number): void {
    const gl = this.gl;
    const floorRows = physicalProjection ? 1 : nRowTaps * blk;
    const calibratedFloor = this.toleranceValue === null
      ? this.floor
      : floorForTolerance(this.toleranceValue, this.normalizer);
    const floor = Math.min(
      TOLERANCE_MAX_FLOOR,
      Math.max(0, calibratedFloor) * floorRows,
    );
    gl.uniform1f(this.u.u_floor, floor);
    gl.uniform1f(this.u.u_floorScale, 1 / Math.max(1 - floor, 1e-6));
  }

  /**
   * The sampler plan + cross-fade weights the LAST {@link draw} uploaded —
   * `colsPerPixel`, the Gaussian plan (see {@link smoothPlanFor}), the
   * vertical softening offset (see {@link rowSmoothDyFor}), the effective
   * row-mip cross-fade weight (see {@link effectiveRowMode}) and the SUM-mip
   * level cross-fade (see {@link levelBlendFor}; `finerLevel` is -1 whenever no
   * second sample exists). Defaults to the `colsPerPixel = 1` plan
   * (`{ colsPerPixel: 1, smoothSigma: 2, smoothTaps: 9, rowDy: 0, rowFade: 0,
   * levelFade: 0, finerLevel: -1 }`) before the first draw. Diagnostics/tests
   * only (testHook.levelInfo).
   */
  sampleInfo(): {
    colsPerPixel: number;
    smoothSigma: number;
    smoothTaps: number;
    rowDy: number;
    rowMipSoften: number;
    rowMipSigma: number;
    rowFade: number;
    levelFade: number;
    finerLevel: number;
  } {
    return { ...this.lastSample };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
  }
}
