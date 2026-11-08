# Security

FlowMap ships **installers that are not yet signed** — an Apple Developer ID and a Windows
publisher certificate are planned but not in place. So your OS will warn you, and it is
right to: an unsigned binary from an unknown developer is, on its face, indistinguishable
from malware. "The source is open" is not an answer, because the source is not what you
downloaded.

This file is the answer. Everything below is checkable — by you, without trusting the
maintainer.

## Verify what you downloaded

Every installer in a release is signed with a **SLSA build-provenance attestation** at build
time ([`.github/workflows/release.yml`](.github/workflows/release.yml), publish job). The
attestation is a Sigstore-backed statement that binds the file's SHA-256 digest to this
repository, this workflow file, and the exact commit it was built from. GitHub stores it
publicly; nothing on the release page can forge it.

```bash
# needs the GitHub CLI: https://cli.github.com
gh attestation verify ~/Downloads/<the-file-you-downloaded> -R nazmiefearmutcu/flowmap
```

A pass prints the workflow and commit that produced the file. **A failure means the file did
not come from this repository — do not run it.**

> Attestations and `SHA256SUMS` are produced by the release workflow from the **next tagged
> release onward**. Assets on v1.3.0 and earlier were built before this existed and will not
> verify — that is their age, not tampering, and it is exactly the gap this closes.

Each release also carries a `SHA256SUMS` asset covering every installer, the release's
`THIRD-PARTY-NOTICES.txt` (which includes the two font licence texts), `LICENSE` and `NOTICE`, for a
check that needs no tooling at all:

```bash
shasum -a 256 -c SHA256SUMS      # run it in the folder you downloaded into
```

Before a release is published, the publish job downloads every uploaded installer again and
compares its bytes with `SHA256SUMS`, so a clobbered or corrupted upload cannot be published.
Publication runs in the `release` GitHub Environment. When the repository sets required reviewers
on that environment, each publish waits for an approver. A tag only builds after the full CI gate
passes on the tagged commit.

The checksums tell you the file arrived intact. The attestation tells you *where it came
from*. Prefer the attestation; the checksums are the fallback.

## The unsigned-app warning

Once a download verifies, the OS warning is about a missing certificate — not about the file
being unknown to you. Getting past it:

- **macOS 15 and later:** the right-click → Open bypass no longer works. Try to open the app,
  then open **System Settings → Privacy & Security** and choose **Open Anyway**. On older
  macOS, right-click → **Open** works. `xattr -cr /Applications/FlowMap.app` is the terminal
  alternative.
- **Windows:** SmartScreen → **More info** → **Run anyway**.

Do this **after** `gh attestation verify` passes, not before. If you are not willing to do it
in that order, run from source instead — it is a supported path, not a fallback:

```bash
./scripts/dev.sh          # Python 3.13 + uv, Node 22.13+ + npm; no binary to trust
```

## What FlowMap is, from a security point of view

A market-data **viewer**. It reads public market data and draws it. It places no orders, holds
no funds, and has no code path that could.

| | |
|---|---|
| Wallets, private keys, seed phrases | **Never asked for, no code to accept them** |
| Trading / withdrawal API keys | **Never asked for.** The optional keys below are read-only *market data* keys |
| Telemetry, analytics, crash reporting | **None.** No SDK, no beacon, no first-run ping |
| Auto-updater | **None.** The Tauri build enables no updater or shell plugin — an update is a download you initiate |
| Network listener | `127.0.0.1` only, on port `8720` in source runs; the installed app picks a free loopback port at each launch. Any non-loopback `FLOWMAP_HOST` is rejected with `ValueError` at startup ([`server/src/flowmap_server/config.py`](server/src/flowmap_server/config.py)), not silently accepted |
| Host header | Only loopback names are served: `127.0.0.1`, `localhost` and `[::1]`, with an optional port. Anything else gets HTTP 400 (WebSocket close 4400), which blocks DNS rebinding |
| Session token (installed app) | A 32-byte random token is generated at each launch and required on every request (except the health probe and CORS preflight) and on every WebSocket connection (see below) |
| Browser origins accepted | Any `http` origin on a loopback host (`127.0.0.1`, `localhost`, `[::1]`), on any port, plus the desktop shell origins (`tauri://localhost`, `https://tauri.localhost`, `http://tauri.localhost`). `FLOWMAP_WS_ALLOWED_ORIGINS` replaces this list when it is set |
| Elevated privileges | None. The Windows `-setup.exe` installs per-user, no admin |

## The local API and its session token — plainly stated

