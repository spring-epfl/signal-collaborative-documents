# Install Homebrew (if not already installed)
# /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install node and npm
brew install node

# Install signal-cli
brew install signal-cli

# Install uv
brew install uv

# Verify installations
node -v
npm -v
signal-cli --version
uv --version