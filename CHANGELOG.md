# Changelog

All notable changes to FlowMap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); entries are grouped by
release and by the date of the work (dates and commit ranges from git history).
Unreleased work sits on top of the newest listed commit.

## [Unreleased]

## [1.7.0] — 2026-11-15

Release notes: [docs/release-notes-1.7.0.md](docs/release-notes-1.7.0.md).

### Added

- Real order-book depth for US equities. Without any key, an equity now reads displayed depth and prints
  from Cboe's public book viewer for its four exchanges (BZX, BYX, EDGX, EDGA): the top five price levels
  per side on each, read every 5 s and merged by price, sizes in shares. The depth tier reads `L2-SNAPSHOT`
  and its tooltip names the scope, because this is not the consolidated US book (NYSE, Nasdaq and the other
  venues are absent). Prints carry the venue and no aggressor side, so there is still no CVD for equities.
  Equities are live from 04:00 to 20:00 New York time on trading days (`server/src/flowmap_server/feeds/equity_book.py`).
  `FLOWMAP_DT_EQUITY_BOOK_NS` sets the read cadence (default 5 s, minimum 2 s).
- Market map. A *Map* button in the top bar opens a full-window map with two tabs. *US stocks* shows the 500
  largest listed companies grouped by sector (Nasdaq screener). *Crypto* shows the 100 largest coins without
  stablecoins and wrapped duplicates (CoinGecko), with a 1 h / 24 h / 7 d switch. Tile area is market value and
  colour is price change. A click opens that instrument's chart (`client/src/ui/marketMap/`,
  `GET /api/market-map`).
- Cursor tags on the axes. The pointer now shows a price tag on the price axis and a date-and-time tag on the
  time axis (weekday, day, month, `HH:MM:SS` in the chosen time zone), and the readout box uses words instead
  of abbreviations.
- Research drawer on real sources. Its US-stock sections read free public sources without a key: risk-factor
  changes and earnings-release language (SEC EDGAR), government contracts (USAspending.gov), House members'
  trades (House Clerk reports), option gamma and short-sale volume (Cboe, FINRA) and hiring on public
  Greenhouse, Lever and Ashby boards. Corporate jets have no source, and the section says so.
- Research drawer crypto tabs: PERP (Binance Futures), OPTIONS (Deribit, BTC and ETH), MARKET (CoinGecko and
  DefiLlama) and SENTIMENT (alternative.me Fear & Greed index).
- SEC contact e-mail under Settings → Data. SEC EDGAR asks automated clients to name a contact; the address is
  sent only to SEC's hosts, in the User-Agent, and only when entered. `SEC_CONTACT_EMAIL` is the fallback.
- World equities. A new venue, `world`, has one market per stock exchange, named by its ISO 10383
  operating MIC (`world-xist`, `world-xtai`, `world-xetr`); the symbol is the exchange's own local
  symbol. 131 exchanges are offered. What the chart shows depends on what a public source exposes for
  that exchange, and the badge says which:
  - `L2-SNAPSHOT`: the publisher's own resting ladder, 3 to 10 price levels per side with real
    sizes, re-read every few seconds (Taiwan, Taipei Exchange, Shanghai, Shenzhen, Beijing, Korea,
    India NSE, Ho Chi Minh, Hanoi, Xetra).
  - `L1`: the best bid and ask with sizes (sixteen exchanges, among them Singapore, Zurich, Warsaw,
    Dubai and Qatar).
  - `SYNTH`: a two-sided volume-at-price profile from one-minute bars.
  The tape shows the publisher's prints where it publishes them, with the side inferred by the quote
  rule on the book tiers; otherwise the session-volume change between two polls as one print. History
  before the subscribe is reconstructed from the session's bars and badged as such. A closed market
  shows its last session and the last minute that traded.
  ([`feeds/global_equity.py`](server/src/flowmap_server/feeds/global_equity.py))
- The symbol picker lists the exchanges by name (`world-xist` reads "Borsa Istanbul (TR)"), so
  "istanbul" finds it, and enumerates an exchange's board when it is chosen. `/api/quote` and
  `/api/movers` answer for a world market, and `/api/venues` carries the exchange names.
- Futures, currency pairs, indices and government bonds. Four more venues read Crocodile's asset
  layer: `futures` (one market per derivatives exchange: `futures-cme_mini:ES1!`,
  `futures-eurex:FDAX1!`, `futures-bist:XU030D1!`; 52 exchanges), `forex` (`forex:EURUSD`), `indices`
  (by full ticker: `indices:SP:SPX`) and `bonds` (`bonds:US10Y`). All are `SYNTH`, because no public
  source shows resting orders for them. A future's profile is volume at price. A currency pair, an
  index and a bond yield have no traded volume, so theirs is time at price, and the capability says
  which (`profile_basis`). An instrument the chart source does not cover (a Eurex or VIOP contract,
  a bond yield) starts from the session's figures and grows from the polls. The markets close from
  Friday 22:00 UTC to Sunday 22:00 UTC, and an instrument whose chart has been silent for ninety
  minutes is shown closed with its last session. The picker lists the four venues with a label
  each; `/api/universe`, `/api/quote` and `/api/movers` answer for them.
  ([`feeds/asset_markets.py`](server/src/flowmap_server/feeds/asset_markets.py))
- Option chain. The **Options** button in the top bar, or the `O` key, opens the chain of the
  instrument on the chart: a picker of its series (each expiry and contract family, with its
  size) and one row per strike, the call on the left and the put on the right. Three views share
  the table: prices (bid, ask, theoretical price, implied volatility, delta), activity (bid size,
  ask size, last trade, volume, open interest; shown when the publisher states any of them) and
  greeks (delta, gamma, theta, vega, rho). The chain comes from the publisher that states the
  most for the instrument, and the dialog names it: Cboe's own delayed file for US shares, ETFs
  and the S&P 500, VIX and Russell 2000 indices (fifteen minutes behind, with sizes, volume and
  open interest); Bybit or Deribit for the coin of a crypto chart (live; Deribit states no size
  and no greeks and quotes premiums in the coin); the aggregator's scanner for NSE and Borsa
  Istanbul underlyings (bid, ask and its own model, no size, volume or open interest). Two
  publishers are never mixed in one chain. The strike nearest to the chart price is marked and
  in-the-money cells are tinted; when the chart has no price, or is plainly not the underlying,
  the price the publisher states is used and the dialog says so. A strike that lists one side
  leaves the other empty, and a figure the publisher does not state is a dash. The dialog reads
  the new `GET /api/options` when it opens, when a series is picked and every twenty seconds
  while it is open; the server serves the last good reading, marked, when a refresh fails.
  ([`feeds/option_chains.py`](server/src/flowmap_server/feeds/option_chains.py),
  [`ui/OptionChain.tsx`](client/src/ui/OptionChain.tsx))