The sidecar's HTTP and WebSocket endpoints (`/api/*` and `/ws` on `127.0.0.1`, on port `8720` in
source runs and on a per-launch free port in the installed app) are protected in two layers. The one
exception is `/api/health`, the liveness probe, which is exempt from the token (see point 2).

1. **Host check, always on.** A request whose `Host` header is not a loopback name is refused.
   A web page cannot reach the API by rebinding its own domain to `127.0.0.1`.
2. **Session token, installed app.** The desktop shell generates a fresh 32-byte token at each
   launch, passes it to the server, and gives it only to its own webview. Every HTTP request
   must send it in the `X-FlowMap-Token` header. A browser cannot set headers on a WebSocket, so
   the client offers the token as a WebSocket subprotocol, `flowmap.auth.<token>`, next to
   `flowmap.v1` (sent in the `Sec-WebSocket-Protocol` header). The server accepts that entry and never echoes it
   back in the handshake. A non-browser client may send the `X-FlowMap-Token` header on the handshake instead. On a
   WebSocket, the `token` query parameter is still accepted for command-line tools only, and the
   server redacts its value from its access and error logs. Requests without a valid token get HTTP 401
   (WebSocket close 4401).
   `/api/health` and CORS preflight requests are exempt so that readiness probes work. Any page on a
   loopback origin can read `/api/health` through CORS, so a request without the token gets only the
   status, the version, the wire protocol version and the uptime. The feed list, session identifiers,
   statistics and configuration errors are returned only to requests that carry the token.
   Source runs and the browser dev server do not set a token; the check is then skipped and only
   the Host check applies.

Threat model, honestly drawn:

- **In scope:** web pages in your browser, other browser tabs, DNS rebinding, and remote parties.
  A web page cannot read the token, cannot satisfy the Host check through a rebinding domain, and
  the server never binds a non-loopback address (enforced twice, in `Config.from_env` and again at
  the entrypoint).
- **Out of scope:** a malicious process already running as your user. It can read the token from
  the processes that hold it, and it can read the API, your browser cookies, SSH keys, and
  everything else you own. No in-app authentication changes that; the operating system's user
  account is the real boundary.
- **Known residual risks:** any local process running as your user can read your session
  recordings, consume the API while FlowMap runs, or, in a source run on the default port, claim
  port 8720 before FlowMap starts. CORS is enforced by browsers only; it is not a defense against
  non-browser local processes. If this threat model does not fit your environment (for example a
  shared or untrusted machine), run FlowMap there only from source behind a firewall rule that blocks
  8720 for other local users, or do not run it there.

Any future tightening (for example per-origin pinning of the WebSocket origin list) will be
announced in the changelog rather than applied silently.

## The desktop webview

The installed app's window runs under a Content Security Policy set in
[`app/src-tauri/tauri.conf.json`](app/src-tauri/tauri.conf.json):

- scripts load only from the app itself (no `eval`, no inline scripts); styles load from the app,
  and inline styles are allowed;
- images come from the app, plus `data:` and `blob:` URLs; fonts come from the app only;
- workers come from the app and `blob:` URLs; media, frames, plugins (`object-src`) and form
  submissions are blocked (`'none'`);
- network connections go to the app itself, the Tauri IPC channel, and the loopback sidecar
  (`http://127.0.0.1:*` and `ws://127.0.0.1:*`).

The sidecar's port is chosen at each launch, and a policy cannot name a port that is not known when
it is written, so the loopback rule allows any port on `127.0.0.1`. Nothing else on the network is
reachable from the window, and the sidecar refuses any request without the session token or with a
non-loopback `Host` header (see above).

No other origin can be fetched from the window. The typefaces (Inter and JetBrains Mono, under the
SIL Open Font License) are bundled with the app, so the window needs no network for text. The browser
dev server is not under this policy, because it is not the packaged app.

## Where it connects

Outbound traffic is market data. It comes from three paths, and only the first needs a subscription:

- **A subscribed feed** contacts the hosts in its row of the table below while the session runs.
- **Display quotes and movers** need no subscription. The watchlist rows, the background alert monitor
  (for each symbol with an alert), the symbol palette and its movers list call the local
  `GET /api/quote` and `GET /api/movers` endpoints. On a cache miss the server fetches a public price for
  that symbol from the hosts in the display rows below, and it caches the result.
- **Warm-up at launch** needs no subscription and no chosen symbol. Once the server starts, it refreshes the
  movers candidates (the crypto shortlist and the first 40 equity tickers) about every 30 seconds, and it
  makes one pass over the bundled crypto and equity symbol lists to fill the symbol palette's previews.
  These calls use the same hosts as the display rows below.

