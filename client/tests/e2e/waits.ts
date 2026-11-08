import type { Page } from '@playwright/test';

/**
 * Resolve after `frames` rendered animation frames. A frame count is a work-based
 * wait: it lets the renderer paint a few dirty frames without a wall-clock sleep,
 * so it scales with a slow SwiftShader host instead of racing it.
 */
export async function waitFrames(page: Page, frames = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}