- A real order book for an instrument that has none of its own. A currency pair, a commodity
  future or a US share on the keyless tier is drawn as a `SYNTH` profile, because no free source
  publishes its market's resting orders. Where a venue this build already streams lists an
  instrument on the same underlying with a public book, the top bar now shows a link to it:
  `forex:EURUSD` and `forex:GBPUSD` to Kraken's spot pairs, gold, silver and WTI to Binance's
  USD-M perpetuals, and AAPL, TSLA, NVDA, SPY and QQQ to Binance's perpetuals on them. It is that
  venue's own instrument, and the link says so. Each pair was read on 2026-11-12; a venue whose
  book was stale is not offered. ([`data/real_books.py`](server/src/flowmap_server/data/real_books.py))
- A `SYNTH` world or asset market draws its profile across the chart source's delay. The chart is
  minutes behind the market, so the stretch between its last minute and the first live column used
  to be empty, and that stretch is what the chart opens on. The profile as last known is now stated
  once at the end of the last charted minute and carried to the present, up to thirty minutes.
- `scripts/live_asset_smoke.py` runs the asset feed against the real sources and reads six option
  chains, one per publisher path (manual, not a test).
- A venue's board lists every instrument the aggregator has for it, not its 5,000 most traded:
  the largest venue measured (Eurex, 19,385 contracts) answers whole in one request.
- Eurex official minute candles. A new market, `futures-eurex-official`, draws the December 2026 DAX
  (`FDAXZ2026`) and Euro-Bund (`FGBLZ2026`) futures from Deutsche Börse's own delayed trade files
  (fifteen minutes behind), without the aggregator: real open, high, low, close and the publisher's
  quantity per minute, built in exact decimals from each trade. There is no book, no tape and no
  trade side, and the badge says so. A minute with no published trade is never filled: a gap of up
  to two hours is drawn as empty minutes where it is, a longer one is marked with its span. A trade
  the publisher states twice counts once; two different statements of one trade are both left out
  and the minute is marked incomplete. The files are collected only while a chart of the market is
  open and kept locally (see SECURITY.md); `GET /api/eurex/history` pages the stored minutes and
  `GET /api/eurex/status` reports the collector. The publisher's free terms restrict commercial use.
  ([`feeds/eurex_service.py`](server/src/flowmap_server/feeds/eurex_service.py))
- Clocks of a world market read in the exchange's own time zone, which the session states.
- `scripts/live_world_smoke.py` runs the feed against real exchanges (manual, not a test).

### Fixed

- Macro ticker always read UNAVAILABLE. No part of the server produced macro data. `GET /api/macro` now
  serves SOFR from the New York Fed and the 10Y-2Y spread from the US Treasury's par yield curve, both
  without a key, and the top bar and the Research drawer show them with their observation dates. The
  high-yield spread and the stress regime need a free FRED API key (`FRED_API_KEY`, which the desktop app
  now passes to its server); without it that value shows a dash and no regime is shown.
- History did not load on the default price band. The first-launch history was skipped on every banded price
  range, and the default range (*deep*) is banded, so a newly opened symbol started with a few seconds of
  data whatever the *History depth* setting said. It now loads on every price range.
- A zoomed-out chart went blank — no heatmap, price line, trades or axes — each time the price moved far enough
  to roll the grid, which happens many times over a few hours, and every overview page was read again. The
  overview now survives a roll, and the close-up chart keeps drawing while an overview page loads.
- Zoomed-out views could show stale blocks where one history page met the next: the shared texels were never
  rebuilt. They are now.
- Turkish: "spread" is translated as *makas* everywhere. The DOM ladder said *fark*, the high-yield notes
  said *tahvil farkı* and the Research drawer's macro bar was untranslated.
- The Research drawer never showed data. No part of the server sent the messages it listened for, so every
  section stayed empty. Its sections now answer over REST (`GET /api/research/{market}/{section}`).
- The engine could stay down for hours after a crash ("The FlowMap engine stopped and did not restart").
  Once its five quick restarts failed, the desktop app stopped trying, and its error dialog held up the
  restart logic until it was closed. The app now tries again every minute until the engine is back, shows
  the dialog once per outage without blocking, and keeps writing its logs to the temp folder when the
  app-data folder cannot be written. The engine also writes every thread's stack to its log when it dies
  inside native code, so the cause of such a crash (seen as an access violation in `python313.dll`) can
  be found.
- The session's history is on the chart when a keyless market opens on the default price band.
  A banded grid cannot be seeded from candles, so the feed's replay of the session so far ran
  through the live path: tens of thousands of columns in one burst, which overran the
  subscriber's queue. The queue dropped them and the chart was left with the last few minutes
  only. The replay now fills the ring in silence and the subscribers get one snapshot when it
  is over; older columns are read on request, as for any other history. A full currency day
  takes about fifteen seconds to replay, during which the chart waits.
  ([`core/session_core.py`](server/src/flowmap_server/core/session_core.py))

### Changed

- The *deep* price band's detailed core spans at least 2% of the price instead of 1% (BTC: about $2,048 at
  $1 rows instead of $1,024 at $0.50). With 1%, a few hours of normal movement carried the view into the
  coarse outer rows, drawn as large faint blocks. History keeps the resolution it was recorded with.
- History before the app was watching is price history only: price line, volume and, for crypto, CVD. No depth
  is drawn for that period. The volume-derived "reconstructed" density is gone.
- The whole window is drawn in the pixel style, and the chart always in the smooth style. The chart's axes,
  crosshair readout, legends, measure tool, drawings, alert lines, indicators and CVD pane stay smooth too.
