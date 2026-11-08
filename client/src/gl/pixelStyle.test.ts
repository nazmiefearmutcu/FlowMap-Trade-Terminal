import { describe, expect, it } from 'vitest';

import type { GLContext } from './context';
import {
  chartStyleOf,
  DEFAULT_CHART_STYLE,
  Heatmap,
  PIXEL_BLOCK_CSS,
  PIXEL_LEVELS,
  pixelBlockPx,
  posterizePixelLevel,
} from './heatmap';
import { HEATMAP_FRAG } from './shaders/heatmap';
import { makeFakeGL, type FakeGL } from './mockGL';
import { TileRing } from './tileRing';
import { steppedPath } from './overlays/priceLine';
import { PointBatch } from './overlays/primitives';

// The pixel chart style. Normal is the default and must
// keep today's uniform values; pixel snaps samples to device-pixel blocks and
// posterizes the LUT coordinate. These tests pin the CPU side of that contract
// (uniforms, helpers) and the shader text the GPU branch depends on.

function makeHeatmap(): { heatmap: Heatmap; gl: FakeGL } {
  const gl = makeFakeGL({ colorBufferFloat: true });
  const ctx: GLContext = {
    gl,
    caps: {
      maxTextureImageUnits: 16,
      maxArrayTextureLayers: 2048,
      maxTextureSize: 8192,
      colorBufferFloat: true,
    },
  } as unknown as GLContext;
  const ring = new TileRing(gl, 16, 1);
  const heatmap = new Heatmap(ctx, ring, gl.createTexture()!);
  return { heatmap, gl };
}

function lastInt(g: FakeGL, name: string): number | undefined {
  const calls = g
    .callsOf('uniform1i')
    .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
  return calls.length > 0 ? (calls[calls.length - 1].args[1] as number) : undefined;
}

function lastFloat(g: FakeGL, name: string): number | undefined {
  const calls = g
    .callsOf('uniform1f')
    .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
  return calls.length > 0 ? (calls[calls.length - 1].args[1] as number) : undefined;
}

function lastVec2(g: FakeGL, name: string): number[] | undefined {
  const calls = g
    .callsOf('uniform2f')
    .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
  return calls.length > 0 ? (calls[calls.length - 1].args.slice(1) as number[]) : undefined;
}

const VIEW = { colOffset: 0, colScale: 64, rowOffset: 0, rowScale: 16 };

describe('pixel chart style: defaults and settings coercion', () => {
  it('defaults to normal and coerces junk to normal', () => {
    expect(DEFAULT_CHART_STYLE).toBe('normal');
    expect(chartStyleOf(undefined)).toBe('normal');
    expect(chartStyleOf('pixelated')).toBe('normal');
    expect(chartStyleOf('pixel')).toBe('pixel');
  });
});

