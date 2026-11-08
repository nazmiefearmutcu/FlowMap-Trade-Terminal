# FlowMap 1.6.0

FlowMap 1.6.0 is a release-quality and security pass on 1.5.1. It adds a per-launch session token for the installed app's local API, new Settings switches for recording, chart style and single-key shortcuts, clearer chart and capability indicators, and a fuller set of licence and security documents. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **Local API protection.** The installed app creates a new 32-byte session token at each launch and gives it only to its own window. Every request must carry a loopback `Host` header and, except the health check and CORS preflight, the token. A WebSocket connection must offer the token too. Source runs are unchanged.
- **Recording.** Recording is on by default in the installed app. Settings > Data > *Record market data* turns it off or on. The choice is saved to `recording.json`. A running engine restarts at once, so the change applies immediately; otherwise it applies at the next launch.
- **Recording health.** When a recording write stays unfinished for 30 seconds or more, the top bar shows a *recording stalled* notice. Recording is not turned off automatically, and the notice clears when the write completes.
- **Chart style.** Settings > Display > *Chart style* chooses *Normal* (the smooth heatmap, the default) or *Pixel* (blocks in the theme colours).
- **Capability chips.** A simulated feed shows a `SIM` chip. A replay keeps its real depth tier and adds `RECORDED DENSITY`, so a recorded keyless equity session reads `SYNTH` with `RECORDED DENSITY` beside it.
- **Price zoom keys.** `]` and `[` zoom the price axis in and out while the chart has focus.
- **Candles and indicators** restart after each reconnect, so a gap in the feed is never bridged with stale bars.
- **Drawings.** New drawings start in teal (`#2a8f7e`, previously `#33d6c4`). The toolbar's swatches are darker hues, so every ink keeps at least 3:1 contrast against light chart grounds.
- **Market-data keys.** The installed app passes `ALPACA_API_KEY`, `ALPACA_API_SECRET` and `FINNHUB_API_KEY` from your environment to its server, so the optional equity upgrades can use them there too.
- **Installer artwork.** The macOS DMG background is rendered from the bundled JetBrains Mono font by `app/icons/dmg/make-bg.py`. It runs on any OS and needs neither macOS nor Menlo.
- **Licence files.** Each installer carries `LICENSE` and `NOTICE`, and each release attaches `THIRD-PARTY-NOTICES.txt`, `SHA256SUMS` and build-provenance attestations. The release runs the full CI workflow on the tagged commit before anything is built or published.

## New in Settings

| Section | Setting | What it does |
|---|---|---|
| Data | Record market data | Turns recording on or off in the installed app. |
| Display | Chart style | *Normal* (default) or *Pixel*. |
| Keyboard | Single-key shortcuts | Turns off the single-character shortcuts, including `+`, `−`, `[` and `]` on the chart. Ctrl and Cmd shortcuts and the arrow keys keep working, so Shift+Up and Shift+Down still zoom the price axis. The choice is kept in this browser. |
| About and legal | (existing panel) | Shows the version, the licence and the data-source attribution. |

## Known limits

- **Unsigned installers.** The installers are not code-signed. Verify a download with `gh attestation verify` or the `SHA256SUMS` file before you bypass the operating system's warning. See the [security guide](../SECURITY.md#verify-what-you-downloaded).
- **Minimum hardware is not established.** The listed minimum is an estimate. The Windows benchmark is recorded as NOT QUALIFIED, as described in the [benchmark notes](windows-minimum-benchmark.md).
- **Keyless equities are synthetic.** For US equities without a keyed source, the depth is a `SYNTH` estimate derived from bar data, not observed resting orders.
- **Keyless quotes are unofficial.** Equity history and display quotes use unofficial Yahoo Finance endpoints, and the keyless last price uses an unofficial Google Finance page. Either can stop without notice.
- **Research panels.** No source is connected to the FLOW, GOV, DOCS and GEO tabs or the MACRO footer in this build. Their feed code exists, but no producer runs for it in this build.
- **Replay shows only what was recorded.** A replay cannot recover depth that was not recorded.
- **The local API cannot be scripted from the installed app.** Its session token is not shown to you. For scripted access, run the server from source, where no token is set.
- **Windows installer.** When the WebView2 runtime is missing, the installer downloads Microsoft's bootstrapper during installation.
- **Translations.** The interface is available in English and Turkish. A string without a Turkish entry shows in English.

## Upgrading

- An existing `./.flowmap_data/warehouse.duckdb` from an earlier source run is not read. Move it by hand to `~/.flowmap/intelligence/` or to the folder named by `FLOWMAP_DATA_DIR`.
- A `flowmap-server.log` written by an earlier build may contain a session token from a `token=` query string. Delete such logs before you share them.
- On Windows, the NSIS uninstaller asks before it deletes app data. The MSI uninstaller does not ask.
