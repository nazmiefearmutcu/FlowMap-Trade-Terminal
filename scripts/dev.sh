#!/usr/bin/env bash
# Boot the FlowMap gateway (:8720) + the client dev server (:5173) together.
# Ctrl-C stops both, including every process they spawned. Requires: uv
# (Python 3.13), npm (Node 22).
# Recording is DISABLED here by default (the server's own default is on; see
# config.py). Opt in per boot with FLOWMAP_RECORDING_ENABLED=1 ./scripts/dev.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FLOWMAP_PORT:-8720}"
if [ "${FLOWMAP_RECORDING_ENABLED:-0}" = "1" ]; then REC=1; else REC=0; fi

# Job control gives every background job its own process group whose id is the
# job's PID. Cleanup signals that group, so `uv`, the python server it starts,
# `npm` and `vite` all stop together. Killing only the wrapper PID used to leave
# the server running on :8720, and the next boot then reported that stale server
# as healthy.
set -m

# Refuse to start over a server this script does not own: the health probe below
# would otherwise succeed against a process from an earlier run.
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "port $PORT already answers /api/health; stop that server first (this script did not start it)." >&2
  exit 1
fi

echo "FlowMap — booting server (:$PORT, recording=$REC) + client (:5173)"

SERVER_PID=""
CLIENT_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo; echo "stopping…"
  for pid in "$CLIENT_PID" "$SERVER_PID"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- server ---
( cd "$ROOT/server" && uv sync -q && FLOWMAP_PORT="$PORT" FLOWMAP_RECORDING_ENABLED="$REC" uv run python -m flowmap_server ) &
SERVER_PID=$!

# wait for the server to answer /api/health (up to ~30s); a crash stops the wait
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "server did not become healthy on http://127.0.0.1:$PORT/api/health" >&2
  exit 1
fi
echo "server up on :$PORT"

# --- client (vite proxies /api + /ws to the server) ---
( cd "$ROOT/client" && { [[ -d node_modules ]] || npm install; } && npm run dev ) &
CLIENT_PID=$!

echo "open http://localhost:5173"

# Stay in the foreground until either child exits; the trap then stops the other.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$CLIENT_PID" 2>/dev/null; do
  sleep 1
done
echo "a dev process exited; stopping the other one."