describe('pixel chart style: block size and posterize helper', () => {
  it('block edge is round(6 × devicePixelRatio) device pixels, at least 1', () => {
    expect(PIXEL_BLOCK_CSS).toBe(6);
    expect(pixelBlockPx(1)).toBe(6);
    expect(pixelBlockPx(2)).toBe(12);
    expect(pixelBlockPx(1.5)).toBe(9);
    expect(pixelBlockPx(0)).toBe(6); // a missing ratio degrades to DPR 1
    expect(pixelBlockPx(Number.NaN)).toBe(6);
  });

  it('posterizes to seven flat bands with exact endpoints', () => {
    expect(PIXEL_LEVELS).toBe(7);
    expect(posterizePixelLevel(0)).toBe(0);
    expect(posterizePixelLevel(1)).toBe(1);
    expect(posterizePixelLevel(-3)).toBe(0);
    expect(posterizePixelLevel(7)).toBe(1);
    const bands = new Set<number>();
    for (let i = 0; i <= 1000; i++) bands.add(posterizePixelLevel(i / 1000));
    expect(bands.size).toBe(PIXEL_LEVELS);
    // Each band is k/6 for k = 0..6.
    for (const v of bands) expect(Math.abs(v * 6 - Math.round(v * 6))).toBeLessThan(1e-9);
  });

  it('is monotone non-decreasing, so brighter density never maps to a darker band', () => {
    let prev = -1;
    for (let i = 0; i <= 500; i++) {
      const q = posterizePixelLevel(i / 500);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
  });
});

describe('pixel chart style: heatmap uniforms', () => {
  it('normal style uploads u_pixelMode 0 and leaves the shipped values', () => {
    const { heatmap, gl } = makeHeatmap();
    expect(heatmap.pixel).toBe(false);
    heatmap.draw(VIEW);
    expect(lastInt(gl, 'u_pixelMode')).toBe(0);
  });

  it('pixel style uploads the mode, the DPR-scaled block and the drawing-buffer viewport', () => {
    const { heatmap, gl } = makeHeatmap();
    heatmap.pixel = true;
    // The block follows the renderer's cached ratio, not a live window read.
    heatmap.dpr = 2;
    heatmap.draw(VIEW);
    expect(lastInt(gl, 'u_pixelMode')).toBe(1);
    expect(lastFloat(gl, 'u_pixelBlock')).toBe(12);
    expect(lastVec2(gl, 'u_viewport')).toEqual([gl.drawingBufferWidth, gl.drawingBufferHeight]);
  });

  it('the block ignores a live window ratio that the renderer has not synced', () => {
    const { heatmap, gl } = makeHeatmap();
    heatmap.pixel = true;
    const dpr = window.devicePixelRatio;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      heatmap.draw(VIEW);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
    }
    expect(lastFloat(gl, 'u_pixelBlock')).toBe(6);
  });

  it('switching back to normal clears the mode on the next draw', () => {
    const { heatmap, gl } = makeHeatmap();
    heatmap.pixel = true;
    heatmap.draw(VIEW);
    heatmap.pixel = false;
    heatmap.draw(VIEW);
    expect(lastInt(gl, 'u_pixelMode')).toBe(0);
  });
});

describe('pixel chart style: shader contract', () => {
  it('declares the pixel uniforms and samples at the block centre', () => {
    expect(HEATMAP_FRAG).toContain('uniform int u_pixelMode;');
    expect(HEATMAP_FRAG).toContain('uniform float u_pixelBlock;');
    expect(HEATMAP_FRAG).toContain('uniform vec2 u_viewport;');
    expect(HEATMAP_FRAG).toContain(
      'vec2 centre = (floor(gl_FragCoord.xy / u_pixelBlock) + 0.5) * u_pixelBlock;',
    );
  });

  it('posterizes the LUT coordinate before the colormap lookup, in both channels', () => {
    // The density path quantizes the final coordinate, then indexes the LUT.
    expect(HEATMAP_FRAG).toContain('if (u_pixelMode == 1) coord = posterizePixel(coord);');
    expect(HEATMAP_FRAG).toContain('int li = int(coord * 255.0 + 0.5);');
    expect(HEATMAP_FRAG).toContain('if (u_pixelMode == 1) dq = posterizePixel(dq);');
    // The lookup itself still reads the active ramp row, so colours come from the theme.
    expect(HEATMAP_FRAG).toContain('fragColor = texelFetch(u_lut, ivec2(li, u_ramp), 0);');
  });

  it('keeps the normal sample coordinate on v_uv (the normal path is unchanged)', () => {
    expect(HEATMAP_FRAG).toContain('vec2 uv = v_uv;');
    expect(HEATMAP_FRAG).toContain('float colf = u_colOffset + u_colScale * uv.x;');
  });
});

describe('pixel chart style: overlays', () => {
  it('steppedPath runs horizontal then vertical between closes', () => {
    const out = steppedPath([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
    ]);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
    ]);
  });

  it('steppedPath keeps single and empty inputs unchanged', () => {
    expect(steppedPath([])).toEqual([]);
    expect(steppedPath([{ x: 3, y: 4 }])).toEqual([{ x: 3, y: 4 }]);
  });

  it('a point batch in square mode sets u_square for its flush and resets it', () => {
    const gl = makeFakeGL({ colorBufferFloat: true });
    const batch = new PointBatch(gl as unknown as WebGL2RenderingContext);
    const color: [number, number, number, number] = [1, 1, 1, 1];
    batch.begin();
    batch.add(0, 0, 6, color);
    batch.setSquare(true);
    batch.flush();
    expect(lastInt(gl, 'u_square')).toBe(1);
    batch.begin();
    batch.add(0, 0, 6, color);
    batch.setSquare(false);
    batch.flush();
    expect(lastInt(gl, 'u_square')).toBe(0);
  });
});
