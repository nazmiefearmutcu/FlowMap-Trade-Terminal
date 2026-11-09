# FlowMap desktop shell — macOS · Windows · Linux

A double-clickable desktop app that bundles the FlowMap WebGL2 client **and** the
FlowMap Python server, so there is nothing for the user to install — no Python,
no Node, no `uv`. It is a [Tauri 2](https://tauri.app) shell (Rust + the OS-native
webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) that:

1. picks a free loopback TCP port;
2. spawns a **bundled, relocatable Python 3.13** running `flowmap_server` on that
   port as a sidecar (recording under the app-data dir);
3. injects `window.__FLOWMAP_SERVER__ = "http://127.0.0.1:<port>"` and a
   per-launch session token, `window.__FLOWMAP_SESSION_TOKEN__` (256 random
   bits, sent to the sidecar in `FLOWMAP_SESSION_TOKEN`), into the webview before
   the client loads, so the SPA reaches the sidecar. The token is sent only to the
   process that owns the port, checked against the OS listener table (see
   `src/listener.rs`);
4. stops the sidecar on quit gracefully: its stdin is closed (EOF is the stop
   signal the server acts on, because the shell sets `FLOWMAP_EXIT_ON_STDIN_EOF=1`),
   then SIGTERM on unix, then a kill after 12 s, so the server's flush runs (its
   recording drain is bounded at 10 s). A kill at that point is logged to
   `shell.log`. Closing the window can take up to 12 s on a wedged disk. The
   sidecar also dies with the shell: Linux via a parent-death signal, macOS via
   that stdin EOF, and Windows via a kill-on-close job object;
5. supervises the sidecar: a crash or a server that stops answering
   `/api/health` (3 failed probes) is restarted with exponential backoff (1 s to
   30 s, 5 attempts, refilled after 60 s of health). The port is free while the
   sidecar is down, so a restarted sidecar must pass the same OS listener check
   before the shell reports it live. When the budget is spent the
   window shows the failure and offers Retry (`retry_sidecar` command). Only a
   Retry refills the budget. A Settings change that needs a new sidecar restarts
   only a sidecar that runs with the other value, and a restart already under way
   is not repeated for a queued command. A restart the user asks for (Retry or a
   Settings change) stops the old sidecar with the same 12 s grace as a quit; an
   automatic restart of a crashed or silent sidecar waits 3 s before the kill.

The sidecar inherits only an allowlisted set of environment variables
(`src/sidecar.rs`), so a `FLOWMAP_*` variable in the user's shell does not reach it.
The market-data keys `ALPACA_API_KEY`, `ALPACA_API_SECRET` and `FINNHUB_API_KEY` are
on that list, so the installed app passes them to the server as a source run does.

## Layout

```
app/
  icons/                     hand-authored source icon (flowmap.svg, .icns, PNGs)
    dmg/                     DMG install-window art + make-bg.py (+ RENDERED_VERSION)
  scripts/
    bundle-python.sh         builds the relocatable pyruntime for a target triple
                             (astral python-build-standalone) — macOS/Windows/Linux
    build-dmg.sh             macOS pipeline: client → pyruntime → tauri build → sign → dmg
    import-gate.py           imports every server dependency from the bundled interpreter
    requirements_pins.py     win-arm64 exceptions and the --require-hashes guard (tests/)
    macos-runtime-minimum.py derives the macOS minimum from the runtime's Mach-O files
    audit-macos-cryptography.py rejects cryptography bindings that need non-system libraries
  src-tauri/
    tauri.conf.json          base product/identifier/version + bundle config (macOS-oriented)
    tauri.windows.conf.json  Windows overrides: msi/nsis targets + pyruntime as a resource
    tauri.linux.conf.json    Linux overrides: deb/appimage targets + deb deps + resource
    tauri.benchmark.conf.json  benchmark harness identity: own identifier, no installer
    Cargo.toml               Rust deps (tauri 2; libc only on unix); rust-version 1.89
    build.rs                 lists the app commands the webview may call (AppManifest)
    src/main.rs              setup order, the window, the settings commands, the app-data dir
    src/sidecar.rs           spawning and stopping the sidecar process (env allowlist, job object)
    src/supervisor.rs        health probes, restart policy and backoff, sidecar-status events
    src/instance_lock.rs     single-instance lock on flowmap.lock and the "already running" hand-off
    src/native_dialog.rs     native error dialogs (Win32 message box, osascript, zenity, kdialog, notify-send)
    src/listener.rs          proves the port's listener is the sidecar before the token is sent
    src/redact.rs            masks session tokens in the sidecar log
    src/server_log.rs        the sidecar log: first-spawn rotation, respawn separator, size cap
    src/dialog_text.rs       native dialog text and the OS-locale choice (EN/TR)
    src/window_state.rs      saved window placement and its monitor check
    src/recording.rs         the recording switch in recording.json
    capabilities/default.json  the window's permissions: core, plus the five shell commands
    icons/                   tauri icon set, generated by `cargo tauri icon` and committed
    windows/hooks.nsi        NSIS installer hooks (uninstall asks before deleting app data)
    resources/LICENSE        Apache-2.0 texts, copies of the repo root files; installers ship them
    resources/NOTICE
    resources/pyruntime/     the bundled Python (gitignored — ~529 MB)
```