- The vocal-stress card in the Research drawer is now management language: hedging and uncertainty words per
  1,000 words of the written earnings release, with the change from the previous release. It is measured from
  the release text, not from the call audio.
- The bundled Crocodile engine is 0.5.0 (was 0.3.2). It adds the live layer the world markets read
  and the exchange reference data of 0.4.0. The engine's new dependency is `exchange-calendars`.
- The equity grid takes a price-proportional tick for a world market (the fifth significant digit of
  the first real price), because its listings range from sub-cent to six-figure prices. The US market
  keeps its cent tick.
- A local symbol of a world exchange keeps its case in the quote cache (`RRl` on Cboe Europe is not
  `RRL`). So does an asset market's symbol.
- A symbol may contain `!` after its first character (`ES1!`), and a market string an underscore
  (`futures-cme_mini`), in the subscribe check, the discovery API and the client's saved picks.

### Removed

- Settings → Display → Interface style (Normal / Pixel). A pixel choice saved by an earlier version is ignored.
- The unwired collectors `feeds/capitol.py`, `feeds/contracts.py`, `feeds/darkpool.py` and `feeds/headcount.py`.
  The House Stock Watcher source they read no longer answers, so it is no longer read.
- The synthetic equity heatmap. Live equities no longer draw depth, a DOM or a Bid/Ask derived from bar
  volume. Recordings made by earlier versions still replay as recorded, labelled SYNTH.
- `FLOWMAP_BACKFILL_STRETCH` and `FLOWMAP_BACKFILL_SHAPE`, which shaped the removed reconstructed density.

## [1.6.2] — 2026-11-12

Release notes: [docs/release-notes-1.6.2.md](docs/release-notes-1.6.2.md).

### Added

- Version label. The bottom-left corner of the window shows the installed version (for example `v1.6.2`).
- Pixel interface style. Settings > Display > *Interface style* (previously *Chart style*) = *Pixel* now
  changes the whole window, not only the chart: square corners, hard offset shadows in place of blurred
  ones, flat bars with a 4px checker, Pixelify Sans (SIL OFL 1.1, bundled) for labels with the monospace face kept for figures, and a pixel
  FlowMap wordmark. Colours
  still come from the active theme, so it works with every theme (`client/src/theme/pixel.css`).

### Fixed

- Top bar on narrow windows. The bar needed about 1620 px, and below that width the right-hand controls
  (mode, status, clock, PNG, Rail, Research, Settings) were pushed off-window. The bar now wraps whenever its
  items do not fit, and drops secondary items step by step first (macro ticker, extra capability chips,
  search hint, wordmark, the Settings word, the SIM chip, the clock zone), so it stays on one row down to
  the 900 px minimum window width.

## [1.6.1] — 2026-11-12

Release notes: [docs/release-notes-1.6.1.md](docs/release-notes-1.6.1.md).

### Fixed

- Windows setup program (`-setup.exe`): an upgrade left the Python runtime of the previous version in
  the program folder next to the new one, so two versions of a package could sit side by side (for
  example `flowmap_server` 1.5.1 and 1.6.0). The installer now removes the old `pyruntime` folder
  before it copies the new one (`app/src-tauri/windows/hooks.nsi`). It first makes sure FlowMap is not
  running, because a running app holds runtime files open. Recordings, logs and settings are in the
  app-data folder and are not touched. The MSI was not affected.

### Changed

- Release smoke test on Windows (`scripts/packaged_smoke_windows.py`): the NSIS installer is run a
  second time over a planted leftover of an older runtime, and the leftover must be gone.

## [1.6.0] — 2026-11-10

Release notes: [docs/release-notes-1.6.0.md](docs/release-notes-1.6.0.md).

Hardening and release-quality pass: security, release pipeline, tests, tooling and documentation.

### Added

- Local API session token. The installed app generates a fresh 32-byte token at each launch
  and sends it with every request (except the health probe and CORS preflight) and with every
  WebSocket connection; the server requires it when the token is set. Source runs and the browser
  dev server are unchanged.
- Recording switch in Settings > Data (desktop app). It turns recording on or off and saves the choice to
  `recording.json`; a change restarts a running engine so it applies at once.
- Host header check on every HTTP and WebSocket request: only loopback names are served, which
  blocks DNS rebinding.
- Chart style setting, *Normal* (default) or *Pixel*, in Settings > Display. Pixel draws the heatmap as
  blocks with seven intensity levels, colored by the active theme and colormap.
- Release gate: the release workflow runs the full CI workflow on the tagged commit before any
  build or publish starts.
- Release publish runs in the `release` GitHub Environment. Add required reviewers in repository
  settings to hold each publish for approval; without reviewers the environment does not pause it.
- `npm run verify` (typecheck, lint with zero warnings allowed, unit tests) as the single local
  and CI check for the client.
- Nine-field version check on every push and pull request (`scripts/check_release_versions.py`).
- Shell jobs in CI: `cargo test` and `cargo clippy -D warnings` on Windows, Linux and macOS, plus
  `cargo fmt --check` on Linux.
- First-run end-to-end test (`first-run.spec.ts`) that starts without the onboarding flag.
- e2e skip and flake budget (`client/tests/reporters/e2e-budget.json`), enforced in CI.
- The user guide documents the intelligence drawer, the replay picker and the chart style setting.
  The README lists every server environment variable and the data-provider attribution and limits.
- `NOTICE` with the copyright line and the bundled third-party components.
- Content Security Policy on the desktop webview (`app/src-tauri/tauri.conf.json`). The window loads
  only the app itself and the loopback sidecar; no other origin can be fetched from it.
- Typefaces (Inter and JetBrains Mono, SIL Open Font License 1.1) are bundled with the client, so
  text renders the same offline and the client loads nothing from the web.
- The first-run tour states that recording is on by default in the installed app, where the
  recordings are written, and the 20 GB soft cap.
- DMG artwork stamp check (`scripts/check_dmg_art.py`) in CI and in the macOS build legs. A stale
  stamp fails the gate, with the `make-bg.py` command to fix it. `make-bg.py` renders the artwork from the
  bundled JetBrains Mono font on any OS, so it needs neither macOS nor Menlo.
