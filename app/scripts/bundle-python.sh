#!/usr/bin/env bash
#
# bundle-python.sh — build a relocatable, self-contained Python runtime that runs
# the FlowMap server, for embedding in the FlowMap desktop app as a Tauri
# resource. Cross-platform: macOS (arm64/intel), Windows (x86_64/arm64) and Linux
# (x86_64/arm64).
#
# Strategy: download astral's `python-build-standalone` CPython 3.13 for the
# requested target triple (the `install_only` tarball — already relocatable)
# into app/src-tauri/resources/pyruntime, then install the flowmap-server + its
# deps INTO that runtime's own site-packages so the whole tree is
# self-contained. Dependencies (incl. the vendored crocodile engine wheel) come
# from the server's uv.lock so the bundle matches the tested resolution exactly.
#
# Because native wheels (numpy/polars/msgspec/curl-cffi …) are platform-specific,
# each OS's runtime MUST be built on that OS — this is why the release workflow
# runs this script once per matrix runner rather than cross-building.
#
# Usage:
#   bundle-python.sh [TARGET_TRIPLE] [--clean]
#
#   TARGET_TRIPLE (default: aarch64-apple-darwin — keeps the historic macOS
#   arm64 behavior when invoked with no arguments). Supported:
#     aarch64-apple-darwin      x86_64-apple-darwin
#     x86_64-pc-windows-msvc    aarch64-pc-windows-msvc
#     x86_64-unknown-linux-gnu  aarch64-unknown-linux-gnu
#
#   --clean   also drop the cached tarball before rebuilding.
#
# On Windows this script is designed to run under Git-Bash (the shell that ships
# with GitHub's windows runners); paths handed to the native `uv`/`python.exe`
# executables are converted to native form via `cygpath`.
#
# Idempotent: re-running rebuilds the runtime from a cached tarball.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
RES_DIR="$REPO_ROOT/app/src-tauri/resources"
PYRUNTIME="$RES_DIR/pyruntime"
CACHE_DIR="$RES_DIR/.cache"

PBS_TAG="20260623"          # python-build-standalone release tag
PY_SERIES="3.13"           # CPython series to bundle

# --- Parse args (triple and/or --clean, order-independent) --------------------
TRIPLE=""
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    -*)      echo "ERROR: unknown flag '$arg'" >&2; exit 2 ;;
    *)
      if [[ -n "$TRIPLE" ]]; then
        echo "ERROR: multiple target triples given ('$TRIPLE', '$arg')" >&2; exit 2
      fi
      TRIPLE="$arg"
      ;;
  esac
done
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"

case "$TRIPLE" in
  *windows*) OS_KIND="windows" ;;
  *apple*)   OS_KIND="macos" ;;
  *linux*)   OS_KIND="linux" ;;
  *) echo "ERROR: unrecognized/unsupported target triple '$TRIPLE'" >&2; exit 2 ;;
esac

