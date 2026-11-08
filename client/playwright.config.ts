import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// Absolute path to the Python server package (sibling of client/), resolved
// through the flowmap symlink so `uv run` finds the project regardless of cwd.
const SERVER_DIR = fileURLToPath(new URL('../server', import.meta.url));

// E2E config. Two webServers boot together: the real flowmap-server (Python) and
// the vite dev server. The live-sim spec drives the sim feed end-to-end through
// this stack; the heatmap spec uses the synthetic window.__flowmapTest hook and
// needs only vite.
// The default ports are 8720 (server, the port vite proxies to) and 5173 (client).
// FLOWMAP_DEV_SERVER_PORT and FLOWMAP_DEV_CLIENT_PORT move both, so a second run
// can share the machine with a manual dev stack. vite.config.ts reads the same
// variables. The server's CORS policy accepts any loopback origin, so a second client port needs no server change.
const SERVER_PORT = process.env.FLOWMAP_DEV_SERVER_PORT ?? '8720';
const CLIENT_PORT = process.env.FLOWMAP_DEV_CLIENT_PORT ?? '5173';

// WebGL2 must actually render in headless CI. Force ANGLE→SwiftShader
// (software GL) so the heatmap renders even without a real GPU; the
// unsafe-swiftshader flag opts into SwiftShader WebGL on recent Chromium.
const chromiumUse = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  },
};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // In CI the WebGL specs run on SwiftShader (software GL); two concurrently
  // running canvas-heavy specs starve each other's CPU. Serialize in CI for
  // determinism; local stays parallel.
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${CLIENT_PORT}`,
    trace: 'on-first-retry',
    // The first-run onboarding card auto-opens on a fresh context
    // (every Playwright test) and its full-viewport scrim swallows the first
    // pointer/wheel interaction, turning unrelated specs red. Seed the
    // ONBOARDING_KEY dismissal centrally for every context; onboarding itself
    // is covered by its unit tests. The state ALSO pins `flowmap.theme=midnight`
    // so specs start on the documented dark default instead of the first-run
    // prefers-color-scheme resolution (headless Chromium reports light → paper),
    // which would otherwise make color-asserting specs environment-dependent.
    storageState: fileURLToPath(new URL('./tests/e2e/onboarded-state.json', import.meta.url)),
  },
  projects: [
    {
      // Every spec except the first-run path starts post-onboarding (storageState above).
      name: 'chromium',
      testIgnore: /first-run\.spec\.ts$/,
      use: chromiumUse,
    },
    {
      // The first-run path: a fresh context with NO seeded onboarding flag, so
      // the wizard opens exactly as it does for a new user.
      name: 'first-run',
      testMatch: /first-run\.spec\.ts$/,
      use: { ...chromiumUse, storageState: { cookies: [], origins: [] } },
    },
  ],
  webServer: [
    {
      // Real flowmap-server with the REALTIME sim feed (4 finalized cols/s).
      // Recording disabled so the e2e never touches disk or rehydrates a stale
      // tail. reuseExistingServer lets a manually-booted server on the port serve.
      command: 'uv run python -m flowmap_server',
      cwd: SERVER_DIR,
      env: {
        FLOWMAP_PORT: SERVER_PORT,
        FLOWMAP_RECORDING_ENABLED: '0',
        FLOWMAP_LOG_LEVEL: 'warning',
        // Fast sim cadence (25 ms → 40 cols/s) so the scroll-back spec overruns
        // the client's full-res budget in seconds instead of minutes. Other specs
        // only benefit (more columns, faster live scroll).
        FLOWMAP_DT_CRYPTO_NS: '25000000',
      },
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Pin to IPv4 — vite otherwise binds [::1] only, which the 127.0.0.1
      // baseURL/url below cannot reach (webServer readiness would time out).
      // --strictPort: fail rather than silently move to another port.
      command: `npm run dev -- --host 127.0.0.1 --port ${CLIENT_PORT} --strictPort`,
      env: {
        FLOWMAP_DEV_SERVER_PORT: SERVER_PORT,
        FLOWMAP_DEV_CLIENT_PORT: CLIENT_PORT,
      },
      url: `http://127.0.0.1:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