- Token discipline gates for the client. ESLint refuses raw px font sizes, hex colours and rgb()
  literals in `client/src` TS/TSX outside `src/theme`, with a ratchet for the files that predate
  it. `scripts/check_css_font_sizes.py` ratchets the raw px font sizes in client stylesheets.
- Windows benchmark harness: its Node test suites run in `windows-benchmark.yml`, next to the
  Python suite.
- `THIRD-PARTY-NOTICES.txt` on every release, generated by `scripts/third_party_notices.py`, with one
  section per installer target, named by its Rust target triple, for the
  Python distributions in that platform's bundled runtime, and shared sections for the production client
  packages and the locked Rust crates of the desktop shell, each with its declared licence. It is listed in
  `SHA256SUMS`, and the publish job verifies its bytes.
- `LICENSE` and `NOTICE` ship in every installer and are attached to each release. They are listed in
  `SHA256SUMS`, with `THIRD-PARTY-NOTICES.txt`, which includes the two font licence texts.
- Packaged-app smoke test on each Windows release leg (`scripts/packaged_smoke_windows.py`): the
  built MSI and NSIS installers are installed, the app is launched, `/api/health` must answer, a
  foreign `Host` and an unauthenticated request must be refused, the window must close, and no
  python process from the installed runtime may remain. The uninstall follows.
- Tests that pin the webview Content Security Policy and the client's remote-origin rules
  (`scripts/test_tauri_csp.py`), and the notices and smoke helpers (`scripts/test_*.py`).
- `scripts/test_keyboard_reference.py` fails when a key the in-app shortcuts overlay shows is missing
  from the user guide's keyboard table.
- Settings > Keyboard switch, *Single-key shortcuts*. It turns off the single-character shortcuts (`Space`, `/`,
  `E`, `M`, `A`, `H`, `C`, `D`, `I`, `J`, `F`, `P`, `R`, `T`, `+`, `−`, `[`, `]`, `?`); Ctrl and Cmd chords and the
  arrow keys keep working, so Shift+Up and Shift+Down still zoom the price axis. The choice is kept in the browser.
- `]` and `[` zoom the price axis in and out while the chart has focus.
- A `SIM` capability chip on simulated feeds, and a `RECORDED DENSITY` provenance chip on replays of recorded depth.
- A recording-stalled notice in the top bar when a recording write stays unfinished for 30 seconds or more.
  Recording is never turned off automatically, and the notice clears when the write completes.

### Changed

- New drawings start in teal `#2a8f7e` (was `#33d6c4`). The six toolbar swatches are darker hues (teal, blue, violet,
  green, amber and grey, see `client/src/theme/drawInks.ts`), so every ink keeps at least 3:1 contrast against light chart grounds.
- Candles and indicators restart after each reconnect, so a history gap is never bridged with stale bars.
- The WebSocket session token moves from the socket URL to a subprotocol, `flowmap.auth.<token>`. The
  browser client no longer puts it in the URL. The server accepts the subprotocol, never echoes it, and
  redacts any `token=` query value from its access and error logs. On a WebSocket, the query parameter still works for
  command-line tools.
- Build jobs in the release pipeline have read-only token scope and no signing key; the
  installers pass to a separate publish job as workflow artifacts, which attests, checksums,
  uploads and verifies them.
- The release workflow no longer accepts four-part `vX.Y.Z.W` tags. Hotfixes use the next patch
  version (for example `v1.5.2`), because Cargo and npm reject four-part versions.
- Release notes are required. A release without `docs/release-notes-<version>.md` is refused,
  and the auto-generated fallback is gone.
- CI runs on every branch push, and only pull request runs are superseded by newer pushes.
- The Playwright perf checks report frame rate and frame interval against advisory floors. The blocking
  checks are the history-independence ratio of draw cost and the ring memory bound. The draw-cost OR
  escape hatch is removed.
- Log rotation. The desktop server log (`flowmap-server.log`) rotates at 20 MB to
  `flowmap-server.previous.log`. The shell log (`shell.log`) moves to `shell.previous.log` at the
  next launch once it has passed 1 MB.
  The server's own file sink (`FLOWMAP_LOG_FILE`) rotates at 20 MB and keeps three numbered backups
  (`.1` to `.3`).
- The installed app passes `ALPACA_API_KEY`, `ALPACA_API_SECRET` and `FINNHUB_API_KEY` from the user's environment
  to its server. The shell's environment allowlist names them, and a unit test pins that.
- The recording cap is soft. Parts named `*-epochs-*` are never deleted, so the total can stay above
  `FLOWMAP_RECORDING_GB_CAP` when only those remain.
- `FLOWMAP_RECORDING_ENABLED` and `FLOWMAP_BACKFILL_ENABLED` refuse unknown spellings at startup
  instead of reading them as false. `FLOWMAP_DT_*` cadences have a 1 ms floor and a 1 hour ceiling.
- The release pipeline no longer re-renders the DMG artwork on the macOS runner or installs Pillow
  there. The two build steps that run `bundle-python.sh` receive a read-only `GITHUB_TOKEN` to
  authenticate the python-build-standalone lookup.
- The intelligence warehouse defaults to `~/.flowmap/intelligence/` (or `FLOWMAP_DATA_DIR` when set),
  not a folder relative to the launch directory. An existing `./.flowmap_data/warehouse.duckdb` is not
  read and must be moved by hand.
- `scripts/dev.sh`, `scripts/dev-unix.sh` and `scripts/dev-windows.ps1` stop the whole process
  tree on exit, refuse to start over a server they did not start, and restore the console
  code page. `scripts/dev-windows.ps1 -Port` is refused for any port other than 8720, the documented dev server port. The dev client's proxy target is `FLOWMAP_DEV_SERVER_PORT`, then `FLOWMAP_PORT`, then 8720 (`client/vite.config.ts`).
- The webview CSP is stricter: fonts come from the app only (no `data:` fonts), and media, frames,
  plugins and form submissions are blocked. Loopback connections still allow any `127.0.0.1` port,
  because the sidecar's port is chosen at each launch; the session token and Host check guard it.
