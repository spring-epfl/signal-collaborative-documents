#!/usr/bin/env bash
set -euo pipefail

# ---- Tunables ----

# ---- Target one-way latency (ms) ----
# We will measure baseline *RTT* inside the container, approximate one-way as RTT/2,
# and adjust netem delay so one-way latency ≈ target.
FAST_TARGET_LATENCY_MS=${FAST_TARGET_LATENCY_MS:-5}
SLOW_TARGET_LATENCY_MS=${SLOW_TARGET_LATENCY_MS:-30}
PING_HOST=${PING_HOST:-1.1.1.1}
PING_COUNT=${PING_COUNT:-5}
# --------------------------------

# ---- Target throughput (Mbps) ----
# We will measure baseline download throughput from inside the container and set TBF rates to match targets.
FAST_TARGET_RATE_MBPS=${FAST_TARGET_RATE_MBPS:-60}
SLOW_TARGET_RATE_MBPS=${SLOW_TARGET_RATE_MBPS:-5}
THROUGHPUT_URL=${THROUGHPUT_URL:-http://speedtest.tele2.net/10MB.zip}
THROUGHPUT_RUNS=${THROUGHPUT_RUNS:-2}
# ----------------------------------

# Fast profile params
FAST_LATENCY=${FAST_LATENCY:-}
FAST_RATE=${FAST_RATE:-}
FAST_DELAY_MS=${FAST_DELAY_MS:-10ms}
FAST_LOSS=${FAST_LOSS:-0%}
FAST_BURST=${FAST_BURST:-64kb}


# Slow profile params
SLOW_LATENCY=${SLOW_LATENCY:-}
SLOW_RATE=${SLOW_RATE:-}
SLOW_DELAY_MS=${SLOW_DELAY_MS:-30ms}
SLOW_LOSS=${SLOW_LOSS:-0%}
SLOW_BURST=${SLOW_BURST:-32kb}

# Minimum TBF latency to avoid invalid values when target==measured
TBF_LATENCY_MIN_MS=${TBF_LATENCY_MIN_MS:-1}
# ------------------


CTR="e2ee-cd"
PROFILE="${1:-slow}"  # slow | fast | off

PID=$(docker inspect -f '{{.State.Pid}}' "$CTR")
# Read container eth0's iflink (host-side peer ifindex)
IDX=$(docker exec --user 0 "$CTR" cat /sys/class/net/eth0/iflink 2>/dev/null || true)

# Try to resolve the host peer interface name. This is best-effort:
# - On Linux, use `ip -o link`
# - On macOS (Docker Desktop), veth is inside the Linux VM, so we usually won't find it; try ifconfig index as a fallback.
VETH=""
if command -v ip >/dev/null 2>&1; then
  # iproute2 present (Linux). Some iproute2mac builds don't support -o; guard with help check.
  if ip -help 2>&1 | grep -q '\-o'; then
    VETH=$(ip -o link 2>/dev/null | awk -v idx="$IDX" '$1==idx":" {print $2}' | tr -d :)
  fi
fi

if [ -z "$VETH" ] && command -v ifconfig >/dev/null 2>&1; then
  # macOS fallback: scan interfaces and match "index N"
  VETH=$(ifconfig -l 2>/dev/null | tr ' ' '\n' | while read ifc; do
    [ -z "$ifc" ] && continue
    ix=$(ifconfig "$ifc" 2>/dev/null | grep -o 'index [0-9]\+' | awk '{print $2}')
    if [ "$ix" = "$IDX" ]; then echo "$ifc"; break; fi
  done)
fi

if [ "$PROFILE" = "off" ]; then
  echo "Debug: Clearing qdisc inside container"
  docker exec --user 0 "$CTR" bash -lc 'tc qdisc del dev eth0 root || true'
  if [ -n "$VETH" ]; then
    sudo tc qdisc del dev "$VETH" root || true
  else
    echo "Nothing to clear on host: no host veth found."
  fi
  echo "Applied 'off' profile to container '$CTR'."
  exit 0
fi

# --- Preflight: ensure we can run tc inside the container ---
preflight_tc() {
  # Run as root to avoid non-root failures
  local out rc
  out=$(docker exec --user 0 "$CTR" sh -lc 'tc qdisc show dev eth0' 2>&1) || rc=$?
  rc=${rc:-0}
  if [ $rc -ne 0 ]; then
    if echo "$out" | grep -qi 'Operation not permitted'; then
      echo "ERROR: tc needs CAP_NET_ADMIN inside the container."
      echo "User docker-compose, or recreate your container with: docker run --cap-add NET_ADMIN --name $CTR <image> ..."
      exit 1
    elif echo "$out" | grep -qi 'not found'; then
      echo "ERROR: 'tc' not found in container. Install iproute2 with `apt-get install iproute2`."
      exit 1
    else
      echo "ERROR: Failed to query tc in container: $out"
      exit 1
    fi
  fi
}
preflight_curl() {
  local out rc
  out=$(docker exec --user 0 "$CTR" sh -lc 'command -v curl >/dev/null || echo missing' 2>/dev/null) || rc=$?
  rc=${rc:-0}
  if [ "$out" = "missing" ]; then
    echo "ERROR: 'curl' not found in container. Install it (apt-get install -y curl | apk add curl | yum install curl)."
    exit 1
  fi
}
preflight_tc
preflight_curl

# Measure baseline RTT from inside the container (ms, float), then compute extra delay to reach target one-way latency
echo "Measuring RTT inside container (ping host=${PING_HOST}, count=${PING_COUNT})..."
MEASURED_RTT_MS=""
PING_CMD="ping -n -q -c ${PING_COUNT} ${PING_HOST}"
# Extract avg RTT in ms from either iputils or busybox ping summary line
MEASURED_RTT_MS=$(docker exec --user 0 "$CTR" sh -lc "${PING_CMD} | grep -Eo '[0-9]+(\\.[0-9]+)?/[0-9]+(\\.[0-9]+)?/[0-9]+(\\.[0-9]+)?(/[0-9]+(\\.[0-9]+)?)?' | head -n1 | cut -d'/' -f2" 2>/dev/null || true)

calc_delay_ms() {
  # $1 = target one-way latency (ms, number), $2 = measured RTT (ms, may be float)
  # Approximate baseline one-way as RTT/2, so required extra delay d = max(0, target - RTT/2)
  awk -v t="$1" -v m="$2" 'BEGIN { if (t=="" || m=="" ) { print ""; exit } d=t-(m/2.0); if (d<0) d=0; printf("%.0f", d) }'
}
strip_ms() { echo "$1" | sed -E 's/[[:space:]]*ms$//'; }
clamp_ge() { awk -v x="$1" -v min="$2" 'BEGIN { if (x<min) x=min; printf("%d", x)}'; }
FAST_TARGET_NUM=$(strip_ms "${FAST_TARGET_LATENCY_MS}")
SLOW_TARGET_NUM=$(strip_ms "${SLOW_TARGET_LATENCY_MS}")

if [ -n "${MEASURED_RTT_MS}" ]; then
  echo "Baseline RTT measured = ${MEASURED_RTT_MS} ms"
  BASE_ONEWAY_MS=$(awk -v m="${MEASURED_RTT_MS}" 'BEGIN { printf("%.2f", m/2.0) }')
  echo "Approx. baseline one-way latency ≈ ${BASE_ONEWAY_MS} ms"
  if [ -n "${FAST_TARGET_NUM}" ]; then
    d=$(calc_delay_ms "${FAST_TARGET_NUM}" "${MEASURED_RTT_MS}")
    if [ -n "$d" ]; then
      FAST_DELAY_MS="${d}ms"
      dlat=$(clamp_ge "$d" "${TBF_LATENCY_MIN_MS}")
      FAST_LATENCY="${TBF_LATENCY_MIN_MS}ms"
    fi
    echo "Adjusted FAST: baseline RTT=${MEASURED_RTT_MS}ms (≈ one-way ${BASE_ONEWAY_MS}ms) target one-way=${FAST_TARGET_NUM}ms -> netem delay=${FAST_DELAY_MS:-<unchanged>}, tbf latency=${FAST_LATENCY:-<unchanged>}"
  fi
  if [ -n "${SLOW_TARGET_NUM}" ]; then
    d=$(calc_delay_ms "${SLOW_TARGET_NUM}" "${MEASURED_RTT_MS}")
    if [ -n "$d" ]; then
      SLOW_DELAY_MS="${d}ms"
      dlat=$(clamp_ge "$d" "${TBF_LATENCY_MIN_MS}")
      SLOW_LATENCY="${TBF_LATENCY_MIN_MS}ms"
    fi
    echo "Adjusted SLOW: baseline RTT=${MEASURED_RTT_MS}ms (≈ one-way ${BASE_ONEWAY_MS}ms) target one-way=${SLOW_TARGET_NUM}ms -> netem delay=${SLOW_DELAY_MS:-<unchanged>}, tbf latency=${SLOW_LATENCY:-<unchanged>}"
  fi
else
  echo "Warning: Could not measure baseline RTT with '${PING_CMD}'."
  echo "Debug: Using configured delays FAST_DELAY_MS=${FAST_DELAY_MS}, SLOW_DELAY_MS=${SLOW_DELAY_MS}"
fi

# --- Warnings based on measured RTT vs targets ---
if [ -n "${MEASURED_RTT_MS}" ]; then
  awk -v m="${MEASURED_RTT_MS}" -v f="${FAST_TARGET_LATENCY_MS}" 'BEGIN { if (m/2.0>f) printf("Warning: measured one-way latency %.2f ms exceeds FAST target %d ms\n", m/2.0, f); }'
  awk -v m="${MEASURED_RTT_MS}" -v s="${SLOW_TARGET_LATENCY_MS}" 'BEGIN { if (m/2.0>s) printf("Warning: measured one-way latency %.2f ms exceeds SLOW target %d ms\n", m/2.0, s); }'
fi

# --- Measure baseline throughput and set rates toward targets ---
echo ""
echo "Measuring throughput inside container (${THROUGHPUT_RUNS} run(s)) from ${THROUGHPUT_URL} ..."
MEASURED_MBPS=""
if [ "$THROUGHPUT_RUNS" -gt 0 ]; then
  MEASURED_BPS_LIST=$(docker exec --user 0 "$CTR" sh -lc '
    ok=0; for i in $(seq 1 '"$THROUGHPUT_RUNS"'); do
      sp=$(curl -s -o /dev/null -w "%{speed_download}\n" '"$THROUGHPUT_URL"' || true)
      if [ -n "$sp" ]; then echo "$sp"; ok=1; fi
    done; exit $((1-ok))
  ' 2>/dev/null || true)
  if [ -n "$MEASURED_BPS_LIST" ]; then
    # Convert average bytes/sec to Mbps (SI)
    MEASURED_MBPS=$(echo "$MEASURED_BPS_LIST" | awk '{s+=$1; n++} END{ if(n>0){ printf("%.2f", (s/n)*8/1000000 ); }}')
  fi
fi
echo "Debug: Baseline throughput avg = ${MEASURED_MBPS:-<unknown>} Mbps (runs=${THROUGHPUT_RUNS})"

calc_rate_mbit() {
  # $1 target Mbps (number), $2 measured Mbps (float). Returns integer mbit string like "50mbit".
  awk -v t="$1" -v m="$2" 'BEGIN {
    if (t=="") { print ""; exit }
    if (m=="" || m<=0) { d=t; } else { d=(m<t? m : t); }
    if (d<1) d=1; printf("%dmbit", int(d));
  }'
}

if [ -n "${MEASURED_MBPS}" ]; then
  fr=$(calc_rate_mbit "${FAST_TARGET_RATE_MBPS}" "${MEASURED_MBPS}")
  sr=$(calc_rate_mbit "${SLOW_TARGET_RATE_MBPS}" "${MEASURED_MBPS}")
  if [ -n "$fr" ]; then FAST_RATE="$fr"; fi
  if [ -n "$sr" ]; then SLOW_RATE="$sr"; fi
  echo "Adjusted FAST: measured=${MEASURED_MBPS} Mbps, target=${FAST_TARGET_RATE_MBPS} Mbps -> FAST_RATE=${FAST_RATE}"
  echo "Adjusted SLOW: measured=${MEASURED_MBPS} Mbps, target=${SLOW_TARGET_RATE_MBPS} Mbps -> SLOW_RATE=${SLOW_RATE}"
else
  # Keep configured FAST_RATE/SLOW_RATE; just warn
  echo "Warning: Could not measure throughput from ${THROUGHPUT_URL}; using configured FAST_RATE=${FAST_RATE}, SLOW_RATE=${SLOW_RATE}"
fi

# --- Warnings based on measured throughput vs targets ---
if [ -n "${MEASURED_MBPS}" ]; then
  awk -v m="${MEASURED_MBPS}" -v f="${FAST_TARGET_RATE_MBPS}" 'BEGIN { if (m<f) printf("Warning: measured throughput %.2f Mbps is below FAST target %.2f Mbps\n", m, f); }'
  awk -v m="${MEASURED_MBPS}" -v s="${SLOW_TARGET_RATE_MBPS}" 'BEGIN { if (m<s) printf("Warning: measured throughput %.2f Mbps is below SLOW target %.2f Mbps\n", m, s); }'
fi
# --- end throughput measurement ---

# Fallback: if latency remained empty, tie it to the chosen delay so tc tbf has a value
[ -z "${FAST_LATENCY}" ] && FAST_LATENCY="${TBF_LATENCY_MIN_MS}ms"
[ -z "${SLOW_LATENCY}" ] && SLOW_LATENCY="${TBF_LATENCY_MIN_MS}ms"

egress_fast="
  tc qdisc replace dev eth0 root handle 1: netem delay ${FAST_DELAY_MS} loss ${FAST_LOSS}
  tc qdisc replace dev eth0 parent 1: handle 10: tbf rate ${FAST_RATE} burst ${FAST_BURST} latency ${FAST_LATENCY}
"
egress_slow="
  tc qdisc replace dev eth0 root handle 1: netem delay ${SLOW_DELAY_MS} loss ${SLOW_LOSS}
  tc qdisc replace dev eth0 parent 1: handle 10: tbf rate ${SLOW_RATE} burst ${SLOW_BURST} latency ${SLOW_LATENCY}
"

host_fast=""
if [ -n "$VETH" ]; then
read -r -d '' host_fast <<EOF
  sudo tc qdisc replace dev $VETH root handle 1: netem delay ${FAST_DELAY_MS}
  sudo tc qdisc replace dev $VETH parent 1: handle 10: tbf rate ${FAST_RATE} burst ${FAST_BURST} latency ${FAST_LATENCY}
EOF
fi
host_slow=""
if [ -n "$VETH" ]; then
read -r -d '' host_slow <<EOF
  sudo tc qdisc replace dev $VETH root handle 1: netem delay ${SLOW_DELAY_MS} loss ${SLOW_LOSS}
  sudo tc qdisc replace dev $VETH parent 1: handle 10: tbf rate ${SLOW_RATE} burst ${SLOW_BURST} latency ${SLOW_LATENCY}
EOF
fi

echo ""
case "$PROFILE" in
  fast)
    echo "Debug: Applying FAST profile commands inside container:"
    echo "$egress_fast"
    docker exec --user 0 "$CTR" bash -lc "$egress_fast"
    if [ -n "$VETH" ]; then
      eval "$host_fast"
    else
      echo "Host-side shaping not available: no host veth found (macOS/Docker Desktop likely). Applying container-only shaping."
    fi
    ;;
  slow)
    echo "Debug: Applying SLOW profile commands inside container:"
    echo "$egress_slow"
    docker exec --user 0 "$CTR" bash -lc "$egress_slow"
    if [ -n "$VETH" ]; then
      eval "$host_slow"
    else
      echo "Host-side shaping not available: no host veth found (macOS/Docker Desktop likely). Applying container-only shaping."
    fi
    ;;
  *)
    echo "Usage: $0 [slow|fast|off]" >&2
    exit 1
    ;;
esac

if [ -n "$VETH" ]; then
  echo "Applied '$PROFILE' profile to container '$CTR' (host veth: $VETH)."
else
  echo "Applied '$PROFILE' profile to container '$CTR' (container-only shaping; host veth not available)."
fi