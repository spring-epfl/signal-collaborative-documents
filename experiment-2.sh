#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . .env

# Build docker image
docker-compose up --build -d

 # Run benchmarks for both modes
./netprofile.sh slow
./b2.sh
mv benchmark_data/s2-signal.csv benchmark_data/s2-signal-slow.csv
./b3.sh
mv benchmark_data/s3-signal.csv benchmark_data/s3-signal-slow.csv
./netprofile.sh fast
./b2.sh
mv benchmark_data/s2-signal.csv benchmark_data/s2-signal-fast.csv
./b3.sh
mv benchmark_data/s3-signal.csv benchmark_data/s3-signal-fast.csv


# Generate plots
uv run --with jupyter jupyter execute analysis-2-3.ipynb

# Tear down docker containers
docker-compose down