# Convert a path to the native form the platform's tools expect. On Windows +
# Git-Bash the native `uv`/`python.exe` need Windows paths (C:\…), not the MSYS
# `/c/…` form; everywhere else this is the identity function.
native_path() {
  if [[ "$OS_KIND" == "windows" ]] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

echo "==> FlowMap Python runtime bundler"
echo "    triple:    $TRIPLE ($OS_KIND)"
echo "    repo:      $REPO_ROOT"
echo "    pyruntime: $PYRUNTIME"

if [[ "$CLEAN" == "1" ]]; then
  rm -rf "$CACHE_DIR"
fi
mkdir -p "$CACHE_DIR"

# --- 1. Resolve + download the install_only tarball ---------------------------
# Match the GitHub download URL for the plain (non-freethreaded, non-stripped)
# install_only tarball for the requested triple. The `+` in the version is
# URL-encoded as `%2B`.
ASSET_RE="cpython-${PY_SERIES}\.[0-9]+(%2B|\+)${PBS_TAG}-${TRIPLE}-install_only\.tar\.gz"
echo "==> Resolving python-build-standalone asset (tag $PBS_TAG)"
# Authenticate the API lookup when a token is available. Unauthenticated GitHub
# API calls are capped at 60/hour PER IP, and CI runners share egress IPs, so
# this request intermittently comes back 403 and fails the whole build. A token
# raises the cap to 5000/hour. --retry-all-errors also covers 403/429, which
# plain --retry ignores.
# API_AUTH may stay empty. Under `set -u` an empty array expansion is an
# unbound-variable error on bash 3.2 (the macOS /bin/bash), so the curl call below
# uses the ${arr[@]+...} idiom, which expands to nothing when the array is empty.
API_AUTH=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  API_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi
# A prefetched copy of the release JSON skips the API call entirely. CI can fetch
# it once, with a token, in a step of its own and pass the path here, so the build
# job itself never makes an anonymous API request.
if [[ -n "${FLOWMAP_PBS_RELEASE_JSON:-}" ]]; then
  [[ -r "$FLOWMAP_PBS_RELEASE_JSON" ]] || {
    echo "ERROR: FLOWMAP_PBS_RELEASE_JSON is not readable: $FLOWMAP_PBS_RELEASE_JSON" >&2; exit 1; }
  echo "    release metadata: $FLOWMAP_PBS_RELEASE_JSON (prefetched)"
  RELEASE_META="$(cat "$FLOWMAP_PBS_RELEASE_JSON")"
else
  RELEASE_META="$(curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 ${API_AUTH[@]+"${API_AUTH[@]}"} \
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${PBS_TAG}")"
fi
ASSET_URL="$(printf '%s\n' "$RELEASE_META" \
  | grep -oE "https://github.com/[^\"]*${ASSET_RE}" | grep -v freethreaded | grep -v stripped | head -1 || true)"
if [[ -z "$ASSET_URL" ]]; then
  echo "ERROR: could not resolve a ${PY_SERIES} ${TRIPLE} install_only asset for tag ${PBS_TAG}" >&2
  exit 1
fi
TARBALL="$CACHE_DIR/$(basename "$ASSET_URL")"
echo "    asset: $ASSET_URL"

