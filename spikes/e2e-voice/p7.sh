#!/bin/bash
# P7 (PLAN §1, S6.1): reconnect proof. Publishes a 720p30 screen via the REAL engine to the
# real SFU (through the local worker), then WiFi off → sleep 10 → on. Gates (evaluated by
# the harness from its 1 Hz samples + the marks written here): framesEncoded/bytesSent
# resume ≤15 s after the ON timestamp; the gap is visible in the sample log.
#
# Prereqs: `wrangler dev` running on :8787 (real SFU creds in worker/.dev.vars) and
#          `cargo run --release -- seed` done in this directory.
# WARNING: kills this machine's WiFi for ~10 s.
set -euo pipefail
DEV="${1:-en0}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MARKS="$DIR/target/p7-marks.json"
OUT="$DIR/../../docs/spike-results/p7.json"
rm -f "$MARKS"

cargo run --release --manifest-path "$DIR/Cargo.toml" -- run --user a --share 720x30 --secs 60 \
  --p7-marks "$MARKS" --out "$OUT" &
PID=$!

sleep 25 # steady-state window before the cut
OFF_MS=$(($(date +%s) * 1000))
networksetup -setairportpower "$DEV" off
echo "[p7] wifi OFF at $OFF_MS"
sleep 10
networksetup -setairportpower "$DEV" on
ON_MS=$(($(date +%s) * 1000))
echo "[p7] wifi ON at $ON_MS"
printf '{"offMs": %s, "onMs": %s}\n' "$OFF_MS" "$ON_MS" > "$MARKS"

wait $PID