- The Windows shell job also runs `cargo clippy -D warnings`, so the Windows-only dialog, job-object
  and focus code is linted in CI, not only compiled.
- The root `.gitignore` covers `.flowmap_data/`, `*.duckdb`, `*.duckdb.wal` and alternate Cargo target
  folders (`app/src-tauri/target-*/`).
- A `SIM` chip shows only on the simulated feed. A keyless-equity replay reads `SYNTH` with `RECORDED DENSITY` and no `SIM`.
- Symbol search ignores diacritics and treats dotted and dotless `i` as one letter, so Turkish names match their plain spelling.
- While the desktop sidecar is failed, the window holds socket and REST calls until a retry brings it back, so the session token is not sent to a port the sidecar no longer owns.
- Server dependencies are upgraded. `pip-audit` reports no known vulnerabilities for the locked set, and the CI dependency-audit job runs npm audit, pip-audit and cargo audit.

### Fixed

- The release-asset validator's test suite runs in CI, and the workflow shell test fails
  instead of silently skipping when bash is missing.
- Upload verification: the publish job compares each uploaded installer's bytes with
  `SHA256SUMS`, so a corrupted or clobbered asset blocks publication.
- A failed stale-asset cleanup now fails the publish step instead of being swallowed.
- The AppImage is a required installer, not a best-effort extra; the misleading
  `continue-on-error` is removed.
- The e2e suite no longer passes silently on skipped or flaky tests.
- Documentation corrections: the session token and Host check, the chart style location, the
  recording default and its disclosure, the log files and rotation, the soft recording cap, the
  intelligence views, the feed modules that have no producer in this build (their hosts are not
  contacted), the WebSocket origin policy, the crocodile engine (vendored wheel, not a git pin),
  per-OS data and log paths, the WebView2 bootstrapper download on Windows, the macOS first-run
  steps for macOS 15 and later, the Node.js version, test counts, and the README configuration
  table.
- Documentation pass against the code: the installed app's per-launch port (8720 is for source
  runs), the eight colormaps and their `theme` default, the 1m/5m/15m candle intervals, the
  indicator list, how to turn recording off (`recording.json` or `FLOWMAP_RECORDING_ENABLED=0`, and
  the dev launchers' flags), the README attribution of feed modules that have no producer, the macOS
  minimum's artifact location, the CI workflow list, the Settings > About and legal dialog, and the
  `THIRD-PARTY-NOTICES.txt` and licence-text wording.
- The FLOW, GOV, DOCS, GEO and MACRO intelligence panels are not fed in this build. No server
  producer runs for them, so the drawer lists their sources as "Not connected, hidden". Earlier
  entries that describe these panels as shipped refer to the feed code, not to a live feed.
- The macro, capitol (politics), dark-pool, defense-contracts, EDGAR and vocal-stress sources are not connected in this build.
- Maximum time zoom no longer resets the time window or the manual price scale.
- Price-axis gestures leave the time window unchanged. Late history loads respect manual navigation.
- Time zoom-out now allows twice the available history span, without increasing the history cache.
- Shell comments no longer describe the server's stdin-EOF stop as pending. The server honours
  `FLOWMAP_EXIT_ON_STDIN_EOF=1`, so a quit or a lost shell stops the sidecar through its flush path.
- A recording-switch change that cannot restart a running sidecar is written to `shell.log`, and the
  Settings reply reports `restarting: false`, instead of passing silently.
- A launch with no current `flowmap-server.log` no longer deletes the older `flowmap-server.previous.log`
  when it rotates the log, so the crash kept from before survives that launch too.
- Documentation pass for 1.6.0: the security guide names every outbound trigger (display quotes and the launch
  warm-up) and the intelligence store's location, documents the accepted risks and the token transport; the user
  guide documents the single-key switch, the chart and capability chips and the recording-stalled notice; MACRO is
  a footer bar, not a tab.
- `app/README.md` and `SECURITY.md` describe the macOS stdin EOF, the pinned `tauri-cli` version, the
  shell's CSP, the checksum manifest and the packaged checks as the code does now.

## [1.5.1] — 2026-10-16

### Added

- Replay picker with UTC date/time editing, local readouts, recorded hours, presets and exact range preview. Selections open paused.

### Fixed

- Replay prices, stored bars, paused seeking and first/final column display; stale frames are discarded after seeking.
- LIVE follow preferences survive replay, including changes made immediately before entry.
- Recorded density remains visible while unavailable quote and spread readouts are cleared.
- The timeline thumb follows chart movement between readout updates, including at the live edge.
- Replay selections preserve the chosen instant through repeated local hours, including exact recorded/default/preset bounds.
- Benchmark finalization obtains an actual final health response; assessment requires its end bracket.

### Testing

- Saved-drawing checks explicitly frame persisted anchors. Full-ring history checks allow 150 seconds on software-rendered CI, with the 360-second outer test and complete correctness and pixel checks retained. This increases the functional wait allowance; it does not indicate faster loading. CI retains test results and traces.

### Changed

- Replay identifies recorded density and reconstructed quotes. Missing intervals stay empty; empty or oversized selections show an error.
- Yahoo resets and intraday conversion run in a background worker. Equity preloading stops admitting new work at its cutoff and rejects late results. Cleanup can wait for blocking Yahoo work.
- Crypto certificate loading and fallback market setup run in workers; cancellation waits for owned workers to finish cleanup.
- Server log output and first Yahoo provider imports run in workers. A bounded log buffer reports dropped diagnostic records after output recovers.

- [Windows benchmark](docs/windows-minimum-benchmark.md): history retains its original 30-minute PASS, with a separate retrospective INCOMPLETE assessment for its unknown health end tail. Graphics/input/resource measurements remain usable; LIVE graphics passes but source debt fails. Overall NOTQUALIFIED; RAM is estimated from 32 GiB hardware.
- The measured private build predates the picker and final-health corrections. Corrected release source is unmeasured; original traces and hashes are preserved.
- Stable publication waits for all eight platform installers and their checksum manifest.

## [1.5.0] — 2026-10-12

### Added

- Recorded-depth history overviews, absolute-range paging, and a persistent
  aggregation cache for inspecting data beyond the live RAM/GPU ring.
- Orderflow, Analysis, and Focus workspace layouts with resizable panels,
  quote-age readouts, time-window controls, and 5/30/60-second trade-flow totals.
- Previously unpublished FLOW, GOV, DOCS, GEO, and MACRO intelligence panels.
  Demo fixtures are restricted to SIM-DEMO;
  other instruments show unavailable states when no connected source supplied data.
- GEX model readouts in millions of dollars per 100% relative spot move, with
  the fixed call-positive/put-negative assumption stated and gamma flip shown
  only when a sign crossing exists.
- Vendored Crocodile engine integration for supported public L2 sources,
  including the selected connector's depth mode and book-update counters.

### Changed

- Historical geometry is projected by physical price coverage; missing depth
  stays empty. Wide views aggregate genuine recorded quantities and return to
  original detail when zoomed in. Cold disk history loads progressively.
- Heatmap tolerance and normalization follow visible liquidity; chart overlays,
  grouped DOM levels, and fine quote/tape prices use their respective geometry.
- Windows sidecar processes are hidden and owned by the desktop shell's job.
- Intel macOS packages include a self-contained OpenSSL build and do not
  require Homebrew on the user's Mac.
- macOS 11 is no longer supported. macOS packages declare the minimum system
  version required by their bundled native libraries.
- App, client, and server versions are aligned at 1.5.0. Releases build the
  selected tag, validate package versions, use locked vendored dependencies,
  and publish the release notes after the required platform builds succeed.

### Fixed

- History navigation tracks newly received source time. Live price recentering
  preserves the selected historical time window.
- A slow initial subscription sends its handshake before keepalive pings.

See [release notes](docs/release-notes-1.5.0.md) for the user-facing summary.

## 2026-09-11

Client and server feature work on top of `7ae568e`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/7ae568e...HEAD)).