The `tauri.<platform>.conf.json` files are **merged over** `tauri.conf.json` by
the Tauri CLI (RFC 7396 JSON Merge Patch) when building on that platform. The
base config carries only the Apache-2.0 texts in `bundle.resources`, so the macOS
`build-dmg.sh` injects the pyruntime with `ditto` (symlink-preserving) instead of
Tauri copying the ~529 MB tree twice; Windows/Linux declare `resources` in their
platform file so Tauri embeds the pyruntime natively.

The bundled `pyruntime/`, the Rust `target/` and the built installers are
**gitignored** (large binaries). The icon set is committed so a clean clone
builds. Installers ship via the GitHub Release, not git.

### Content Security Policy and the loopback API

`tauri.conf.json` sets a CSP: scripts and fonts only from `'self'`, workers from
`'self'` and `blob:`, styles from `'self'` and inline styles (`'unsafe-inline'`), no
`eval`, no remote origin; media, frames, plugins and form
submissions are `'none'`; network connections go only to Tauri IPC and to
`127.0.0.1` over HTTP and WebSocket. The sidecar's port is picked at each launch,
so the loopback rule allows any port on `127.0.0.1`; the session token and the
`Host` check are what limit it. `scripts/test_tauri_csp.py` pins these directives
and fails if a remote origin appears in the client. The shell passes a per-launch
session token to the sidecar and the webview. The webview sends it in the
`X-FlowMap-Token` header on HTTP, and in the offered WebSocket subprotocol
`flowmap.auth.<token>`, so the webview's WebSocket URL never carries it. The sidecar
requires it on HTTP and WebSocket, except `GET /api/health`, and refuses a `Host`
header that is not a loopback name (server `api/app.py`). The server also accepts
a `token=` query for tools, and its logs redact it. The main window may navigate
only to the app's own origin (`tauri://localhost`, or `http://tauri.localhost` on
Windows); any other navigation is refused.

## Versioning

`tauri.conf.json`'s `version` is the **single source**. `build-dmg.sh` reads it
rather than carrying a copy (it once carried a stale one, and named a disk image
for the wrong release). The DMG install window is the one place the version
becomes *pixels*, so `app/icons/dmg/make-bg.py <version> --all` regenerates the
plate and stamps `RENDERED_VERSION` beside it; `build-dmg.sh` refuses to build
when that stamp and the config disagree. Bumping a release means editing
`tauri.conf.json`, `Cargo.toml`(+`.lock`), `server/pyproject.toml`(+`uv.lock`),
`flowmap_server/__init__.py`, `client/package.json`(+`.lock`), then rerunning
`make-bg.py`.

**Current state:** the committed DMG artwork is stamped `1.6.0`
(`app/icons/dmg/RENDERED_VERSION`), the same version as `tauri.conf.json`, so
`scripts/check_dmg_art.py` passes. `make-bg.py` sets its text in the JetBrains Mono
files the app ships (`client/src/assets/fonts`), so a render needs only Python with
Pillow, on any OS, and no system font. Rerun `make-bg.py <version> --all` when the
version changes, and commit the PNGs with `RENDERED_VERSION`; the stamp is written
by the script and not edited by hand. The first-run line in `make-bg.py` carries the
macOS 15 wording (System Settings → Privacy & Security → Open Anyway), the same words
as the first-run section below and `build-dmg.sh`.

## Build

### macOS (local, one command)

```bash
# from the repo root — client → pyruntime → tauri build → ad-hoc sign → dmg:
bash app/scripts/build-dmg.sh
```

