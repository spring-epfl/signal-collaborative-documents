#!/usr/bin/env bash
set -euo pipefail

# Load env vars if present
[ -f .env ] && . ./.env

docker compose up --build -d

# Run benchmarks for both modes
./netprofile.sh slow
docker exec -it e2ee-cd /bin/bash ./b2.sh
mv benchmark_data/s2-signal.csv benchmark_data/s2-signal-slow.csv
docker exec -it e2ee-cd /bin/bash ./b3.sh
mv benchmark_data/s3-signal.csv benchmark_data/s3-signal-slow.csv
./netprofile.sh fast
docker exec -it e2ee-cd /bin/bash ./b2.sh
mv benchmark_data/s2-signal.csv benchmark_data/s2-signal-fast.csv
docker exec -it e2ee-cd /bin/bash ./b3.sh
mv benchmark_data/s3-signal.csv benchmark_data/s3-signal-fast.csv

docker compose down

# Generate plots
uv run --with jupyter jupyter execute analysis-2-3.ipynb