The table lists every host these paths can contact. The feed you subscribe to, the display quotes you look at
and the launch warm-up decide which hosts are contacted.

| Feed | Host(s) | Notes |
|---|---|---|
| Crypto venues (subscribed feed) | the public REST/WebSocket endpoints of the venue the session subscribes to, reached through the bundled Crocodile engine (native connectors for binance, bybit, coinbase, deribit, okx; other venues through `ccxt`) | Public endpoints: no key, no account |
| Crypto display quotes, movers and warm-up | `api.binance.com`, `fapi.binance.com`, `dapi.binance.com` for Binance symbols (the same klines as the backfill row); other venues' public OHLCV through `ccxt`. Movers always read Binance spot, from a fixed shortlist | Display only, no subscription. A quote uses the venue of its watchlist or alert row |
| Crypto history backfill | `api.binance.com`, `fapi.binance.com`, `dapi.binance.com` ([`core/backfill.py`](server/src/flowmap_server/core/backfill.py)) | On by default for the first subscribe; `FLOWMAP_BACKFILL_ENABLED=0` turns it off |
| US equities, keyless last price | `www.google.com/finance` page scrape (default when no keyed source is configured) | Unofficial page scrape, used only by a subscribed keyless equity feed; display quotes use Yahoo. Its terms of use may not permit this use, and the maintainer has not confirmed them. Treat the price as informational |
| US equities, keyless history and display quotes | `query1.finance.yahoo.com` / `query2.finance.yahoo.com` chart endpoint | Unofficial, undocumented endpoint with a generic `User-Agent`; history can stop without an error on screen. Watchlist, alert, equity-movers and warm-up quotes use it without a subscription |
| US equities, optional upgrades | Alpaca (`ALPACA_API_KEY` + `ALPACA_API_SECRET`), Finnhub (`FINNHUB_API_KEY`) | **Market-data** credentials, read from your environment. A source run reads them from its shell. The installed app passes these three variables from your environment to its server (its shell passes a fixed list of variables, see [`sidecar.rs`](app/src-tauri/src/sidecar.rs)) |
| Macro, dark pool, politics, aviation, contracts, headcount | `api.stlouisfed.org` (FRED), `cdn.finra.org`, the House Stock Watcher S3 bucket, `opensky-network.org`, `api.usaspending.gov`, `boards-api.greenhouse.io` | Public data sources. Their feed modules exist, but no producer is started in this build, so these hosts are not contacted today |
| `sim:SIM-DEMO` feed | none | No network at all. Use it to watch what the app does before giving it a live source |

The WebGL2 client loads **no** external origin: no CDN, no web fonts, no analytics. Its typefaces
are bundled with the app, and everything it renders comes from the loopback server.

## What it writes

Where FlowMap writes depends on how you run it.

**Installed app** (the app data directory, shown per OS):

