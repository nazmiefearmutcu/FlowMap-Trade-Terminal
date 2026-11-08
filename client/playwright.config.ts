import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// Absolute path to the Python server package (sibling of client/), resolved
// through the flowmap symlink so `uv run` finds the project regardless of cwd.
const SERVER_DIR = fileURLToPath(new URL('../server', import.meta.url));

// E2E config. Two stacks boot together: the real flowmap-server (Python) and the
// vite dev server, and a second pair on other ports for the replay project. The
// live-sim spec drives the sim feed end-to-end through the default stack; the heatmap
// spec uses the synthetic window.__flowmapTest hook and needs only vite.
// The default ports are 8720 (server, the port vite proxies to) and 5173 (client).
// FLOWMAP_DEV_SERVER_PORT and FLOWMAP_DEV_CLIENT_PORT move both, so a second run
// can share the machine with a manual dev stack. vite.config.ts reads the same
// variables. The server's CORS policy accepts any loopback origin, so a second client port needs no server change.
const SERVER_PORT = process.env.FLOWMAP_DEV_SERVER_PORT ?? '8720';
const CLIENT_PORT = process.env.FLOWMAP_DEV_CLIENT_PORT ?? '5173';

// The replay project runs its own stack: a recording-enabled server on 8721 writes
// its recordings into a temporary data dir, and the vite dev server on 5174 proxies
// to it. The variable is set here, before the workers start, so every worker reads
// the same directory. The recordings come from the server's own recorder, fed by
// its sim feed; the replay-transport test waits until they are listed.
const REPLAY_SERVER_PORT = process.env.FLOWMAP_E2E_REPLAY_SERVER_PORT ?? '8721';
const REPLAY_CLIENT_PORT = process.env.FLOWMAP_E2E_REPLAY_CLIENT_PORT ?? '5174';
process.env.FLOWMAP_E2E_REPLAY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'flowmap-e2e-replay-'));
const REPLAY_DATA_DIR = process.env.FLOWMAP_E2E_REPLAY_DATA_DIR;
// The one spec that needs a recording; it runs only in the replay project.
const REPLAY_TRANSPORT = /replay transport controls/;

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

// Playwright matches a seeded localStorage entry by its exact origin, so the seed is
// rewritten for this run's client port. A run on another port would otherwise open
// the first-run wizard, whose scrim intercepts the first click.
const onboardedState = JSON.parse(readFileSync(fileURLToPath(new URL('./tests/e2e/onboarded-state.json', import.meta.url)), 'utf8')) as
  { cookies: []; origins: { origin: string; localStorage: { name: string; value: string }[] }[] };
onboardedState.origins = onboardedState.origins.map(entry => ({ ...entry, origin: `http://127.0.0.1:${CLIENT_PORT}` }));

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
    storageState: onboardedState,
  },
  projects: [
    {
      // Every spec except the first-run path starts post-onboarding (storageState above).
      // The recording-dependent replay transport test belongs to the replay project.
      name: 'chromium',
      testIgnore: /first-run\.spec\.ts$/,
      grepInvert: REPLAY_TRANSPORT,
      use: chromiumUse,
    },
    {
      // The first-run path: a fresh context with NO seeded onboarding flag, so
      // the wizard opens exactly as it does for a new user.
      name: 'first-run',
      testMatch: /first-run\.spec\.ts$/,
      use: { ...chromiumUse, storageState: { cookies: [], origins: [] } },
    },
    {
      // Replay transport against recordings the replay server wrote itself. Its
      // own stack (ports 8721/5174) keeps the recording switch on without changing
      // the default stack, which records nothing.
      name: 'replay',
      testMatch: /shell\.spec\.ts$/,
      grep: REPLAY_TRANSPORT,
      use: { ...chromiumUse, baseURL: `http://127.0.0.1:${REPLAY_CLIENT_PORT}` },
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
      // Replay stack: the same sim feed, recording on, into the temporary data dir.
      command: 'uv run python -m flowmap_server',
      cwd: SERVER_DIR,
      env: {
        FLOWMAP_PORT: REPLAY_SERVER_PORT,
        FLOWMAP_RECORDING_ENABLED: '1',
        FLOWMAP_DATA_DIR: REPLAY_DATA_DIR,
        FLOWMAP_LOG_LEVEL: 'warning',
        FLOWMAP_DT_CRYPTO_NS: '25000000',
      },
      url: `http://127.0.0.1:${REPLAY_SERVER_PORT}/api/health`,
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
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${REPLAY_CLIENT_PORT} --strictPort`,
      env: {
        FLOWMAP_DEV_SERVER_PORT: REPLAY_SERVER_PORT,
        FLOWMAP_DEV_CLIENT_PORT: REPLAY_CLIENT_PORT,
      },
      url: `http://127.0.0.1:${REPLAY_CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
