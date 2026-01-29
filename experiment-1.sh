#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . .env

# Build docker image
docker-compose up --build -d

 # Run benchmarks for both modes
./netprofile.sh slow
./b1.sh
mv benchmark_data/s1-signal.csv benchmark_data/s1-signal-slow.csv
./netprofile.sh fast
./b1.sh
mv benchmark_data/s1-signal.csv benchmark_data/s1-signal-fast.csv

# Generate plots
uv run --with jupyter jupyter execute analysis-1.ipynb

# Tear down docker containers
docker-compose down