### Added

- **Watchlist rail** — pin up to 30 `market:symbol` favorites (persisted under
  `flowmap.watchlist.v1`); each row shows a live quote, signed change and an
  inline sparkline from a shared 10 s poll that pauses while the tab is hidden.
  Stale rows dim with a `stale` chip and unreachable symbols show `—`, never a
  guessed price. Clicking a row switches the chart; the empty state offers
  recents.
- **Alert sound** — an optional WebAudio two-tone chime on fire (lazy
  `AudioContext`, resume-on-gesture, 150 ms burst guard, silent if WebAudio is
  unavailable) with a new `Settings → Alerts` toggle (`alertSound`, default on).
- **Alert re-arm hysteresis** — a fired alert records a re-arm band
  (`level ∓ max(0.1%, 1e-9)`) and stays latched until price returns past it;
  the next crossing then fires. This replaces the blind 60-second refire.
  `snooze` is now a plain mute; the popover shows honest
  `armed / re-armed / re-arming @ X / fired / muted` states, and manual re-arm
  keeps the band.
- **Alerts for non-active symbols** — a visibility-gated monitor polls
  `GET /api/quote` for every alert key except the active one and evaluates only
  fresh marks (`stale !== true`, `reachable !== false`), so alerts keep working
  while another symbol is on the chart.
- **Replay window plumbing** — `Subscribe.end_t` on the wire, part of the
  subscription identity, re-sent across reconnect, with a store-level window
  option; an unbounded subscribe is byte-identical to the previous wire format
  (golden-vector pinned).
- **Two more themes** — `paper-deut` (light deuteranopia: teal bid / blue ask)
  and `contrast` (true-black, AAA ink); `T` now cycles seven palettes, both new
  ones keep the dark chart-island `--chart-*` pin and pass computed WCAG checks.
- **i18n shell holes closed** — 82 new EN/TR keys covering the remaining
  visible shell strings (top bar, reconnect banner, settings drawer
  sections/toggles/hints, keysheet actions, shortcuts footer). English
  rendering is byte-identical to the old literals.
- **E2E in CI** — a new ubuntu Playwright job runs the whole suite (Chromium
  via SwiftShader, fresh servers, `retries: 2`); the config serializes workers
  in CI so canvas-heavy specs cannot starve each other, and the harness seeds
  the onboarding-dismissal and theme storage state for every context. Two new
  spec files add 11 tests: `features.spec.ts` (drawings persistence, alert
  fire, replay-refusal honesty, theme/locale flips, watchlist switching) and
  `gl4.spec.ts` (tick-grouping floor, deep time-zoom mips, imbalance pixels,
  context-loss follow intent).
- **Lint gates** — client `npm run lint` (eslint flat config: typescript-eslint
  + react-hooks) and server `uv run ruff check .`, both wired as CI steps.
- **`/api/health`** — `feeds[]` rows now carry `session_id`, the join key to
  the per-session `stats.staleness_ms` map.

### Changed

- **History pages are frame-budgeted (dev scroll-back fix)** — a
  `HistoryResponse` is ONE binary WebSocket frame of `n_cols × rows × 8` bytes;
  at the 256-column page size a 4096-row grid produces a ~8.4 MB message, and
  the vite dev proxy measurably drops exactly those (verified 2026-09-20: the
  identical request answered instantly direct-to-server; through the proxy the
  server-side socket errors with `ECONNABORTED` and the client times out at
  30 s — scrolled back, the dev client then shows a mostly EMPTY heatmap
  because no page ever splices; the ceiling shrinks further under concurrent
  live traffic). The loader now sizes each page from the grid height AND the
  transport (`net/history.ts pageColsForRows` + a per-transport ceiling:
  direct/Tauri keeps the full 256-column page, same-origin dev rides
  512 KB-framed pages), so scroll-back fills in dev too. Root cause of the
  proxy's backpressure abort is upstream (http-proxy ws relay) — recorded for
  a follow-up.
