#!/usr/bin/env bash
# S4.3 P6 runner: seeded local worker + two release-build engine processes, 60 s.
# Prereq: `pnpm dev:worker` running (wrangler dev with real SFU creds in worker/.dev.vars).
# Release build is mandatory for clean media (progress S1.3: dev builds starve the pipeline).
set -euo pipefail
cd "$(dirname "$0")"

API="${API:-http://127.0.0.1:8787}"
SECS="${SECS:-60}"
OUT="../../docs/spike-results"

curl -sf "$API/" >/dev/null || { echo "worker not reachable at $API — start pnpm dev:worker"; exit 2; }

cargo build --release
BIN=target/release/tavern-spike-e2e-voice

"$BIN" seed --api "$API"

"$BIN" run --user a --secs "$SECS" --out "$OUT/p6-a.json" &
PA=$!
"$BIN" run --user b --secs "$SECS" --out "$OUT/p6-b.json" &
PB=$!
STATUS=0
wait "$PA" || STATUS=1
wait "$PB" || STATUS=1

"$BIN" check --a "$OUT/p6-a.json" --b "$OUT/p6-b.json" || STATUS=1
exit "$STATUS"
