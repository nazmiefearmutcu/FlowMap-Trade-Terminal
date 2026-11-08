# FlowMap development guide

Status: current for the code on `main`. Changes not yet in a release are listed in [CHANGELOG.md](../CHANGELOG.md).

## Repository layout

```
app/       Tauri 2 desktop shell (Rust): sidecar lifecycle, bundling scripts,
           platform tauri.<os>.conf.json overrides. See app/README.md.
client/    React 18 + TypeScript + WebGL2 renderer. Vite dev server (:5173)
           connects straight to the server on :8720 (vite injects that origin)
           and proxies /api and /ws there as a same-origin fallback.
  src/gl/      renderer: column textures, SUM-mips, camera, colormaps (gl/lut.ts),
               depth channel modes + renderer stats
  src/input/   gestures.ts (wheel/drag), keys.ts (global keyboard)
  src/net/     connection.ts (WS), history.ts (paged history), serverBase.ts
  src/proto/   decode.ts / encode.ts — TypeScript mirror of the server wire codec
  src/state/   stores: book/tape, settings, alerts, quote feed
  src/theme/   theme registry (7 palettes), CSS-variable tokens
  src/i18n/    EN/TR shell translation (t(), locale persistence)
  src/drawings/  chart annotation model + persistence (2D overlay in src/ui)
  src/indicators/ + src/candles/  indicator kernels, registry, candle synthesis
  src/ui/      top bar, symbol search, DOM ladder, tape, CVD pane, settings,
               measure tool, price alerts, watchlist rail, drawings/indicator
               canvases, ...
  tests/e2e/   Playwright specs, one file per feature area (see "End-to-end"
               below for the list of areas)
  tests/reporters/  CI failure reporter and the e2e skip/flake budget check
server/    Python 3.13 sidecar (FastAPI + uvicorn, asyncio).
  src/flowmap_server/
    api/     REST (/api/health, /api/symbols, /api/venues, /api/universe,
             /api/movers, /api/quote, /api/export) + the binary /ws WebSocket
             (origin gate + connection cap) + _env.py (WS env knobs)
    core/    density grid, sessions, recorder, price scale, backfill, session stats
    data/    bundled symbol universe + venue catalog
    feeds/   sim, crypto (Crocodile), equity, replay, and the router
    proto/   wire.py (binary codec) + events.py (msgspec event types)
  tests/     pytest suite (asyncio_mode=auto, 60 s timeout per test)
docs/       architecture.md, development.md, user-guide.md, release notes,
            the Windows benchmark notes and evidence, design specs
            (superpowers/specs), screenshots (media/)
scripts/    dev.sh, dev-windows.ps1, dev-unix.sh (dev boot), package.sh
            (client production bundle), check_release_versions.py (nine
            version fields), check_doc_links.py (Markdown links and anchors),
            check_dmg_art.py (DMG artwork stamp), check_css_font_sizes.py (raw
            px font-size ratchet for stylesheets), check_process_comments.py
            (no process identifiers in client source comments), validate_release_assets.py
            (publish gate), third_party_notices.py (THIRD-PARTY-NOTICES
            generator), packaged_smoke_windows.py (installed-app smoke test),
            test_*.py (their unit tests, plus test_keyboard_reference.py and
            test_tauri_csp.py), windows-benchmark/ (native benchmark harness)
.github/    workflows:
            ci.yml (every push and every PR to main; release.yml also calls it on
            the tagged commit): client tsc, lint and vitest, the CSS font-size
            ratchet, the process-identifier gate and the production bundle; client
            tsc and vitest on Windows; dependency advisories (npm, pip-audit and
            cargo audit, ubuntu); server pytest on ubuntu and windows, ruff lint
            and mypy on ubuntu; release tooling (version gate, DMG artwork stamp,
            doc links, release-asset validator tests); shell cargo test, clippy and
            fmt on ubuntu (`shell`), cargo test and clippy on Windows (`shell-windows`)
            and macOS (`shell-macos`); full Playwright e2e on ubuntu with a skip/flake
            budget. Documentation-only changes run it too.
            release.yml (tag-triggered: runs ci.yml on the tagged commit, builds
            read-only, then publishes behind the `release` environment with
            attested, checksummed installers). Each platform leg also smoke-tests the
            installed app (`scripts/packaged_smoke_windows.py` on Windows,
            `scripts/packaged_smoke_posix.py` on macOS and Linux).
            windows-benchmark.yml (weekly, Mondays, and on demand: benchmark
            harness unit tests, Python and Node, on Windows)
            browser-diagnostics.yml (manual dispatch: diagnoses one chosen browser
            suite)
            macos-runtime-audit.yml (manual dispatch: macOS Intel runtime audit)
```

