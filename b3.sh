#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . .env

# Configurable startup delay (seconds). 
SLEEP_SECS="${SIGNAL_CLI_STARTUP_DELAY_SECS:-5}"
SIGNAL_CONFIG="./signal-data/signal-multiaccount"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { log "ERROR: '$1' not found in PATH"; exit 1; }; }

# Ensure signal-cli is stopped when the script exits (success or failure)
cleanup() {
  if [ "${SIGNAL_PID:-}" != "" ] && kill -0 "$SIGNAL_PID" 2>/dev/null; then
    log "Stopping signal-cli (pid=$SIGNAL_PID)..."
    kill "$SIGNAL_PID" || true
    wait "$SIGNAL_PID" 2>/dev/null || true
    log "signal-cli stopped."
  fi
}
trap cleanup EXIT INT TERM

log "Starting Automerge b3 benchmark run"
log "Using startup delay: ${SLEEP_SECS}s"

require_cmd signal-cli
require_cmd npm

log "Installing dependencies in crdt-benchmarks (this may take a moment)..."
(
  cd crdt-benchmarks
  npm install
)

log "Launching signal-cli daemon with config: $SIGNAL_CONFIG"
signal-cli --config="$SIGNAL_CONFIG" --verbose daemon --http > signal-cli.3.log 2>&1 &
SIGNAL_PID=$!
log "signal-cli started in background (pid=$SIGNAL_PID). Waiting ${SLEEP_SECS}s for readiness..."
sleep "$SLEEP_SECS"

# Run benchmarks
log "Running Automerge b3-signal benchmark..."
(
  cd crdt-benchmarks/benchmarks/automerge
  npm start -- b3-signal
)

cleanup

log "Benchmark completed successfully."