# --- 1b. Verify the tarball against its pinned SHA-256 ------------------------
# The pins are the `digest` values GitHub publishes for the PBS_TAG release assets
# (api.github.com/repos/astral-sh/python-build-standalone/releases/tags/<tag>).
# A tarball that does not match is never extracted: the runtime becomes the
# interpreter inside every installer, so a swapped or truncated archive must
# stop the build. A cached tarball is re-checked on every run, not only when it
# is downloaded. When PBS_TAG changes, the pins change with it.
pinned_sha256() {
  case "$1" in
    aarch64-apple-darwin)      echo "804c86c8665b18eb0df5070a79d828229018d145baea38a71a5c74c03f9b11d4" ;;
    x86_64-apple-darwin)       echo "cd0023fb84de358d285c8e116cffd2f433086b943e752955dade521c12e78cab" ;;
    x86_64-pc-windows-msvc)    echo "646254b53fbac69c1b3c25131c237c9136e9bbed7444123880cea8deaf555e1f" ;;
    aarch64-pc-windows-msvc)   echo "d425c0fa7fe5e9889760b199c87e45cb84d793639ed63231f9313ffa894cb25a" ;;
    x86_64-unknown-linux-gnu)  echo "7fd02919461b368adafea3896ad082f5c4f759816d69681dcc6559bfbcd892af" ;;
    aarch64-unknown-linux-gnu) echo "1199b22c83725a339ebaef36d39476d037fb7267187513090b6cc83bb4579477" ;;
    *) return 1 ;;
  esac
}
EXPECTED_SHA256="$(pinned_sha256 "$TRIPLE")" || {
  echo "ERROR: no pinned SHA-256 for ${TRIPLE} in tag ${PBS_TAG}; refusing to use an unverified runtime" >&2
  exit 1
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
tarball_matches() {
  [[ "$(sha256_of "$1")" == "$EXPECTED_SHA256" ]]
}

if [[ -f "$TARBALL" ]] && ! tarball_matches "$TARBALL"; then
  echo "    cached $(basename "$TARBALL") does not match its pinned SHA-256; discarding it"
  rm -f "$TARBALL"
fi
if [[ ! -f "$TARBALL" ]]; then
  echo "==> Downloading $(basename "$TARBALL")"
  curl -fSL --retry 5 --retry-all-errors --retry-delay 3 -o "$TARBALL" "$ASSET_URL"
else
  echo "    (cached)"
fi
if ! tarball_matches "$TARBALL"; then
  echo "ERROR: $(basename "$TARBALL") SHA-256 mismatch (expected ${EXPECTED_SHA256})" >&2
  rm -f "$TARBALL"
  exit 1
fi
echo "    sha256 verified"

# --- 2. Extract into resources/pyruntime --------------------------------------
echo "==> Extracting runtime"
rm -rf "$PYRUNTIME"
mkdir -p "$PYRUNTIME"
# The tarball extracts to a top-level `python/` dir (all platforms); flatten it
# into pyruntime.
TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP_EXTRACT"
mv "$TMP_EXTRACT/python/"* "$PYRUNTIME/"
rm -rf "$TMP_EXTRACT"

# Interpreter location differs per platform: Windows PBS puts `python.exe` at the
# runtime root (no bin/); macOS/Linux put it under bin/.
if [[ "$OS_KIND" == "windows" ]]; then
  PY="$PYRUNTIME/python.exe"
  [[ -e "$PY" ]] || PY="$PYRUNTIME/python3.13.exe"
else
  PY="$PYRUNTIME/bin/python3.13"
  [[ -x "$PY" ]] || PY="$PYRUNTIME/bin/python3"
fi
[[ -e "$PY" ]] || { echo "ERROR: interpreter not found in $PYRUNTIME" >&2; exit 1; }
echo "    interpreter: $PY"
"$PY" -c "import sys; print('    python', sys.version.split()[0])"

# Ensure pip is present in the standalone runtime. ensurepip installs the pip wheel
# that ships inside the python-build-standalone archive, so no index is contacted;
# that archive is the one checked against its pinned SHA-256 above. The locked
# export below covers the application's own dependencies, not pip itself.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "==> Bootstrapping pip"
  "$PY" -m ensurepip --upgrade
fi

# --- 3. Install the server + its deps into the runtime ------------------------
echo "==> Exporting locked requirements from server/uv.lock"
REQS="$CACHE_DIR/flowmap-reqs.txt"
( cd "$SERVER_DIR" && uv export --locked --no-dev --no-emit-project -o "$(native_path "$REQS")" )
echo "    $(grep -cvE '^\s*(#|$)' "$REQS") requirement lines"

# --- 3b. Per-target dependency exceptions -------------------------------------
# Windows-on-ARM is the one target where the locked resolution is not installable
# as-is: three of the locked distributions publish no `win_arm64` wheel, and
# building them from sdist on an ARM64 runner is either impossible in practice
# (pyarrow = the entire Arrow C++ tree) or needs a from-source OpenSSL
# (cryptography). Each is handled by removing exactly as much as the ARM64 bundle
# can live without — and nothing more:
#
#   pyarrow            Needed by exactly one thing: crocodile's `fmt="arrow"`
#                      export. FlowMap never asks for it — its recording layer is
#                      polars, whose parquet codec is native Rust. Dropped.
#                      Note this only became safe with crocodile 2e22c90: before
#                      it, `crocodile/equity/client/__init__.py` imported the
#                      Arrow writer eagerly, so dropping pyarrow took live equity
#                      collection down with it and this gate caught it. The
#                      writer now loads pyarrow at the point of use.
#   zlib-ng            A ccxt speed-up: aiohttp_fast_zlib swaps aiohttp's gzip
#   aiohttp-fast-zlib  codec for zlib-ng (~2x faster decompression). ccxt imports
#                      it inside `try: … except ImportError: pass`, so its
#                      absence is a documented, supported configuration — the
#                      ARM64 build simply decompresses with stdlib zlib.
#   cryptography       NOT droppable: ccxt imports it eagerly at the top of
#                      base/exchange.py. 46.0.3 is the newest release that still
#                      ships a win_arm64 wheel (47.0.0 onward are win_amd64/win32
#                      only), and ccxt only touches long-stable hazmat primitives
#                      (hashes, ec, ed25519, padding, PEM loading), so it is
#                      pinned back for this target alone.
#
# The exception list is fail-loud: if a name it removes or re-pins is no longer
# in the lock — or cryptography's locked version moves — the build stops instead
# of quietly shipping a different dependency set than the one described here.
# Re-check PyPI for win_arm64 wheels before touching it.
#
# Install exactly the pins in the export. It is the complete dependency closure,
# so --no-deps stops pip from re-resolving metadata against a newer index.
# --require-hashes makes pip accept only artifacts whose sha256 is listed in the
# export (wheels and, for the source builds below, the sdist). The guard that runs
# just before the install guarantees every requirement has such a listing.
# Run from SERVER_DIR below so the vendored wheel's relative path is portable.
# Seeded with the flags every target uses, so the array is never empty: an empty
# array expansion is an "unbound variable" under `set -u` on bash 3.2, which is
# what /bin/bash still is on the macOS runners.
PIP_INSTALL_ARGS=(--no-warn-script-location --disable-pip-version-check --no-deps --require-hashes)
if [[ "$TRIPLE" == "aarch64-pc-windows-msvc" ]]; then
  echo "==> Applying the win-arm64 dependency exceptions"
  "$PY" "$REPO_ROOT/app/scripts/requirements_pins.py" win-arm64 "$(native_path "$REQS")"
  # The export is already a complete, pinned closure, so resolution adds nothing
  # — and here it would actively undo the exceptions above (pip would re-pull
  # pyarrow and cryptography==49.0.0 to satisfy crocodile's and ccxt's metadata).
  # The import check in step 5 is what proves the resulting tree is sound.
  # Keep the import gate honest: it must stop asserting what this target
  # deliberately does not ship, and assert everything else exactly as before.
  export FLOWMAP_SKIP_IMPORTS="pyarrow"
fi

# NOTE for the macOS Intel leg: ccxt pins `cryptography==49.0.0` exactly, and
# that release publishes only a `macosx_11_0_arm64` macOS wheel — no x86_64, no
# universal2 (48.0.1 was the last with one). So on x86_64-apple-darwin pip
# builds cryptography from sdist. Link Homebrew's OpenSSL statically so the
# installed app does not need the build runner's Homebrew libraries. Force a
# fresh source build: pip must not reuse a previously cached dynamic wheel.
# Rust is installed by the release/runtime-audit workflows before this step.
if [[ "$TRIPLE" == "x86_64-apple-darwin" ]]; then
  echo "==> Configuring self-contained Intel macOS cryptography"
  command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required for Intel macOS OpenSSL" >&2; exit 1; }
  OPENSSL_DIR="$(brew --prefix openssl@3)"
  for required in include/openssl/ssl.h lib/libcrypto.a lib/libssl.a; do
    [[ -f "$OPENSSL_DIR/$required" ]] || { echo "ERROR: missing OpenSSL static-build input: $OPENSSL_DIR/$required" >&2; exit 1; }
  done
  export OPENSSL_DIR OPENSSL_STATIC=1
  export OPENSSL_LIB_DIR="$OPENSSL_DIR/lib" OPENSSL_INCLUDE_DIR="$OPENSSL_DIR/include"
  PIP_INSTALL_ARGS+=(--no-cache-dir --no-binary=cryptography)
  echo "    OpenSSL prefix: $OPENSSL_DIR (static)"
fi
# Every requirement must carry the sha256 of the artifact it installs. The guard
# runs on the final file, after the win-arm64 rewrite, and stops the build when
# a line is missing its hash rather than letting pip install it unverified.
"$PY" "$REPO_ROOT/app/scripts/requirements_pins.py" check-hashes "$(native_path "$REQS")"
# The exact set this leg installs, kept per target so the release job can write
# third-party notices from the same list the installer ships.
cp "$REQS" "$CACHE_DIR/installed-requirements-$TRIPLE.txt"
echo "==> Installing dependencies into the runtime (this fetches native wheels)"
( cd "$SERVER_DIR" && "$PY" -m pip install "${PIP_INSTALL_ARGS[@]}" -r "$(native_path "$REQS")" )

# Gate the normal release bundle before import checks or installer creation.
if [[ "$TRIPLE" == "x86_64-apple-darwin" ]]; then
  "$PY" "$REPO_ROOT/app/scripts/audit-macos-cryptography.py"
fi

echo "==> Building + installing flowmap-server wheel"
WHEEL_DIR="$CACHE_DIR/wheel"
rm -rf "$WHEEL_DIR"
( cd "$SERVER_DIR" && uv build --wheel -o "$(native_path "$WHEEL_DIR")" )
WHEEL_FILE="$(ls "$WHEEL_DIR"/flowmap_server-*.whl | head -1)"
[[ -n "$WHEEL_FILE" ]] || { echo "ERROR: flowmap-server wheel not built" >&2; exit 1; }
"$PY" -m pip install --no-warn-script-location --disable-pip-version-check --no-deps "$(native_path "$WHEEL_FILE")"

# --- 4. Slim the runtime (optional, safe removals) ----------------------------
echo "==> Slimming runtime (pyc caches, test cruft)"
find "$PYRUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" -type d \( -name "tests" -o -name "test" \) -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true

# Drop Tk/tkinter. FlowMap's server is headless — the UI is the Tauri webview —
# so nothing in the dependency set imports it (see the import check below).
#
# This is not merely a size saving: `_tkinter*.so` links against libtcl9.0 /
# libtk9.0, which python-build-standalone does NOT ship in the install_only
# tarball. On Linux that makes the AppImage bundle fail outright — linuxdeploy
# walks every ELF in the AppDir, cannot resolve libtcl9.0.so, and aborts the
# whole build with "Failed to deploy dependencies for existing files". Removing
# the module removes the dangling dependency at its source, on every platform.
echo "==> Removing unused Tk/tkinter (headless server; breaks AppImage deps)"
find "$PYRUNTIME" -name "_tkinter*.so" -o -name "_tkinter*.pyd" | while IFS= read -r f; do
  [[ -n "$f" ]] && rm -f "$f"
done
find "$PYRUNTIME" -type d \( -name "tkinter" -o -name "idlelib" -o -name "turtledemo" \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" -name "turtle.py" -delete 2>/dev/null || true
# The Tcl/Tk runtime data + shared libraries the removed module was the only
# consumer of (PBS ships these under lib/ and lib/tcl8.6 etc. when present).
find "$PYRUNTIME" -maxdepth 3 -type d \( -name "tcl*" -o -name "tk*" \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" \( -name "libtcl*" -o -name "libtk*" \) -delete 2>/dev/null || true

# Windows installers (MSI/NSIS) cannot carry symlinks. PBS install_only for
# Windows is already symlink-free, but dereference any straggler defensively.
if [[ "$OS_KIND" == "windows" ]]; then
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    real="$(readlink -f "$link" 2>/dev/null || true)"
    if [[ -n "$real" && -f "$real" ]]; then
      rm -f "$link"; cp -f "$real" "$link"
    fi
  done < <(find "$PYRUNTIME" -type l 2>/dev/null || true)
fi

# Inspect the final macOS runtime, including executables and native wheels.
# The DMG builder refreshes this override again immediately before Tauri builds.
if [[ "$OS_KIND" == "macos" ]]; then
  "$PY" "$REPO_ROOT/app/scripts/macos-runtime-minimum.py" \
    --runtime "$PYRUNTIME" --config "$REPO_ROOT/app/src-tauri/tauri.conf.json" \
    --output "$CACHE_DIR/tauri-macos-minimum.json" --report "$CACHE_DIR/macos-runtime-minimum.json"
fi

# --- 5. Verify the bundled runtime boots the server ---------------------------
echo "==> Verifying bundled runtime"
"$PY" -c "import flowmap_server; print('    flowmap_server', flowmap_server.__version__)"
"$PY" -c "import flowmap_server.__main__; print('    flowmap_server.__main__ imports OK')"
# The module list lives in app/scripts/import-gate.py, not here: the release
# workflow's smoke test gates on the same closure, and when the list was written
# out twice the copies drifted the first time a target needed an exception.
# Always (re)write the sidecar, so a skip left over from a previous target in the
# same checkout cannot leak into this one.
printf '%s' "${FLOWMAP_SKIP_IMPORTS:-}" > "$RES_DIR/.import-skip"
"$PY" "$REPO_ROOT/app/scripts/import-gate.py"

SIZE="$(du -sh "$PYRUNTIME" | cut -f1)"
echo "==> Done. Bundled runtime size: $SIZE"
echo "    symlinks in tree: $(find "$PYRUNTIME" -type l 2>/dev/null | wc -l | tr -d ' ')"
