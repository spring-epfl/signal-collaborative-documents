#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . ./.env

docker-compose up --build -d

# Run benchmarks for both modes
./netprofile.sh slow
docker exec -it e2ee-cd /bin/bash ./b1.sh
mv benchmark_data/s1-signal.csv benchmark_data/s1-signal-slow.csv
./netprofile.sh fast
docker exec -it e2ee-cd /bin/bash ./b1.sh
mv benchmark_data/s1-signal.csv benchmark_data/s1-signal-fast.csv

docker-compose down

# Generate plots
uv run --with jupyter jupyter execute analysis-1.ipynb