| OS | App data directory (`<data>`) |
|---|---|
| Windows | `%APPDATA%\com.nazmiefearmutcu.flowmap\` |
| macOS | `~/Library/Application Support/com.nazmiefearmutcu.flowmap/` |
| Linux | `~/.local/share/com.nazmiefearmutcu.flowmap/` |

- `<data>/recordings/{market}/{symbol}/…parquet` — the session recordings that let you replay
  a session, and `<data>/recordings/warehouse.duckdb`, the local intelligence store (see below).
  **Recording is on by default in the installed app.** The first-run tour says so and says where the
  files go. Settings → Data → *Record market data* turns it off or on; a change restarts a running
  engine, so it applies at once. The choice is kept in `<data>/recording.json` (`{"enabled": false}` or
  `{"enabled": true}`), so it can also be set there before launch. A missing file means recording is on.
  Run from source with `FLOWMAP_RECORDING_ENABLED=0` to turn it off. A **soft** global cap (default **20 GB**,
  `FLOWMAP_RECORDING_GB_CAP`) deletes the oldest recording parts as the total grows. Parts named
  `*-epochs-*` are never deleted, so the total can stay above the cap when only those remain.
- `<data>/flowmap-server.log` — the server's output, captured by the shell. At 20 MB the file moves
  to `flowmap-server.previous.log`, replacing the older copy, and a new file starts. A log written by an
  earlier build may hold a session token from a `token=` query string, because that build put the token in
  the URL. Delete such logs before you share them; the token itself ends with the launch that issued it.
- `<data>/shell.log` — the shell's own lifecycle messages. When it has grown past 1 MB, the next launch moves it to `shell.previous.log`.
- `<data>/flowmap.lock`, `<data>/native-info.json` and `<data>/webview-cache/` — the single-instance
  lock, the native shell's diagnostics, and the WebView's own cache.

**Run from source:** the server's own default is to record into `~/.flowmap/recordings/`
(`FLOWMAP_RECORDING_ENABLED` defaults to `1`). The dev launchers `scripts/dev.sh` and
`scripts/dev-unix.sh` start with recording **off** unless you set `FLOWMAP_RECORDING_ENABLED=1`.
`scripts/dev-windows.ps1` starts with recording off unless you pass `-EnableRecording` or set
`FLOWMAP_RECORDING_ENABLED=1`. `FLOWMAP_LOG_FILE`, when set, is rotated at 20 MB with three numbered
backups (`.1` to `.3`). Source runs write to these places and nothing else outside the repository: the recordings folder
(`FLOWMAP_DATA_DIR`, or `~/.flowmap/recordings`); the intelligence store (`warehouse.duckdb` and DuckDB's
`*.wal` files beside it, in `FLOWMAP_DATA_DIR`, or `~/.flowmap/intelligence`); and `raw-capture/<capture_id>/`
under the recordings folder when raw capture is on (`CROCODILE_RAW_CAPTURE=1`, off by default; the installed
app never sets it). `FLOWMAP_LOG_FILE`, when set, names the one log file.

**The intelligence store.** `warehouse.duckdb`, with DuckDB's `*.wal` files beside it, is written to `FLOWMAP_DATA_DIR` when that is set and
to `~/.flowmap/intelligence/` otherwise. The installed app sets `FLOWMAP_DATA_DIR`, so its copy is
under `<data>/recordings/`. A database left in `./.flowmap_data/` by an earlier build is not read;
move it by hand if you need it.

## What is in the installer

The installers are large because they are self-contained: the built WebGL2 client,
a relocatable CPython 3.13 from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone), the
Python dependencies from `server/pyproject.toml`, and the Tauri shell.

Nothing is fetched at first run, with one exception: **on Windows, when the WebView2 runtime is
missing, the installer downloads Microsoft's WebView2 bootstrapper** from Microsoft's servers
during installation. The bootstrapper is Microsoft's; FlowMap does not change it.

Each release attaches `THIRD-PARTY-NOTICES.txt`, with one section per installer platform (Windows x64,
Windows arm64, macOS arm64, macOS x86_64 and Linux) for the Python distributions in that platform's
bundled runtime, and shared sections for the production packages of the web client and the Rust crates
of the desktop shell, each with the version and the licence it declares. A package that declares no
licence is listed as `UNKNOWN` and is checked by the maintainer before publication. The installers also
carry this repository's `LICENSE` and `NOTICE`.

The dependency set is deliberately small and pinned. The market-data engine (Crocodile) is a
**vendored wheel**, `server/vendor/crocodile-0.3.2-py3-none-any.whl`, declared as a path source in
[`server/pyproject.toml`](server/pyproject.toml) and recorded with its sha256 in `server/uv.lock`. The
installers install every Python dependency with `pip install --require-hashes` from an export of that
lock that carries each artifact's sha256, so the hashes are checked at install time, not only recorded. Before that install, a guard (`app/scripts/requirements_pins.py check-hashes`) fails the build if any requirement has no hash.
The rest are mainstream libraries — `aiohttp`,
`certifi`, `msgspec`, `numpy`, `polars`, `fastapi`, `uvicorn`. Every GitHub Action used in CI and
release is pinned to a commit SHA rather than a moving tag.

## Accepted risks

Two items below are deliberate trade-offs. Both are documented so that they are not mistaken for oversights.

- **The loopback connection rule.** The webview may connect to any `127.0.0.1` port, not one fixed port,
  because the sidecar's port is chosen at each launch and a policy cannot name a port that is not known when it
  is written. The rule matters only if the app's own webview content were compromised. A page in a browser cannot
  use the webview's policy, and the sidecar still refuses requests without the session token or a loopback `Host`
  header.
- **The WebView2 bootstrapper.** On Windows, when the WebView2 runtime is missing, the installer downloads
  Microsoft's bootstrapper over HTTPS during installation (see [What is in the installer](#what-is-in-the-installer)).
  FlowMap does not pin or verify its hash. The download is Microsoft's own, and FlowMap keeps it because the
  runtime is required for the window to open.

## Reporting a vulnerability

Please report privately. Open a [private security advisory](https://github.com/nazmiefearmutcu/flowmap/security/advisories/new)
on the repository — that keeps the report non-public until there is a fix. Please do not open a
public issue for a vulnerability. Include what you ran, what you observed, and how to reproduce it.

Only the latest release is supported; fixes go out as a new tagged release, and the advisory is
published with it.
