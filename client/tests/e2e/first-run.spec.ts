import { expect, test } from '@playwright/test';

/**
 * First-run path. Runs in the `first-run` Playwright project, whose context has
 * NO seeded `flowmap.onboarded` flag (playwright.config.ts), so these specs see
 * the same wizard a new user sees. Every other spec is post-onboarding.
 */

const MAX_STEPS = 12;

test.describe('first run', () => {
  test('the onboarding card opens on a fresh context', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByTestId('onboarding-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('onboarding-step-of')).toBeVisible();
    await expect(page.getByTestId('onboarding-body')).not.toBeEmpty();
  });

  test('stepping through the tour completes it and stays dismissed', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByTestId('onboarding-dialog');
    await expect(dialog).toBeVisible();

    // Bounded: the tour has a fixed, small number of steps; the last button reads Done.
    for (let step = 0; step < MAX_STEPS && (await dialog.isVisible()); step += 1) {
      await page.getByTestId('onboarding-next').click();
    }
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('flowmap.onboarded')))
      .toBe('1');

    await page.reload();
    await expect(page.getByTestId('onboarding-dialog')).toBeHidden();
  });

  test('skip dismisses the card without blocking the chart', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('onboarding-dialog')).toBeVisible();
    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding-dialog')).toBeHidden();
    // The scrim is what would swallow pointer input; once skipped it must be gone.
    await expect(page.getByTestId('onboarding-scrim')).toHaveCount(0);
  });
});