It is **arch-aware** (`uname -m`): produces `FlowMap_<version>_aarch64.dmg` on
Apple Silicon and `FlowMap_<version>_x86_64.dmg` on Intel, where `<version>` is
the `version` in `tauri.conf.json`. Outputs:

- `app/src-tauri/target/release/bundle/macos/FlowMap.app`
- `app/src-tauri/target/release/bundle/dmg/FlowMap_<version>_<arch>.dmg`

Note: local builds keep the bundle-version name (`FlowMap_<version>_<arch>.dmg`).
CI names installers `FlowMap_<version>_<suffix>` with no leading `v`, from the
release tag `vX.Y.Z`, before uploading.

Requires: Rust 1.89 or newer (the single-instance guard uses `File::try_lock`),
`cargo-tauri` (`cargo install tauri-cli --version 2.11.5 --locked`, the version
the release and CI use and `Cargo.lock` locks), Node/npm, `uv`,
and the macOS `codesign`/`hdiutil`/`sips`/`iconutil` tools.

### Windows / Linux (or all three via CI)

Native Python wheels (numpy/polars/…) can't be cross-built, so each OS's
installer is produced on its own runner. Per platform:

```bash
cd client && npm ci                                          # 1. client dependencies
bash app/scripts/bundle-python.sh <target-triple>            # 2. pyruntime
cd app/src-tauri && cargo tauri build                        # 3. client build + installers
```

Run these from the repository root. On Windows, run them in Git-Bash. The tools
they need must be on `PATH`: Node and npm, `uv` (step 2 exports the locked
requirements with `uv export`), and Rust 1.89 or newer with the Tauri CLI version
that CI and `Cargo.lock` pin: `cargo install tauri-cli --version 2.11.5 --locked`.

`cargo tauri build` runs `beforeBuildCommand` (`npm --prefix ../../client run
build`), so the client is always rebuilt and never a stale `client/dist` is
packaged. Step 2 is still required: the Windows and Linux configs declare
`resources/pyruntime/`, and `cargo check`/`cargo test` need that directory to
exist. Icons need no separate step.

`bundle-python.sh` looks up the python-build-standalone release over the GitHub
API. A CI job that has a token can fetch that JSON once and pass its path as
`FLOWMAP_PBS_RELEASE_JSON`, so the build itself needs no anonymous API call.

`<target-triple>` ∈ `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`,
`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`,
`aarch64-apple-darwin` (default). On Windows run `bundle-python.sh` under
**Git-Bash**. Outputs land in `app/src-tauri/target/release/bundle/{msi,nsis,deb,appimage}/`,
named for the arch: `FlowMap_<version>_x64-setup.exe` and
`FlowMap_<version>_x64_en-US.msi` on Intel/AMD, and the `arm64` names on ARM.

The NSIS installer is English by default and offers Turkish with a language
selector. The MSI is English-only: Tauri builds one MSI per WiX language, so a
Turkish MSI would be a second installer per architecture, and the release asset
list (`scripts/validate_release_assets.py`) names one MSI per architecture.

The MSI uninstall does not prompt. It removes the program files and keeps the
recordings and logs in the app-data folder. The NSIS uninstaller asks first and
keeps them unless the user asks for deletion (`windows/hooks.nsi`).