## Dev environment

- Python 3.13 + [uv](https://docs.astral.sh/uv/) — `cd server && uv sync` creates the venv and
  installs runtime + dev dependencies (the market-data engine `crocodile` is a vendored wheel in
  `server/vendor/`, declared as a path source in `server/pyproject.toml` and locked by sha256 in
  `server/uv.lock`).
- Node.js 22.13+ (or 24) + npm — `cd client && npm install`.
- Rust 1.89 or newer ([rustup](https://rustup.rs)) — only for the desktop shell's tests in `app/src-tauri`. The client and the server do not need it.
- One-shot boot: `./scripts/dev.sh` (bash), `bash scripts/dev-unix.sh` (no uv required if a
  Python 3.13 is on PATH), or `powershell -File scripts/dev-windows.ps1` (PowerShell 5.1+).
  Helpers start the server on `FLOWMAP_PORT=8720` with recording disabled, then vite.
- Windows note: vite can fail when the project path contains non-ASCII characters; the PowerShell
  helper resolves the repo's real path first. Prefer an ASCII-only checkout path.

## Tests

```bash
# the one local check CI runs for the client (typecheck, lint budget, unit tests)
cd client && npm run verify
# or the parts separately:
npm test                           # = vitest run; npm run test:watch for watch mode
npx tsc -b                         # strict typecheck across client tsconfig projects
npm run lint                       # eslint flat config; --max-warnings caps the warning count
                                   # (also rejects raw px font sizes, hex and rgb() literals
                                   # in client/src TS/TSX outside src/theme)
python3 scripts/check_css_font_sizes.py   # ratchet on raw px font sizes in client/src/**/*.css
npm run build                      # production bundle proof (tsc -b && vite build)

# server tests
cd server && uv sync && uv run pytest -q
uv run ruff check .                # lint (ruff)
# without uv, from the repo root:
PYTHONPATH=server/src pytest server/tests -q

# Tauri shell tests (Rust; Linux needs the Tauri system deps — copy the apt list
# from .github/workflows/ci.yml's shell job)
cd app/src-tauri && cargo test
```

pytest is configured in `server/pyproject.toml` (`asyncio_mode = "auto"`,
`timeout = 60`, `testpaths = ["tests"]`), so running `pytest server/tests` from the repo root
still picks the config up (rootdir resolves to `server/`). Dev dependencies if you install them
manually: `pytest`, `pytest-asyncio`, `pytest-timeout`, `httpx`, `websockets`, plus the runtime
imports (`fastapi`, `uvicorn`, `msgspec`, `numpy`, `polars`, `aiohttp`, `certifi`, and `crocodile`
from the vendored wheel).

## End-to-end (Playwright)

```bash
cd client
npx playwright install chromium    # one-time browser download
npm run e2e                        # = npx playwright test
# Windows PowerShell blocks npx.ps1 — use the cmd shim instead:
cmd /c "npx playwright test"
```

Each spec file in `client/tests/e2e/` covers one feature area. The areas include the heatmap, live
simulation, equity, parity, performance, scrollback, tail columns, price and time axes, overlays,
panels, normalization, session switching, the shell, mips, the first-run tour, chart follow, chart
reconstruction and clearing, history overview, terminal workspace, the view
worker, volume motion and symbol quantities. `features` covers drawings persistence, alert firing,
theme and locale flips, watchlist switching and replay refusal. `gl4` covers tick grouping, deep
time-zoom mips, imbalance pixels and context-loss follow intent. The directory listing is the
authoritative set.

Prerequisites and behavior (from `client/playwright.config.ts`):

- **`uv` must be on your PATH** — the config boots the real stack for you via two `webServer`
  entries: the actual `flowmap_server` (`uv run python -m flowmap_server`, cwd `server/`) and
  the vite dev server. You do not need to boot anything yourself, but the server entry resolves
  `uv` from PATH.
- **Server boot env for e2e**: `FLOWMAP_PORT=8720`, `FLOWMAP_RECORDING_ENABLED=0` (e2e never
  touches disk or rehydrates a stale tail), `FLOWMAP_LOG_LEVEL=warning`, and
  `FLOWMAP_DT_CRYPTO_NS=25000000` — a 25 ms sim cadence (40 columns/s) so scroll-back specs
  overrun the client's full-res budget in seconds instead of minutes.
- **`reuseExistingServer` is enabled when `CI` is unset**: a manually booted server on `:8720`
  (or vite on `:5173`) will be reused, which speeds up local iteration. In CI it always boots
  fresh servers.
- **CI serializes the suite**: `workers: process.env.CI ? 1 : undefined` — two concurrent
  canvas-heavy specs starve each other's CPU on SwiftShader and trip the perf spec's honest
  thresholds. Locally the suite stays parallel; CI also retries twice (`retries: 2`).
- **Onboarding/theme storage state** is seeded for every browser context
  (`tests/e2e/onboarded-state.json`: `flowmap.onboarded=1`, `flowmap.theme=midnight`) — the
  first-run tour's scrim would otherwise swallow the first pointer/wheel interaction.
- **First-run project**: `tests/e2e/first-run.spec.ts` runs in the `first-run` project, whose context
  has no seeded onboarding flag, so the tour is tested the way a new user meets it.
- **Skip and flake budget**: the CI e2e job runs `tests/reporters/checkBudget.mjs` against
  `tests/reporters/e2e-budget.json`. The job fails when skipped or flaky tests exceed the budget, and
  it prints every skipped and flaky title. Change the budget only with a reviewed reason.
- **Perf checks**: `perf.spec.ts` reports frame rate and frame interval and annotates them against advisory
  floors (30 fps on SwiftShader, 32 ms p95 frame interval), because a shared runner cannot assert them stably.
  The blocking checks are the console-error check, the real-input check, the history-independence ratio of
  draw cost (the 10k-column p10 draw at most 2.0 times the 200-column p10, plus 1.5 ms) and the 300 MB ring
  memory bound.
- The replay transport's positive path needs a recording, which the default e2e server does not
  make, so that spec is one of the counted skips.
- vite is pinned to `--host 127.0.0.1` (vite otherwise binds `[::1]` only, which the IPv4
  readiness URL cannot reach).
- Headless WebGL2 works: Chromium is launched with ANGLE→SwiftShader
  (`--use-angle=swiftshader --enable-unsafe-swiftshader`), so heatmap specs render on GPU-less
  CI runners.
- **CI job**: `e2e` (ubuntu, 30-minute timeout) in `.github/workflows/ci.yml` installs
  Playwright chromium with system deps, runs `uv sync --frozen` in `server/`, then
  `npx playwright test` with `CI=1`. The advisory fps and frame-interval annotations are the noisiest
  numbers on shared runners. The blocking perf checks are the ratio and memory gates.

## Release / packaging outline

The desktop app is built per-OS (native Python wheels cannot be cross-built); CI
(`.github/workflows/release.yml`) produces the installers, `THIRD-PARTY-NOTICES.txt`, `SHA256SUMS`, and SLSA build-provenance
attestations. Manual outline (from `app/README.md` — read it before building):

1. Build the client bundle (`cd client && npm run build` — runs `tsc -b && vite build`).
2. Build the relocatable Python runtime ("pyruntime", python-build-standalone) for the target
   triple: `app/scripts/bundle-python.sh`.
3. Build the shell: `cargo tauri build` in `app/src-tauri` with the platform config
   (`tauri.<platform>.conf.json` is merged over `tauri.conf.json` by the Tauri CLI). macOS has a
   full pipeline in `app/scripts/build-dmg.sh`. `app/icons/dmg/make-bg.py` renders the DMG
   background from the bundled JetBrains Mono font on any OS. `scripts/check_dmg_art.py` in CI
   fails when `app/icons/dmg/RENDERED_VERSION` does not match the app version.
4. The bundle embeds client assets + pyruntime + the Python dependencies. Nothing is fetched at
   first run.

Secrets policy: no signing certificates exist for this project (installers are ad-hoc/unsigned;
the attestation is the integrity story), and feed credentials (`ALPACA_API_KEY`/`ALPACA_API_SECRET`,
`FINNHUB_API_KEY`) are **runtime** environment variables read by the server process — they are
never build inputs and never embedded in any artifact.

Local iteration never needs a packaging step: `npm run dev` plus the test commands above cover
day-to-day work; reserve `vite build` / `tauri build` / `cargo` for actual release builds.
