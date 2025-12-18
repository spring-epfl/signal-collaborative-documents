# Dockerfile: signal-cli + Node + prebuilt libsignal_jni.so (multi-arch)
# This variant avoids compiling libsignal in the image. Instead, it downloads a
# prebuilt libsignal_jni.so from a URL you provide at build time via
#   --build-arg LIBSIGNAL_JNI_URL=...
# and (recommended) a SHA-256 checksum via
#   --build-arg LIBSIGNAL_JNI_SHA256=...
# Works for both amd64 and arm64 provided you pass the matching binary.

FROM ubuntu:24.04 

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=18
ARG SIGNAL_CLI_VERSION=0.13.14

# Runtime deps: Java, Node, network tools, zip/unzip, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
  iputils-ping curl wget ca-certificates gnupg apt-transport-https \
  openjdk-21-jre-headless \
  qrencode xdg-utils \
  iproute2 \
  git build-essential \
  zip unzip \
  && rm -rf /var/lib/apt/lists/*

# Node.js + yarn + vite
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && npm install -g yarn vite \
  && rm -rf /var/lib/apt/lists/*

# Install signal-cli release
RUN wget -q https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz \
  && tar xf signal-cli-${SIGNAL_CLI_VERSION}.tar.gz -C /opt \
  && ln -sf /opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli /usr/local/bin/signal-cli \
  && rm signal-cli-${SIGNAL_CLI_VERSION}.tar.gz

RUN set -eux; \
  LIBJAR=$(ls /opt/signal-cli-${SIGNAL_CLI_VERSION}/lib/libsignal-client-*.jar | head -n1); \
  LIBSIGNAL_VERSION=$(basename "$LIBJAR" | sed -E 's/libsignal-client-([0-9]+\.[0-9]+\.[0-9]+)\.jar/\1/'); \
  echo "Detected libsignal-client version: ${LIBSIGNAL_VERSION}"; \
  echo "LIBSIGNAL_VERSION=${LIBSIGNAL_VERSION}" > /etc/profile.d/libsignal-version.sh

# Install prebuilt libsignal_jni.so from exquo/signal-libs-build-release and remove bundled jar lib
RUN set -eux; \
  # Load detected version
  . /etc/profile.d/libsignal-version.sh || true; \
  if [ -z "${LIBSIGNAL_VERSION:-}" ]; then \
    echo "Failed to detect LIBSIGNAL_VERSION"; exit 1; \
  fi; \
  # Canonicalize architecture and map to Rust target triple used by releases
  DEB_ARCH=$(dpkg --print-architecture); \
  case "$DEB_ARCH" in \
    amd64)  CANON_ARCH=x86_64;  TARGET_TRIPLE=x86_64-unknown-linux-gnu ;; \
    arm64)  CANON_ARCH=aarch64; TARGET_TRIPLE=aarch64-unknown-linux-gnu ;; \
    armhf)  CANON_ARCH=armv7l;  TARGET_TRIPLE=armv7-unknown-linux-gnueabihf ;; \
    *)      CANON_ARCH="$DEB_ARCH"; TARGET_TRIPLE="${DEB_ARCH}-unknown-linux-gnu" ;; \
  esac; \
  TAG="libsignal_v${LIBSIGNAL_VERSION}"; \
  TARBALL="libsignal_jni.so-v${LIBSIGNAL_VERSION}-${TARGET_TRIPLE}.tar.gz"; \
  URL="https://github.com/exquo/signal-libs-build/releases/download/${TAG}/${TARBALL}"; \
  echo "Downloading: $URL"; \
  mkdir -p /tmp/libsignal && cd /tmp/libsignal; \
  curl -fL "$URL" -o libsignal_jni.tar.gz; \
  tar xzf libsignal_jni.tar.gz; \
  if [ ! -f libsignal_jni.so ]; then \
    # Sometimes the tarball contains the file under a subdir; try to locate it
    SO_PATH=$(find . -name libsignal_jni.so -type f | head -n1); \
    if [ -z "$SO_PATH" ]; then echo "libsignal_jni.so not found in tarball"; exit 1; fi; \
  else \
    SO_PATH=libsignal_jni.so; \
  fi; \
  LIBDIR="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/jni"; \
  mkdir -p "$LIBDIR"; \
  install -m 0644 "$SO_PATH" "$LIBDIR/libsignal_jni.so"; \
  rm -rf /tmp/libsignal; \
  # Ensure the jar does not shadow our .so
  zip -d /opt/signal-cli-${SIGNAL_CLI_VERSION}/lib/libsignal-client-*.jar libsignal_jni.so || true; \
  echo "$LIBDIR" > /etc/ld.so.conf.d/signal-jni.conf && ldconfig

# Prepare mounting points
RUN mkdir -p /e2ee-cd
WORKDIR /e2ee-cd
RUN mkdir -p signal-data crdt-benchmarks benchmark_data benchmark_plots

VOLUME ["/e2ee-cd/signal-data", "/e2ee-cd/crdt-benchmarks", "/e2ee-cd/benchmark_data", "/e2ee-cd/benchmark_plots"]

# Non-root user
#RUN useradd -ms /bin/bash appuser && chown -R appuser:appuser /e2ee-cd
#USER appuser

CMD ["sleep", "infinity"]