- **Eased live-edge scroll (the "chart jumps once per column" fix)** — while
  time-follow is armed, the DRAWN view now trails the logical follow frame by a
  fractional column lag that grows by each arrival and is consumed at EXACTLY
  the measured column arrival rate (`gl/follow.ts stepLiveEdgeLag`: constant-
  velocity catch-up, lag capped at 1 column), so the heatmap scrolls at a
  steady one column per interval instead of stepping once per column — with no
  slide-then-freeze tail on long-interval (1 s equity) grids, which an
  exponential ease produced. The measured inter-arrival EMA drives the rate,
  seeded from the epoch dt. Real feeds arrive in BURSTS (a Binance L2 queue
  flushes 2-4 columns at once): the lag absorbs the WHOLE burst — an earlier
  draft clamped the trail at 1 column, which turned every burst's excess into
  instant forward jumps (the reported "perde perde" wave on BTC) — and drains
  the backlog smoothly above the steady reserve (~1.2 s time constant), with a
  runaway guard at 8 columns. A renderer-level regression test drives the real
  frame loop through a bursty arrival pattern and pins "no frame advances more
  than a fraction of a column". Uniforms-only — no column is re-uploaded, and
  the camera state, `colsBehind` semantics, GO LIVE pill and history loader
  keep
  reasoning in whole columns; heatmap, overlays, axes and the minimap window
  glide in sync off the same eased view. The Timeline rides the renderer's
  `onViewChanged` seam per changed frame (the poll is only a fallback), so the
  minimap/playhead no longer step at the 5 Hz poll cadence. The
  Timeline/LiveControls "behind" readouts ignore sub-column glide lag (a
  ≥ 1 whole-column threshold gated on follow state), and
  `liveEdgeVisible`/price-follow gate on the logical camera frame so a glide
  can never strobe the TRK·WAIT chip.
- **Restrained shell modernization** — design tokens retuned across all seven
  themes: radii 4/6/8 px, two-layer contact+ambient shadows, motion on a
  decelerating cubic curve (0.15 s/0.22 s); UI chrome reads in the platform
  sans (`--font-ui`, system stack — no network dependency) while every
  data-bearing numeral stays on the mono stack with tabular figures; thin
  theme-tinted scrollbars, a calm `:focus-visible` accent ring. Tape prints
  and newly-entering ladder levels settle in with a ≤ 150 ms fade (value
  spans shimmer on change); everything honors `prefers-reduced-motion`.
- **Tick grouping is now real** — `settings.tickGrouping` floors the mip level
  at `log4(n)` (1/4/16 → levels 0/1/2; non-4^k values round UP to the next
  4^k block, documented at the setter). `probeAt`/crosshair stay
  group-consistent with what is painted, and `n = 1` (the default) is
  bit-identical to before.
- **Overlay and frame performance/honesty** — overlay windows are re-pruned
  only after ≥64 columns of drift (was every appended column); the volume
  profile point-samples one row per mip block (read volume collapses, POC/max
  stay exact over the scanned rows); context-loss recovery re-applies the
  user's follow intent instead of silently re-arming follow; the PerfHud frame
  span now includes the overlay pass, and an overlay throw leaves the frame
  dirty and is retried instead of silently dying.
- **Replay loads are bounded** — a no-window replay subscribe serves the
  newest `FLOWMAP_REPLAY_MAX_COLS` columns (default: follow the grid ring)
  instead of materializing the whole recording; truncation is flagged on the
  load with a warning naming the symbol and knob, and trades/markers are capped
  to their newest rows. An explicit `[start_t, end_t)` window is never trimmed
  by this knob.
- **Replay windows are part of session identity** — a re-attach with a
  different window is a distinct session, and the idle parked variant of the
  same symbol/mode is evicted immediately, so cycling windows cannot leak one
  grid ring per window.
- **Market data cache** — movers fetch a fixed 100-row maximum and slice per
  caller (a small first request can no longer poison the cache for everyone);
  `run_background` refreshes the full set; quote/movers single-flight locks are
  pruned after release. The prewarm background task is now actually started in
  the app lifespan and cancelled before shutdown.
- **Server counters** — `sessions.rejected` now counts unknown-market
  refusals; the unused `_sub_epoch` counter was deleted (the re-subscribe
  drain runs synchronously, so there was no interleaving boundary to mark).

### Fixed

- **Alert replay guard** — alert evaluation is skipped while the active
  subscription is in replay mode; historical book prices can no longer fire a
  "live" alert or burn its latch.
- **Alerts popover accessibility** — the popover is a `role="dialog"` with
  `aria-modal`, a Tab/Shift-Tab focus trap (disabled controls skipped) and
  focus restore to the opener on close.

Still planned (not in this release): the interactive replay-window picker
(wire + store plumbing shipped above; no UI yet), multi-chart layouts,
feature-pane i18n (drawings/indicators/alerts surfaces) and CI coverage
reporting (lint + e2e are gated now).

## 2026-09-10

Client and server feature work on top of `9887937`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/9887937...7ae568e)).

### Added

- **Chart annotation (drawings)** — 2D-canvas overlay above the heatmap:
  trendline, horizontal ray, rectangle, Fibonacci retracement, horizontal line
  and text tools, with select/move/resize/delete and per-symbol persistence in
  `localStorage`.
- **Indicators + candles** — candle synthesis from the tape/price stream with a
  selectable interval (1m/5m), plus a registry-driven indicator overlay
  (EMA, SMA, RSI, VWAP, Bollinger, MACD) with editable parameters, drawn on a
  2D canvas riding the chart's price scale.
- **Measure tool** (`M`) — drag on the chart for a dashed rectangle with
  Δprice (absolute + %), Δtime and depth inside the row band; `Esc` cancels;
  honest `—` readouts when geometry or book data is missing.
- **On-chart price alerts** (`A`) — client-local, persisted per symbol in
  `localStorage` (max 50 per symbol), alert line + solid-red pulse on fire,
  toast via the new Toaster, 60 s snooze/re-arm, alerts popover with typed
  entry, delete and clear-fired.
- **Depth channel modes** — renderer channel selection `sum` / `bid` / `ask` /
  `imbalance` (`C` cycles, segmented control in the settings drawer). Imbalance
  `(bid−ask)/(bid+ask)` renders on a CVD-safe divergent blue↔orange ramp;
  `sum` is bit-identical to previous releases, and synthetic (SYNTH) sessions
  keep rendering `sum` with the setting remembered for real-depth feeds.
- **Perf HUD** (`H`) — fps / frame ms / uploads / draws / cache footprint chip,
  polled at 2 Hz from a new `renderer.stats()` API; every field degrades to `—`
  when unavailable.
