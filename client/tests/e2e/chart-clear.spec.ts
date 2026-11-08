import type { LooseProbe } from './probe';
import { expect, test, type Page } from '@playwright/test';

/**
 * Ghost-ink regression specs, on the REAL sim feed: stale pixels must not survive
 * a clear. Four stale-ink classes are pinned here:
 *  - removing the last indicator left its `.indi-canvas` line inked forever;
 *  - turning every overlay off (Price off LAST) could never clear the 2D text
 *    layer, so the last frame's ~130k ghost pixels stayed over the chart;
 *  - `resetForSession()` (the symbol/band-switch teardown) left the text layer
 *    and both gutter canvases inked until the new session's first frame;
 *  - toggling Axes off left the price/time gutter labels (and the price pill).
 *
 * Ink metric = count of pixels with alpha > 8 on the named canvas: `.overlay-text`,
 * `.price-axis .axis-canvas`, `.time-axis .axis-canvas`, `.indi-canvas`. Every
 * wait is a condition poll.
 *
 * Determinism note: the sim universe has exactly
 * ONE symbol (`SIM-DEMO`), so a real palette symbol switch is not available on
 * the sim session; the session-reset spec drives the same `renderer.resetForSession()`
 * path the App uses on a `sessionResetKey` change (also used by
 * session-switch.spec) and measures SYNCHRONOUSLY inside one evaluate — the
 * cleared state is observed in the same JS task the reset runs in, so no live
 * column can slip a first paint in between (race-free).
 */

const INK_SELECTORS = {
  text: '.overlay-text',
  priceGutter: '.price-axis .axis-canvas',
  timeGutter: '.time-axis .axis-canvas',
  indicator: '.indi-canvas',
} as const;

/** Alpha-ink count on a 2D canvas (device pixels; alpha > 8). */
function ink(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!el || el.width === 0 || el.height === 0) return 0;
    const ctx = el.getContext('2d');
    if (!ctx) return 0;
    const d = ctx.getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  }, selector);
}

async function bootSim(page: Page): Promise<void> {
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: LooseProbe }).__flowmapLive;
      if (!live || !live.renderer) return false;
      const range = live.renderer.residentRange();
      return live.store.getState().status === 'live' && range !== null && range.count > 5;
    },
    undefined,
    { timeout: 45_000 },
  );
}

test('removing the last indicator clears .indi-canvas', async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await bootSim(page);

  // Open the picker (`I` — global, guarded for editable/dialog targets) and add EMA.
  await page.keyboard.press('i');
  await expect(page.getByTestId('indi-picker')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('indi-active-empty')).toBeVisible();
  await page.getByTestId('indi-add-ema').click();

  // The EMA line must actually ink the overlay canvas (candles synthesize on sim).
  await expect
    .poll(() => ink(page, INK_SELECTORS.indicator), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Remove it: the canvas must return to ZERO ink (the old build kept the line).
  await page.locator('[data-testid^="indi-remove-"]').first().click();
  await expect(page.getByTestId('indi-active-empty')).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => ink(page, INK_SELECTORS.indicator), { timeout: 10_000 }).toBe(0);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('overlays off (Price last) and Axes off clear the 2D text + gutters', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await bootSim(page);

  // Baseline ink over the live heatmap: text layer + both gutters carry content.
  await expect.poll(() => ink(page, INK_SELECTORS.text), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => ink(page, INK_SELECTORS.priceGutter), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => ink(page, INK_SELECTORS.timeGutter), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Open the settings drawer (the user-reachable overlay toggles live there).
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-drawer')).toBeVisible({ timeout: 5_000 });

  // --- Axes OFF must clear BOTH gutter canvases. -----------------------
  const axes = page.locator('.overlay-toggle[aria-label^="Axes "]');
  await axes.click();
  await expect(axes).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => ink(page, INK_SELECTORS.priceGutter), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => ink(page, INK_SELECTORS.timeGutter), { timeout: 10_000 }).toBe(0);

  // --- Everything else off, then PRICE LAST (worst order). ---------------
  // NOTE: 'Volume' (vol-bars) also paints on the shared text
  // layer, so it belongs to the same all-off contract.
  for (const label of ['Bubbles', 'BBO', 'VWAP', 'CVD', 'Liquidity', 'GEX', 'Markers', 'Volume']) {
    const toggle = page.locator(`.overlay-toggle[aria-label^="${label} "]`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  }
  const price = page.locator('.overlay-toggle[aria-label^="Price "]');
  await price.click();
  await expect(price).toHaveAttribute('aria-pressed', 'false');

  // The text layer must fall to genuine zero — not the historical ~130k ghost.
  await expect.poll(() => ink(page, INK_SELECTORS.text), { timeout: 10_000 }).toBe(0);

  // Sanity: the GL heatmap keeps rendering (ink was a 2D-layer leak, not a freeze).
  const thermal = await page.evaluate(() => {
    const c = document.querySelector('canvas#gl') as HTMLCanvasElement;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 25) n++;
    }
    return n;
  });
  expect(thermal, 'heatmap still renders after all overlays are off').toBeGreaterThan(150);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('session reset clears text + gutters synchronously (resetForSession path)', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // Honest surrogate disclosure: the sim feed exposes only SIM-DEMO, so the
  // palette cannot switch symbols here; `resetForSession()` is exactly the method
  // App calls on a real switch (sessionResetKey effect), and this measures it.
  test.info().annotations.push({
    type: 'surrogate',
    description:
      'sim has a single symbol — the REAL resetForSession() path is driven instead of a palette switch',
  });

  await bootSim(page);

  // Ink present on all three 2D surfaces before the reset.
  await expect.poll(() => ink(page, INK_SELECTORS.text), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => ink(page, INK_SELECTORS.priceGutter), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => ink(page, INK_SELECTORS.timeGutter), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Measure BEFORE, reset, measure AFTER — all in ONE JS task: the synchronous
  // clear is observed before any new column can paint a frame.
  const result = await page.evaluate(() => {
    const probe = (sel: string): number => {
      const el = document.querySelector(sel) as HTMLCanvasElement | null;
      if (!el || el.width === 0 || el.height === 0) return 0;
      const ctx = el.getContext('2d');
      if (!ctx) return 0;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    };
    const r = (window as unknown as { __flowmapLive: LooseProbe }).__flowmapLive.renderer;
    const sels = {
      text: '.overlay-text',
      priceGutter: '.price-axis .axis-canvas',
      timeGutter: '.time-axis .axis-canvas',
    };
    const before = {
      text: probe(sels.text),
      priceGutter: probe(sels.priceGutter),
      timeGutter: probe(sels.timeGutter),
    };
    r.resetForSession();
    const after = {
      text: probe(sels.text),
      priceGutter: probe(sels.priceGutter),
      timeGutter: probe(sels.timeGutter),
    };
    return { before, after };
  });

  expect(result.before.text, 'text layer inked before reset').toBeGreaterThan(0);
  expect(result.before.priceGutter, 'price gutter inked before reset').toBeGreaterThan(0);
  expect(result.before.timeGutter, 'time gutter inked before reset').toBeGreaterThan(0);
  expect(result.after, 'resetForSession must wipe all three 2D layers synchronously').toEqual({
    text: 0,
    priceGutter: 0,
    timeGutter: 0,
  });
});
