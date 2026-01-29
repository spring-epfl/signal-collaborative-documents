#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . .env

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { log "ERROR: '$1' not found in PATH"; exit 1; }; }

log "Starting Automerge b4 benchmark run"

require_cmd npm

log "Installing dependencies in crdt-benchmarks (this may take a moment)..."
(
  cd crdt-benchmarks
  npm install
)

# Run benchmarks
log "Running Automerge b4-signal benchmark..."
(
  cd crdt-benchmarks/benchmarks/automerge
  npm start -- b4-large-edits
)

log "Benchmark completed successfully."