#!/usr/bin/env bash
# S1.3 P2 evaluator. Reads docs/spike-results/{publish,subscribe}.json and asserts the
# P2 + simulcast gates. Exit 0 iff all pass. Run after run_p2.sh (or standalone).
set -euo pipefail
cd "$(dirname "$0")"
DIR=../../docs/spike-results
P=$DIR/publish.json
S=$DIR/subscribe.json

for f in "$P" "$S"; do [ -f "$f" ] || { echo "missing $f — run ./run_p2.sh first"; exit 1; }; done

fe=$(jq '.framesEncoded' "$P")
fd=$(jq '.framesDecoded' "$S")
zfw=$(jq '.zeroFrameWindows' "$S")
pli=$(jq '.pliCount' "$S")
layers=$(jq '.layersNegotiated' "$S")
low=$(jq '.layerPull.low_kbps' "$S")
high=$(jq '.layerPull.high_kbps' "$S")
turn=$(jq '.turnRequired' "$S")

pass=1
assert() { # $1 = jq boolean expr, $2 = label
  if [ "$(jq -n "$1")" = "true" ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; pass=0; fi
}

echo "P2 gates (publish.json + subscribe.json):"
assert "$fd >= 0.85 * $fe"   "framesDecoded=$fd >= 0.85*framesEncoded=$fe"
assert "$zfw == 0"           "zeroFrameWindows=$zfw == 0 (after 10s warmup)"
assert "$pli <= 6"           "pliCount=$pli <= 6 (no ~3s PLI stutter)"
assert "$layers == 2"        "layersNegotiated=$layers == 2"
assert "$high > 0 and $low > 0 and $high >= 3 * $low" "high_kbps=$high >= 3*low_kbps=$low"
assert "$turn == false"      "turnRequired=$turn == false (STUN-only)"

if [ "$pass" = "1" ]; then echo "P2 PASS"; exit 0; else echo "P2 FAIL"; exit 1; fi