- **Themes** — five CVD-safe themes (`midnight` default — byte-identical to the
  previous look, `paper`, `swiss`, `amber`, `sea` deuteranopia-safe), applied
  via CSS-variable token blocks with a canvas-palette bridge; `T` cycles;
  first run honors `prefers-color-scheme`; choice persists.
- **i18n (EN/TR shell)** — dependency-free `t()` with English default and
  Turkish translation covering the shell (top bar, settings drawer, banners,
  shortcuts overlay, onboarding, toasts); missing keys fall back to English,
  never to raw key names.
- **Toaster** — stacked toast queue (info/success/warn/error, auto-dismiss,
  hover-pause, max 5) with a polite live region; other components post through
  `window.__flowmapToast`.
- **Onboarding** — first-run 3-step tour (connect/symbol, mouse & keys,
  shortcuts) with focus trap; only Skip/Done dismiss it permanently — `Esc`
  merely closes, so the tour returns next launch.
- **`/api/health` v3** — a new session-stats producer is surfaced verbatim
  under `stats` (drop counters, restarts, active/rejected sessions, real EMA
  `latency_ms`, per-feed `staleness_ms`, `clock_skew_ms`, recording health with
  flush-failure counts) plus `stats_available`; legacy fields unchanged.
- **`/api/export`** — `GET /api/export?format=csv|json&columns=N&symbol=`
  streams the last-N finalized density columns of a session as CSV (with
  metadata comment header) or JSON; bounded by the ring and a 64 MiB cap, with
  structured 404/400/422 errors.
- **WS admission control** — WebSocket connections are gated by browser-origin
  allow-list (loopback dev origins + `tauri://localhost` /
  `https://tauri.localhost`; env-overridable via `FLOWMAP_WS_ALLOWED_ORIGINS`,
  `*` disables) with close code `1008`, and by a per-process connection cap
  (`FLOWMAP_WS_MAX_CONNECTIONS`, default 16) with close code `1013` and an
  honest reason string.
- **Real connection telemetry** — WS ping RTT now feeds `latency_ms`, and an
  optional client timestamp on `Subscribe` yields `clock_skew_ms` (backward
  compatible in both wire directions; golden vector pinned).
- **CI** — new Windows leg (pytest + tsc/vitest), `cargo test` leg for the
  Tauri shell, and a `vite build` production-bundle gate; concurrency
  cancel-in-progress; legacy combined `test.yml` workflow retired (its jobs
  are a subset of `ci.yml`).
- **Docs** — `docs/user-guide.md`, `CHANGELOG.md`, `ROADMAP.md`; README and
  architecture docs updated to the new feature set.

### Changed

- Mip level selection now takes the coarser of the row/column axis needs, so
  deep time-zoom-out suppresses aliasing backfill as well (2-argument behavior
  unchanged).
- Column cache is a slot-addressed preallocated pool mirroring the GPU ring —
  no per-column allocations or large buffer churn in steady state.
- Normalization memoizes the visible-tile merge (no re-merge per dirty frame)
  and history-page mip rebuilds are batched into one pass per level/segment
  instead of dozens of tiny framebuffer passes.
- Re-subscribing a WebSocket drains the shared client queue and bumps a
  subscription epoch, so frames of the old symbol can never flush after the
  new session's Hello/snapshot.
- Book tape is a fixed head-index ring iterated backward for newest-first
  snapshots (no per-flush `slice().reverse()` double allocation); the CVD pane
  projects into a reused buffer (allocation-free per repaint).

## [1.4.0] — 2026-09-10

`bd80f35..840cc96`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/17b0c47...840cc96)).

### Fixed

- Server replay and recording integrity: recording flush and replay-attach
  robustness; feed hardening.
- GL correctness: normalizer/mip gates, hybrid BBO, premultiplied blend,
  renderer snapshot semantics.

### Added

- Transport honesty guards, input guards, PNG chart export (`E` / TopBar
  button), configurable big-trade highlight in the tape.
- Desktop shell: single-instance OS lock, sidecar health monitor with respawn,
  version 1.4.0.

### Changed

- Docs and CI brought to truth: professional README, architecture and
  development guides, dev boot scripts.

## 2026-09-06 — upgrade pass

`3607a17..17b0c47`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/a529eaa...17b0c47)).

- Server: replay attach re-validates recording freshness; malformed-trade
  guard; refused subscribes logged; `/api/health`, file logging, structured
  REST errors, WS frame hardening.
- Client: reconnect backoff jitter, history-reset leak fix, epoch-safe depth
  book; heatmap gap-band gating and seam-free sampling; shortcuts overlay,
  symbol recents + fuzzy search scoring, accessibility and truthful states.
- Repo: professional README, `docs/architecture.md`, `docs/development.md`,
  CI workflows, dev boot scripts.

## 2026-09-05 — chart rebuild and honesty

`e60168f..a529eaa`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/bd71738...a529eaa)).

- TradingView-grade chart + smooth flow-colormap WebGL2 heatmap; bilinear
  sampling in slot space fixes the faded-past-first-tile-layer artifact.
- Honest replay-unavailable state (no silent reconnect loop).

## 2026-09-03 — review

`69249f6..bd71738`
([compare](https://github.com/nazmiefearmutcu/flowmap/compare/7ae45a1...bd71738)).

- Server review fixes: f16 saturation, hybrid price-scale persistence,
  boot-teardown race, columnar tail decode.
- Client review fixes: WebGL2 fallback, responsive top bar, replay honesty.
- Honest replay refusal, WebSocket liveness, reconnect race fixes; single-flight
  cache lock prune.
- Recording-backed replay engine: design, implementation and Playwright e2e.

## Earlier releases

Initial public releases through v1.3.1.1 (up to 2026-08-01) predate this
changelog; see the
[releases page](https://github.com/nazmiefearmutcu/flowmap/releases) for
notes and assets.

[Unreleased]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.6.2...v1.7.0
[1.6.2]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/nazmiefearmutcu/flowmap/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/nazmiefearmutcu/flowmap/releases/tag/v1.5.0
[1.4.0]: https://github.com/nazmiefearmutcu/flowmap/compare/17b0c47...840cc96