`.github/workflows/release.yml` does exactly this across a `macos-15` (arm),
`macos-15-intel`, `windows-latest` (x64), `windows-11-arm` (ARM64) and
`ubuntu-22.04` matrix on every `vX.Y.Z` tag (hotfixes are patch versions), smoke-tests
each bundle's server (`/api/health`), reports each installer's size to the job
summary, and attaches the installers and `THIRD-PARTY-NOTICES.txt` to the GitHub
Release. The two Windows legs also install what they built and run
`scripts/packaged_smoke_windows.py`: the installed app must answer `/api/health`,
refuse a foreign `Host` and an unauthenticated request, close on WM_CLOSE, and leave
no python process from its runtime behind. `scripts/packaged_smoke_posix.py` runs the
same loopback checks on the macOS legs (the DMG's `FlowMap.app`) and on the Linux legs
(the `.deb` and the AppImage). Every leg is a **native** build — the Python wheels are
platform-specific and cannot be cross-built.

### Windows on ARM: the dependency exceptions

71 of the 75 locked distributions publish a `win_arm64` wheel. Four do not, and
`bundle-python.sh` handles them with a fail-loud exception list applied only to
`aarch64-pc-windows-msvc` (the table also lists `uvloop`, which its own Windows
marker already excludes):

| package | why it has no ARM64 wheel path | what the ARM64 bundle does |
|---|---|---|
| `pyarrow` | no `win_arm64` wheel in any release; from-sdist means building Arrow C++ | dropped — reachable only via crocodile's Arrow-IPC export helpers, which FlowMap never imports (recording is polars, whose parquet codec is native Rust) |
| `zlib-ng`, `aiohttp-fast-zlib` | no `win_arm64` wheel | dropped — a ccxt decompression speed-up imported inside `try/except ImportError`; ARM64 uses stdlib zlib |
| `cryptography` | 47.0.0 onward ship `win_amd64`/`win32` only | pinned back to **46.0.3**, the last release with a `win_arm64` wheel — not droppable, ccxt imports it eagerly, and only long-stable hazmat primitives are used |
| `uvloop` | n/a | already excluded by its own marker on Windows |

Because the exported lock is a complete closure, this leg installs with
`--no-deps` (otherwise pip would re-resolve and undo the exceptions) and
`--require-hashes`: the export keeps the sha256 of every artifact, the re-pinned
`cryptography` takes the hashes PyPI publishes for 46.0.3, and a guard stops the
build if any requirement line lacks a hash. The
import gate in step 5 of `bundle-python.sh` is what proves the resulting tree is
sound; it is told which module to skip rather than being weakened. If a dropped
name leaves the lock, or `cryptography`'s locked version moves off 49.0.0, the
build **fails** rather than silently shipping something the table above no
longer describes.

## First run (unsigned / unnotarized)

No paid code-signing identity (Apple Developer ID / Windows publisher cert) is
available, so the bundles are **ad-hoc / unsigned** — the OS warns on first
launch:

- **macOS 15 or later:** open FlowMap once (it is blocked), then open
  **System Settings → Privacy & Security** and choose **Open Anyway** next to
  FlowMap. The right-click → Open bypass no longer works there. On older macOS,
  right-click **FlowMap.app → Open**. Or clear the quarantine attribute with
  `xattr -cr /Applications/FlowMap.app`.
- **Windows:** SmartScreen → **More info → Run anyway**.
- **Linux:** no signature prompt; the AppImage needs `libwebkit2gtk-4.1`,
  `libgtk-3` and `libayatana-appindicator3` present (the `.deb` declares them).

This is a consequence of the missing certificates, not a bug. Notarization is out
of scope.

## Run from source (alternative)

If you prefer not to use the DMG (or aren't on Apple Silicon macOS), run from
source — see the repo root `README.md` and the repo root `scripts/dev.sh`
(`scripts/dev-windows.ps1` on Windows).

## Diagnostics

The shell writes its own lifecycle log to `shell.log` in the app-data dir
(Windows: `%APPDATA%\com.nazmiefearmutcu.flowmap`), because release Windows
builds have no console. The sidecar's stdout and stderr go to
`flowmap-server.log` in the same folder, with session tokens masked. Each launch moves the
previous run's log to `flowmap-server.previous.log`, so a crash traceback survives the
relaunch. The server log is moved aside to `flowmap-server.previous.log` once it
passes 20 MB. The shell log is moved aside at startup once it passes 1 MB. On Linux
a startup failure is shown with zenity, kdialog or notify-send; when none of them is
installed, the message is only in `shell.log`.
The webview can open this folder with the `open_log_folder` command.

Two small files in the same folder keep the user's choices across launches:

- `recording.json` holds the recording switch as `{"enabled": true}` or
  `{"enabled": false}`. The file is absent on a fresh install, and an absent,
  unreadable or malformed file means recording is on. The shell's
  `set_recording_enabled` command rewrites it while the app runs and restarts the
  sidecar at once. The Settings drawer shows the switch in the desktop app and
  calls that command; the file can also be edited before launch, and the shell
  reads it at launch. The recording size cap is 20 GB and is passed to the server
  on every start (`FLOWMAP_RECORDING_GB_CAP`).
- `window-state.json` holds the last window size and position. It is ignored when
  the saved title bar is on no connected monitor, and the window is centred then.

Debug builds only: set `FLOWMAP_DEV_SIDECAR_PORT=<port>` to attach the window to
a server you started yourself (`python -m flowmap_server` on that port) instead
of spawning the bundled one. No session token is injected in that mode.
