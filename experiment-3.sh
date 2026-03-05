#!/usr/bin/env bash
set -euo pipefail

# Load env vars if present
[ -f .env ] && . ./.env

docker compose up --build -d

# Run benchmarks
docker exec -it e2ee-cd /bin/bash  ./b4.sh

docker compose down

# Generate plots
uv run --with jupyter jupyter execute analysis-4.ipynb