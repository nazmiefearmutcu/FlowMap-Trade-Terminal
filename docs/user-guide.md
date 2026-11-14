# FlowMap user guide

Status: current for the code on `main`. Changes not yet in a release are listed in [CHANGELOG.md](../CHANGELOG.md).

How to install FlowMap, connect to a market, read the liquidity heatmap, and use
replay, measurement, alerts, the watchlist, drawings, indicators and export. For
how the pieces work inside, see [architecture.md](architecture.md); for
build/test commands, [development.md](development.md).

Contents: [Install](#install) · [First run](#first-run) ·
[Connecting](#connecting--picking-symbols) · [Reading the heatmap](#reading-the-heatmap) ·
[Replay](#replay--seek) · [Measure tool](#measure-tool) ·
[Price alerts](#price-alerts) · [Watchlist](#watchlist) · [Drawings](#drawings) ·
[Indicators & candles](#indicators--candles) · [Themes & language](#themes--language) ·
[Intelligence drawer](#intelligence-drawer) · [Keyboard reference](#keyboard--pointer-reference) ·
[Export](#export) ·
[Health endpoint](#health-endpoint) · [Troubleshooting](#troubleshooting)

## Install

**Desktop app (recommended).** Download the installer for your platform from the
[releases page](https://github.com/nazmiefearmutcu/flowmap/releases/latest) —
macOS (Apple Silicon / Intel), Windows x64 / ARM64, or Linux (deb / AppImage).
Installers are self-contained: they bundle the client and a private Python
runtime, so nothing else needs to be installed. Nothing is fetched at first run,
with one exception: on Windows, the installer fetches Microsoft's WebView2 runtime
when the machine does not have it (see
[SECURITY.md](../SECURITY.md#what-is-in-the-installer)). They are **unsigned**;
verify the download with the SLSA build-provenance attestation
(`gh attestation verify <file> -R nazmiefearmutcu/flowmap`) or the `SHA256SUMS`
asset before bypassing the OS warning. The exact steps are in
[SECURITY.md](../SECURITY.md).

On Windows, the NSIS installer's uninstaller asks whether to delete the app data folder. The MSI uninstaller does not ask.

**From source.** You need Python 3.13 with [uv](https://docs.astral.sh/uv/) and
Node.js 22.13+ (or 24) with npm:

```bash
./scripts/dev.sh            # server on :8720 + vite on :5173
# then open http://localhost:5173
```

Manual boot and Windows/PowerShell variants are in the
[README](../README.md#run-from-source). From source there is no
packaging step; the packaged app and the dev setup behave the same otherwise.

## First run

On the very first launch a short three-step tour appears: (1) connect and pick
a symbol, (2) mouse and keyboard navigation, (3) where the shortcuts overlay
lives. The card also says that recording is on by default in the installed app and where the
recordings are written. To turn recording off, use Settings → Data → *Record market data*, or set
`"enabled": false` in `recording.json` in the app data folder before launch. From source, run with
`FLOWMAP_RECORDING_ENABLED=0`. Notes on its honesty rules:

- **Skip** and **Done** dismiss the tour permanently; pressing `Esc` or
  clicking away only closes it for this session — it will greet you again next
  launch until you explicitly dismiss it.
- The tour is keyboard-accessible (focus is trapped inside while open and
  restored when it closes).

Pick `sim:SIM-DEMO` if you want to look around with no network and no keys; it
is a deterministic feed, so the same window of tape repeats identically.

Later launches restore the last selected instrument. The quote strip beneath
the toolbar shows the last trade, raw bid/ask with inside sizes, spread and the
age of the most recently received quote. A quiet quote stays visible with its
age; display frames do not manufacture new market updates.

Use **15s / 1m / 5m / 30m** to change the visible duration while keeping the
current end position. **All** fits the loaded history and its price range.
When inspecting past data, a duration change keeps live follow off. The DOM's
**Δ** label shows the grouped depth interval; the quote strip and tape retain
the finer exchange price precision.

## Connecting & picking symbols

Press `/` (or `Ctrl-K` / `⌘K`) for the symbol palette: a fuzzy, ranked search
over every subscribable symbol with live quote, movers and sparklines. Symbols
typed in either spelling (`ETH/BTC` vs `ETHBTC`) are translated, not rejected.

Market grammar (what you can type into the search or the socket):

- `sim:SIM-DEMO` — deterministic, offline.
- `<exchange>[-<segment>]:<SYMBOL>` — e.g. `binance:BTCUSDT`,
  `bybit-usdm:ETHUSDT`. Native incremental L2 on binance, bybit, coinbase,
  deribit, okx; every other ccxt venue via snapshot polling.
- `equity:AAPL` — keyless US equity depth from Cboe's public book viewer: the top
  five displayed price levels per side on the BZX, BYX, EDGX and EDGA exchanges,
  read every 5 seconds and merged by price, in shares. It is not the consolidated
  US order book: NYSE, Nasdaq and other venues are absent. Prints carry no buyer or
  seller side, so there is no cumulative volume delta (CVD). The feed is live from 04:00 to 20:00 New York
  time on trading days. Before FlowMap starts watching a symbol, the chart shows
  its price history only, with no depth. With `ALPACA_API_KEY`/`ALPACA_API_SECRET`
  or `FINNHUB_API_KEY` in the environment that starts FlowMap (the installed app
  forwards them to its server) it upgrades to real L1 top-of-book and tick tape
  during market hours.

**Capability badges, never silent downgrades.** The top bar shows what the
active feed actually delivers — `L2` / `L2-SNAPSHOT` / `L1` / `SYNTH`, `TAPE TICK` / `TAPE
POLL`, `SIDE EXCHANGE` / `SIDE NA`, and `RECORDED DENSITY` when the depth on screen is read back from a recording. A simulated feed (`sim:SIM-DEMO`) shows a `SIM` chip. A replay keeps its real depth tier (a keyless equity recording still reads `SYNTH`) and adds `RECORDED DENSITY`. `L2-SNAPSHOT` is a real book that a polled venue re-reads whole on each tick (the ccxt venues), so it is less detailed than a streamed `L2` book and carries an amber caution style. A keyless equity book from Cboe also reads `L2-SNAPSHOT`, and its tooltip names the four exchanges it covers. If a badge says the side or the tape is
degraded, that is the truth of the stream, not a UI guess.

Up to 4 sessions can be subscribed at once (`FLOWMAP_MAX_SESSIONS`).

## Reading the heatmap

The chart is a column-per-tick heatmap of **resting liquidity**: time flows
left → right, price is the vertical axis, and color intensity is how much
bid/ask size rests at that price during that column. Because each column is
rasterized to the GPU once, pan/zoom stays smooth no matter how deep the
history. Zoom with the wheel (time at the cursor), Shift/Ctrl+wheel (price) or
the price gutter (wheel = zoom, drag = scale, double-click = re-fit). Manual
price zoom can extend beyond the automatically fitted market range. **All**
shows the entire available session history, loading older recorded liquidity
from disk when needed. Wider views combine time intervals into readable bars
and an averaged heatmap; returning to a close view loads the original detail.
The crosshair labels averaged intervals with `avg`. Missing recordings are
shown as empty space rather than filled with current liquidity.

**Depth channel modes** choose what the colors mean. Press `C` to cycle, or use
the *Depth channel* segmented control in `Settings → Display`:

| Mode | Shows | Notes |
|---|---|---|
| `sum` (default) | bid + ask density | Normalized to the visible price region. |
| `bid` | bid-side density only | Normalized with the same percentile pipeline. |
| `ask` | ask-side density only | As `bid`, other side. |
| `imbalance` | signed `(bid−ask)/(bid+ask)` | Fixed −1…+1 scale; one end of the divergent blue↔orange ramp is bid-heavy, the other ask-heavy; the neutral middle is balance. |

The setting persists across launches. If the active session is a synthetic
(SYNTH) feed, the renderer keeps showing the honest `sum`/amber view. A synthetic
feed has no real two-sided book. Old recordings of keyless equities replay as
SYNTH too. When a real-depth session is active again, the renderer re-applies
your channel.

Eight colormaps (`theme`, the default, which follows the active theme colours; `flow`, `inferno`,
`classic`, `ice`, `viridis`, `cividis` and `mono`), tolerance, contrast, normalization percentile and
overlay toggles live in the settings drawer (gear icon). The DOM ladder (right rail) shows the live
book around the crosshair; the tape below it streams trades, with outsized prints highlighted
at a configurable notional threshold (`Settings → Big trade size`); the CVD
pane is locked to the chart's time axis. **Tolerance** is calibrated to the
visible liquidity distribution: 0 keeps all active levels, 50 suppresses the
weaker half, and 100 focuses on stronger levels. It does not use the largest
order as a fixed cutoff, so the middle of the slider remains usable across
symbols with very different prices and quantities.

**Normalization** selects the white-point percentile (80–100); lower values
make more levels bright. The full setting applies to close views and historical
overviews. Imbalance has its own fixed signed scale, so density display controls
are disabled in that mode. Broad price buckets in older recordings carry less
price detail; they are shown as muted intervals, while the crosshair reports
their actual stored quantity and range. Newly recorded fine depth follows the
market as the price frame recenters, without moving older data to new prices.

## Replay & seek

Everything a session shows is recorded to parquet on disk. The installed app records by default,
under a soft 20 GB cap (`FLOWMAP_RECORDING_GB_CAP`). A source run from the dev launchers records only
when you opt in: `FLOWMAP_RECORDING_ENABLED=1` for `scripts/dev.sh` and `scripts/dev-unix.sh`, or
`-EnableRecording` (or the same variable) for `scripts/dev-windows.ps1`. Toggle live → replay in the top
bar; the timeline at the bottom becomes a transport with a minimap:

- **Seek** by clicking/dragging the playhead; **speed** 1–100×; **pause**.
- `Space` plays/pauses; `R` returns to the live edge; the **Go Live** pill
  appears the moment you scroll off the live edge.
- Replay is **honest**: it plays back exactly what was recorded. A replay
  request with no usable recording is refused explicitly, a stale recorded
  tail is refused rather than relabeled live, and where a recorded tail meets
  a live edge a gap marker is shown instead of invented continuity.
- **Bounded loads.** A replay with no explicit window loads the newest bounded
  window of the recording (the grid ring, or `FLOWMAP_REPLAY_MAX_COLS` if set)
  and warns if the recording was truncated to fit. The wire and the client
  already support a `[start_t, end_t)` subscription window (re-subscribed as a
  distinct session). The **replay picker** lets you choose the recorded window to
  load, by date and time, from the recordings available for the symbol, instead
  of loading the newest window.

**Recording health.** Recording writes to disk in the background. When a write stays unfinished for 30
seconds or more, the server reports the recording as wedged, the app shows a notice that recording has
stalled for the session, and the notice clears by itself once the write completes. A stalled write never
turns recording off by itself, because that would silently drop data you chose to keep. While the notice is
shown, new data for that session is kept in memory rather than written to disk. If the memory buffer fills
before the write completes, the oldest buffered rows are dropped, the drop is logged, and a gap marker is recorded where the data resumes.
If the notice does not clear, check the recordings drive for free space and errors, and the server log.

## Measure tool

Press `M`, then click-drag on the chart. A dashed rectangle shows:

- **Δprice** — absolute (signed) and % between the two corners,
- **Δtime** — humanized (ms/s/m/h/d),
- **depth** — resting size inside the rectangle's row band, read from the
  settled book.

If a value cannot be computed honestly (off-grid corner, no book yet), the
readout shows `—` instead of a guess. `Esc` cancels the drag or clears the
result; a completed measurement stays until the next click. The tool works in
replay too. Press `M` again (or `Esc`) to disarm.

## Price alerts

Price alerts are **client-local**: they live in your browser's
`localStorage`, per symbol, and are evaluated against the live book mid (or
last trade) about ten times per second — the alert itself never leaves your machine. For a symbol you are not subscribed to, the background monitor fetches its public quote through the local server, from the provider hosts listed in the [security guide](../SECURITY.md#where-it-connects).

- Press `A` to create an alert at the crosshair price; the bell button
  (chart's bottom-right) opens the alert list, where you can type an exact
  level, delete, snooze, manually re-arm, or clear fired alerts.
- Direction (above/below) is derived from the market mid at creation time.
- When a level crosses: the line marker turns solid red and pulses briefly, a
  toast names the symbol, an optional chime plays (`Settings → Alerts → Alert
  sound`, on by default), and the alert moves to a fired log.
- **Re-arm is price-based, not timer-based.** A fired alert stays latched until
  the price returns past a re-arm band (~0.1% beyond the level); the next
  crossing then fires. A price hovering at the level therefore cannot spam.
  Snooze is a 60-second mute of the alert (it no longer clears the latch);
  `re-arm` in the popover arms it again immediately while keeping the band.
- **Non-active symbols keep watching.** A background monitor polls the server's
  quote endpoint (10 s cadence, paused while the browser tab is hidden) for
  every symbol you have alerts on, so you still get the toast/chime while
  another symbol is on the chart. It only evaluates fresh quotes — a stale or
  unreachable quote never fires an alert.
  The quote endpoint reads public prices from the venue or from Yahoo Finance when nothing recent is cached,
  so this watching uses the network without a subscription; see [SECURITY.md](../SECURITY.md#where-it-connects).
- **Replay is honest here too.** While the chart is in replay mode the
  book-price evaluator pauses (historical prices must not fire a "live" alert);
  the quote monitor above keeps running on live REST data.
- Limits: at most 50 alerts per symbol (oldest evicted).

Alerts are edge-triggered per crossing; removing the alert or clearing fired
entries is immediate and local.

## Watchlist

The watchlist is a small favorites rail above the DOM ladder: a persistent,
local list of `market:symbol` keys you want at a glance.

- **Add** — the `+ Add current` button adds the symbol on the chart. The list
  holds up to 30 favorites; adding a 31st is refused (nothing is silently
  evicted).
- **Select** — click a row (or press Enter on it) to switch the chart to that
  symbol; the active row is highlighted.
- **Remove** — click the star (`★`) toggle or the `×` control on a row; neither
  selects the row.
- **Quotes** — every row shows the live price and signed change with a
  sparkline, refreshed from a shared 10-second poll that pauses while the tab
  is hidden. Rows dim with a `stale` chip when the venue quote is stale;
  unreachable symbols show `—` rather than a guessed price.
- **Empty state** — until you pin something, the panel offers your recent
  symbols as one-click suggestions (suggestions don't auto-favorite).

The list persists in your browser (`flowmap.watchlist.v1`) per machine and
never leaves it.

## Drawings

Annotate the chart with the drawing toolbar (color and clear-all included):

- **Tools**: trendline, horizontal ray, rectangle, Fibonacci retracement,
  horizontal line, and text.
- **Edit**: select a drawing to move or resize it; delete removes it.
- **Persistence** is per market:symbol in `localStorage` — your BTCUSDT
  trendlines are waiting for you next session, and your ETHUSDT chart is not
  polluted by them.
- Anchors are stored in **chart space** (price + time), so drawings follow the
  data when you pan, zoom or replay — not the pixels.

`Esc` deselects/cancels the armed tool. Drawing overlays sit above the heatmap
and never eat chart pan/zoom unless a tool is armed.

## Indicators & candles

On top of the liquidity heatmap you can synthesize classic price structure from
the same stream:

- **Candles** — OHLC bars built from the tape/price stream, with a selectable
  interval (1m, 5m or 15m; 1m is the default), drawn in sync with the depth columns. After a reconnect,
  candles and indicators start again from the new data, so a feed gap is never bridged with stale bars.
- **Indicators** — a picker with editable parameters covering the common
  indicators: **EMA, SMA, VWAP and Bollinger** draw as overlays on the price
  scale, and **RSI, MACD, ATR and OBV** draw in their own sub-panes. Overlays
  draw on a canvas riding the same price scale as the heatmap; the sub-panes
  align to the chart's time axis.

Kernels are pure, unit-tested functions; the overlay is a visualization of
exactly the column data the server delivered.

## Themes & language

- **Themes** — press `T` to cycle seven palettes: `midnight` (the default dark,
  identical to the original palette), `paper` (light), `swiss` (high-contrast
  light), `amber` (warm dark terminal), `sea` (deuteranopia-safe: the sell side
  reads blue, warnings violet), `paper-deut` (light deuteranopia: teal bid /
  blue ask) and `contrast` (true-black, maximum-contrast ink). First launch
  follows your OS light/dark preference; your explicit choice persists. Canvas
  overlays (grid, axes, markers) follow the theme, not just the chrome.
- **Interface style** — the window is drawn in a pixel style: square controls, hard shadows, the
  Pixelify Sans face and the pixel FlowMap mark, in the colours of the active theme. The chart keeps
  the smooth style: the heatmap, price line and trade bubbles, and the parts drawn on or beside it
  (axes, crosshair readout, legends, measure tool, drawings, alert lines, indicators and the CVD
  pane). There is no setting for this.
- **Language** — the interface ships in English with a Turkish translation of
  the shell (top bar, settings drawer, banners, shortcuts overlay, onboarding,
  toasts). The choice persists; missing translations fall back to English
  text, never to raw key names. Feature panes are English-only for now (see
  the [roadmap](../ROADMAP.md)). The typefaces (Inter and JetBrains Mono) are bundled with the
  app, so text renders the same offline.
- **About** — Settings → *About and legal* shows the version, the Apache-2.0 licence, the
  data-source attribution, the data-delay notice and the not-investment-advice
  statement. In the desktop app it also opens the log folder, for attaching a log
  to a bug report.

## Intelligence drawer

The Research drawer shows real data from free public sources, with no key needed for any of them. Open it
from the **Research** button in the top bar, or press `J`. The tabs follow the active symbol's market:

- **US stock:** four tabs, **DOCS**, **GOV**, **FLOW** and **GEO**.
- **Crypto coin:** four tabs, **PERP**, **OPTIONS**, **MARKET** and **SENTIMENT**.
- **Other markets:** a note that the drawer does not cover them.

**MACRO** is a footer bar at the bottom of the drawer, with SOFR, HY OAS, 10Y-2Y and a heuristic stress
regime.

### US stock tabs

- **DOCS**
  - *Risk factor changes* (SEC EDGAR): the two newest 10-K or 10-Q filings that have a Risk Factors section
    (Item 1A) of at least 500 characters. The drawer lists the paragraphs added in the newer filing and the
    paragraphs it dropped. Paragraphs that contain a term from a fixed list (going concern, material weakness,
    restatement, investigation, subpoena, default, impairment, cybersecurity incident) are marked as triggers.
    The list shows changed text only; it does not rate how much a change matters.
  - *Management language* (SEC EDGAR): the two newest earnings releases, filed on Form 8-K under Item 2.02 with
    an Exhibit 99 attached. The drawer shows how often hedging words and uncertainty words appear per 1,000
    words, for the newest release and the one before it, the change between them, and the two release dates.
    The word lists are the app's own short lists. The safe-harbour paragraphs that repeat in every release
    (those that mention forward-looking statements) are left out. This measures the written release, not the
    audio of the call.
- **GOV**
  - *Government contracts* (USAspending.gov): award recipients matching the company's name, contract award
    types A to D, over the last 365 days. The drawer shows up to 10 awards, largest first, with recipient,
    agency, amount, date and description. The total shown is the total of those listed awards, not the
    company's total. A company with no matching award shows an empty result.
  - *House trades* (House Clerk): Periodic Transaction Reports filed by House members, for this ticker,
    newest transaction first, up to 25 rows. Each row shows the member's name, state and district, the
    member's committees, the transaction type, the amount range and the date. See
    [House reports](#house-reports) for the coverage line.
- **FLOW**
  - *Gamma exposure* (Cboe delayed quotes): the model described under GEX below, with the call wall, the put
    wall, the gamma flip and the put/call open-interest ratio.
  - *Short-sale volume* (FINRA Reg SHO): the newest daily file and the four before it, with short volume,
    short-exempt volume, total volume, the short ratio and the 5-day average ratio.
- **GEO**
  - *Hiring* (public Greenhouse, Lever and Ashby job boards): the provider named, total open positions,
    open research and development positions, positions first published in the last 30 days and in the 30 days
    before that, and the change between the two, with a status of expanding (more than +10 %), slowing (less
    than -10 %) or steady. The app reads only companies that publish on one of these three boards. Companies
    on other systems show "not applicable". The app does not read Workday.
  - *Corporate jets*: no source. The section says so and makes no request. No free registry maps aircraft
    to listed companies.

### Crypto tabs

- **PERP** (Binance USDⓈ-M perpetual futures): the funding rate and its annualized figure, the next funding
  time, open interest in coins and in USD, the long/short account ratio and the taker buy/sell ratio. Only
  coins with a USDT perpetual on Binance have this tab's data.
- **OPTIONS** (Deribit, BTC and ETH only): gamma levels (net GEX, call and put walls, gamma flip), the
  put/call open-interest ratio and max pain for the nearest monthly expiry. Other coins show "not applicable",
  because Deribit lists no options on them.
- **MARKET** (CoinGecko, and DefiLlama for TVL): price change over 24 hours, 7 days and 30 days, market-cap rank,
  circulating, total and maximum supply, the distance from the all-time high, and total value locked (TVL)
  when DefiLlama lists the coin. Only the 250 largest coins by market cap are covered; a smaller coin shows
  "not applicable".
- **SENTIMENT** (alternative.me Fear & Greed index): the current value and label, and the 7-day and 30-day
  path. The index covers the whole crypto market, not one coin, so the same figures show on every coin.

### Section statuses

Each section shows one of these states:

- **Data:** the figures from the source, with the source's name.
- **Nothing for this symbol:** the source answered and has no record for this symbol (for example no
  award, or no filing with enough risk-factor text). The drawer says so; it does not show a zero.
- **Not applicable:** the section cannot apply to this symbol, and the drawer gives the reason (for example
  no public job board, no perpetual futures, or no options market).
- **Source unavailable:** the source could not be read, and the drawer gives the reason. A reason that the
  SEC contact is missing names the place to set it (see below).
- **Last successful read:** when a refresh fails and an earlier result exists, the drawer shows that earlier
  result with the time it was read.

A dash means no value, and the reason for it is shown next to the dash. The drawer never fills a gap with
an estimate.

### SEC contact e-mail

The two SEC sections (risk factor changes and management language) need a contact e-mail. SEC EDGAR asks
automated clients to name a contact in each request, and it refuses requests that do not. Enter one under
**Settings → Data**, in the field **SEC contact e-mail**. The app sends it only in the request's User-Agent
header to SEC's hosts (`www.sec.gov` and `data.sec.gov`), and only when you have entered one. The field goes
from the app to its own local server in a request header, never in a web address. Without a contact e-mail,
the two SEC sections show "source unavailable" with the reason and make no request. The
`SEC_CONTACT_EMAIL` environment variable can supply the same value when the field is empty; the field wins
when both are set.

### House reports

The House Clerk publishes each Periodic Transaction Report as a PDF. On first use the app starts reading the
current and previous year's reports in the background, newest first, and keeps the parsed rows on disk under
the app data folder (the PDFs themselves are not kept). The GOV tab answers from the reports read so far, and
its coverage line says how many reports have been read, for example "read 120 of 468 reports". Reports that
have no text (scanned paper filings) cannot be read and are counted as unreadable. A ticker that appears in a
report not yet read will show only after that report is read.

### GEX

- **GEX** (gamma exposure) is a model. Its sign convention (calls positive, puts negative) is an assumption
  and does not establish dealer positioning. The gamma flip appears only when a sign change exists in
  observed option data.

### Other notes

- Text sources are summarized and measured, not scored. A filing without a risk section does not produce a
  risk warning.
- Every view shows only what its connected sources supply. It never fills a gap with sample figures. Demo
  content comes only from `sim:SIM-DEMO`.
- The Research drawer's tab labels and source names are English-only in this release.

## Keyboard & pointer reference

Press `?` in the app for the live overlay, which is built from
`client/src/ui/keysheet.ts`. The table below is maintained by hand. It adds the
chart-canvas and pointer gestures, which the overlay describes in one row. The
test `scripts/test_keyboard_reference.py` fails when a key the overlay shows is missing
from this table. Update both when a binding changes.

| Input | Action |
|---|---|
| `Space` | Follow the live edge · play/pause in replay |
| `/` or `Ctrl+K` / `⌘K` | Symbol search palette |
| `E` | Export the chart as a PNG download |
| `M` | Measure tool — drag on the chart for Δprice / Δtime / Δdepth |
| `A` | Price alert at the crosshair price (list: bell button on the chart) |
| `H` | Perf HUD — fps / frame ms / uploads / draws / cache |
| `C` | Cycle depth channel: sum → bid → ask → imbalance |
| `T` | Cycle theme (midnight → paper → swiss → amber → sea → paper-deut → contrast) |
| `D` | Toggle the draw toolbar (trendline · horizontal line · ray · rectangle · Fibonacci · text) |
| `I` | Toggle the indicator picker |
| `J` | Toggle the intelligence drawer |
| `Del` | Delete the selected drawing |
| `Ctrl+Z` | Undo drawings · `Ctrl+Shift+Z` / `Ctrl+Y` redo |
| `?` | Toggle the shortcuts overlay |
| `←` `→` `↑` `↓` | Pan time / price (chart focused) |
| `+` / `−` | Zoom time (chart focused) |
| `]` / `[` | Zoom price in / out (chart focused) |
| `Shift`+`↑` / `Shift`+`↓` | Zoom price in / out (chart focused); still works with single-key shortcuts off |
| `F` | Toggle time follow (chart focused) |
| `P` / `Shift+P` | Price track on/off · re-fit price |
| `R` | Return to the live edge |
| `Esc` | Close dialogs (search · settings · shortcuts) · cancel a measure drag · deselect a drawing |
| Wheel on chart | Zoom time at the cursor column |
| `Shift`/`Ctrl` + wheel | Zoom price at the cursor row |
| Drag on chart | Pan both axes (natural drag) |
| Wheel on price gutter | Zoom price at the cursor row |
| Vertical drag on price gutter | Scale the price axis about the viewport centre |
| Double-click on price gutter | Re-fit the price axis |

**Single-key shortcuts.** Settings → *Keyboard* → *Single-key shortcuts* turns off the single-character shortcuts: `Space`, `/`, `E`, `M`, `A`, `H`, `C`, `D`, `I`, `J`, `F`, `P`, `R`, `T`, `?`, and the chart's `+`, `−`, `[` and `]`. Chords with Ctrl or Cmd (such as `Ctrl+K` and `Ctrl+Z`) keep working, and so do the mouse gestures and the arrow keys. The arrow keys are not characters, so with the switch off they still pan the chart, and `Shift`+`↑` and `Shift`+`↓` still zoom the price axis. While the switch is off, the rows that need a single key are marked off in the `?` overlay and in the Settings keysheet. The choice is kept in this browser.

## Export

Two exports, both local:

- **Chart PNG** — `E` or the TopBar camera button renders the heatmap plus
  overlays (crosshair, markers, axes) to a PNG download. This is a picture of
  what you see.
- **Raw column data** — the server streams the finalized density grid. The examples below are for a source
  run, which listens on port 8720 and sets no session token. The installed app needs its per-launch session
  token for this API, and that token is not shown, so export from a source run:

  ```bash
  # last 240 columns (default) of the active session as CSV
  curl -OJ "http://127.0.0.1:8720/api/export?format=csv"

  # explicit symbol, JSON, last 1000 columns
  curl -s "http://127.0.0.1:8720/api/export?format=json&columns=1000&symbol=binance:BTCUSDT" -o btc.json
  ```

  CSV starts with a `#` metadata comment (symbol, market, tick, column
  cadence, extents) then one row per column of raw bid/ask values per price
  row; JSON is `{"symbol","tick","columns":[{"t0","bids","asks"}]}`. `columns`
  is clamped to what the ring still holds; oversized requests are refused with
  a structured error rather than truncated silently.

## Health endpoint

`GET /api/health` answers "is the server alive?" and needs no session token, though the Host
check still applies. Without a token it returns only `status`, `version`, `protocol_version`, `uptime_s` and
`recording_enabled`. The operational snapshot is returned to requests that carry the session token. Source
runs set no token, so there every request that passes the Host check gets it: recording-enabled,
the active sessions with their feed kind and live or degraded state, `config_error`, and a v3
`stats` object (when the stats producer is present; `stats_available` says
so): drop counters per source, restarts, active/rejected sessions, real
measured WebSocket latency (`latency_ms`, EMA), per-feed staleness
(`staleness_ms`), `clock_skew_ms`, and recording health (flush failures, last
flush time). The server passes the producer's snapshot through unreshaped, so
scripts can rely on field names.

## Troubleshooting

**Nothing connects / the chart is empty**

- From source, open `http://127.0.0.1:8720/api/health` in a browser. If it answers, the
  sidecar is fine and the problem is the client↔server link; if not, see the
  next point. The installed app does not use port 8720: it picks a free loopback
  port at each launch, and the uvicorn startup line in `flowmap-server.log` names
  the port it bound.
- From source, the server logs to **stderr**; set `FLOWMAP_LOG_FILE=<path>` to
  also tee logs to a file. That file rotates at 20 MB, keeping three numbered
  backups. The desktop app spawns the sidecar itself and restarts it if it dies
  mid-session. Its output goes to `flowmap-server.log` in the app-data folder,
  which moves to `flowmap-server.previous.log` at 20 MB; `shell.log` holds the
  shell's own messages. The paths for each OS are in [SECURITY.md](../SECURITY.md#what-it-writes).

**WebSocket closes with `1008 — origin not allowed`**

The server only accepts browser origins it knows (localhost/127.0.0.1 dev
origins and the Tauri webview origins). If you serve the client from a
different origin, set `FLOWMAP_WS_ALLOWED_ORIGINS` to a comma-separated list
(e.g. `http://192.168.1.10:5173`) — or `*` to disable the check entirely on a
machine where that is acceptable. Requests with no `Origin` header
(non-browser tools like `curl`/scripts) are never blocked.

**HTTP 400 `host not allowed`, or WebSocket close `4400`**

The server answers only to `127.0.0.1`, `localhost` and `[::1]` (with an optional port) in the `Host`
header. Open the client at one of those names. Other names are refused by design, which blocks DNS
rebinding.

**HTTP 401, or WebSocket close `4401`**

An API call arrived without the installed app's session token. The app creates a new token at each
launch and gives it only to its own window, so opening an `/api/*` address in another browser tab
gets this error by design. Use `GET /api/health` for a liveness check; it needs no token. The token is
not shown to you, so scripts cannot use the installed app's API; for scripted access, run the server
from source, where no token is set. From source, this error means `FLOWMAP_SESSION_TOKEN` is set in
your environment. Clients send the token in the `X-FlowMap-Token` header (HTTP). A browser WebSocket offers it as the
subprotocol `flowmap.auth.<token>`. On a WebSocket, the `token` query parameter is also accepted for command-line tools.

**WebSocket closes with `1013 — connection cap reached`**

Too many simultaneous WS connections for one server process (default cap 16,
`FLOWMAP_WS_MAX_CONNECTIONS`). Close stale tabs/scripts or raise the cap.

**Subscribe refused: limit / no-recording / no-feed**

Session cap is 4 (`FLOWMAP_MAX_SESSIONS`). Replay of a symbol with recordings
disabled or missing is refused with an explicit reason — nothing is faked.
Recordings live in the app data directory of the installed app, and under
`~/.flowmap/recordings/` for a source run. Set `FLOWMAP_DATA_DIR` to move them
(see [SECURITY.md](../SECURITY.md#what-it-writes)).

**vite fails to start on Windows**

vite's dev server can fail when the repo path contains non-ASCII characters.
Check out to an ASCII-only path, or use `scripts/dev-windows.ps1`, which
resolves the real path first.

**Port conflicts**

From source, `FLOWMAP_PORT` moves the server. The dev client connects to `FLOWMAP_DEV_SERVER_PORT` when it is set, and otherwise to
`FLOWMAP_PORT` (`client/vite.config.ts`), so setting `FLOWMAP_PORT` alone moves both. The packaged app
picks a free loopback port itself, so a stuck 8720 cannot block it.
