#!/bin/sh
set -euo pipefail

# Argument parsing
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <slow|fast|off>"
  exit 1
fi

MODE="$1"
if [ "$MODE" != "slow" ] && [ "$MODE" != "fast" ] && [ "$MODE" != "off" ]; then
  echo "Error: MODE must be either 'slow', 'fast' or 'off'"
  exit 1
fi

# Load env vars if present
[ -f .env ] && . .env

# Build docker image
docker-compose up --build -d

 # Run benchmarks for selected mode
./netprofile.sh "$MODE"
./b1.sh
./b2.sh
./b3.sh
./b4.sh

# Rename each file to include the mode tag
for f in benchmark_data/s*-signal.csv; do
  [ -e "$f" ] || continue
  mv "$f" "${f%.csv}-$MODE.csv"
done

# Generate plots
# uv run --with jupyter jupyter execute analysis-1.ipynb
# uv run --with jupyter jupyter execute analysis-2-3.ipynb
# uv run --with jupyter jupyter execute analysis_4.ipynb

# Tear down docker containers
docker-compose down