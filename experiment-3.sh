#!/bin/sh
set -euo pipefail

# Load env vars if present
[ -f .env ] && . .env

# Build docker image
docker-compose up --build -d

 # Run benchmarks
./b4.sh

# Generate plots
uv run --with jupyter jupyter execute analysis-4.ipynb

# Tear down docker containers
docker-compose down