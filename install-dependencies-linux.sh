#!/usr/bin/env bash
set -e

# Update package index
sudo apt update

# Install node and npm
sudo apt install -y nodejs npm

# Install signal-cli
sudo apt install -y signal-cli

# Install uv
curl -Ls https://astral.sh/uv/install.sh | sh

# Ensure uv is on PATH for current session
export PATH="$HOME/.local/bin:$PATH"

# Verify installations
node -v
npm -v
signal-cli --version
uv --version