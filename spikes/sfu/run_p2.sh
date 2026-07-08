#!/usr/bin/env bash
# S1.3 P2 runner. Two phases against the live SFU:
#   1. P2 basic:  single-encoding publish + subscribe, 60 s concurrent.
#   2. simulcast: 2-layer publish + two per-rid pulls (l, then h), 30 s each.
# Then merges layer metrics into subscribe.json and runs check_p2.sh.
#
# Requires CF_APP_ID / CF_APP_SECRET in env. Run from spikes/sfu:
#   set -a; . ../../worker/.dev.vars; set +a; ./run_p2.sh
set -euo pipefail
cd "$(dirname "$0")"

DIR=../../docs/spike-results
HANDOFF=target/handoff.json
BIN=target/release # release: two libwebrtc instances + per-frame fill need optimized code
mkdir -p "$DIR"

cargo build --release --bins

# Poll for the publisher-written handoff (do NOT rm here — caller clears it pre-publish).
wait_handoff() {
  for _ in $(seq 1 40); do [ -f "$HANDOFF" ] && sleep 0.3 && return 0; sleep 0.5; done
  echo "!! handoff never appeared — publisher failed to connect"; exit 1
}

echo "=== Phase 1: P2 basic (640x360@30 single-encoding, 60 s concurrent) ==="
rm -f "$HANDOFF"
"$BIN/publish" --width 640 --height 360 --fps 30 --duration 60 --tail 15 --out "$DIR/publish.json" &
PUB=$!
wait_handoff
"$BIN/subscribe" --duration 60 --out "$DIR/subscribe.json"
wait "$PUB" || true  # publisher's own P1 self-check exit code must not gate the P2 run

echo "=== Phase 2: simulcast (1280x720@30, rid h/l; pull l then h, 30 s each) ==="
rm -f "$HANDOFF"
"$BIN/publish" --width 1280 --height 720 --fps 30 --simulcast --duration 75 --tail 5 --out "$DIR/publish-simulcast.json" &
PUB=$!
wait_handoff
"$BIN/subscribe" --rid l --duration 30 --out "$DIR/sub-l.json"
"$BIN/subscribe" --rid h --duration 30 --out "$DIR/sub-h.json"
wait "$PUB" || true

echo "=== Merge layer metrics + layersNegotiated into subscribe.json ==="
LOW=$(jq '.kbps' "$DIR/sub-l.json")
HIGH=$(jq '.kbps' "$DIR/sub-h.json")
LAYERS=$(jq '.layersNegotiated' "$DIR/publish-simulcast.json")
# turnRequired = did ANY of the three subscriptions need TURN (i.e. failed STUN-only)?
TURN=$(jq -s 'any(.[]; .turnRequired)' "$DIR/subscribe.json" "$DIR/sub-l.json" "$DIR/sub-h.json")
jq --argjson low "$LOW" --argjson high "$HIGH" --argjson layers "$LAYERS" --argjson turn "$TURN" \
   '. + {layersNegotiated: $layers, turnRequired: $turn, layerPull: {low_kbps: $low, high_kbps: $high}}' \
   "$DIR/subscribe.json" > "$DIR/subscribe.json.tmp" && mv "$DIR/subscribe.json.tmp" "$DIR/subscribe.json"

echo "=== P2 evaluation ==="
exec ./check_p2.sh
