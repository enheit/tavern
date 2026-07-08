#!/usr/bin/env bash
# S1.4 encoded-frame tap runner. For each target resolution: publish a single-encoding VP8
# stream to the live SFU, run the str0m tap to dump >=300 depacketized encoded frames to IVF,
# then verify with ffprobe -count_frames (the DoD check).
#
# Requires CF_APP_ID / CF_APP_SECRET in env + ffmpeg. Run from spikes/sfu:
#   set -a; . ../../worker/.dev.vars; set +a; ./run_tap.sh
set -euo pipefail
cd "$(dirname "$0")"

DIR=../../docs/spike-results
HANDOFF=target/handoff.json
BIN=target/release
mkdir -p "$DIR"

cargo build --release --bin publish --bin tap

wait_handoff() {
  for _ in $(seq 1 40); do [ -f "$HANDOFF" ] && sleep 0.3 && return 0; sleep 0.5; done
  echo "!! handoff never appeared — publisher failed to connect"; exit 1
}

run_one() { # width height out.ivf
  local W=$1 H=$2 OUT=$3
  echo "=== publish ${W}x${H} single-encoding + str0m tap → $OUT ==="
  rm -f "$HANDOFF"
  "$BIN/publish" --width "$W" --height "$H" --fps 30 --duration 25 --tail 12 \
    --out "$DIR/publish-tap-${W}x${H}.json" &
  local PUB=$!
  wait_handoff
  "$BIN/tap" --width "$W" --height "$H" --fps 30 --frames 300 --timeout 40 --out "$DIR/$OUT"
  wait "$PUB" || true  # publisher's own P1 self-check must not gate the tap run
}

run_one 640 360 dump_360p.ivf
run_one 1920 1080 dump_1080p.ivf

echo "=== DoD: ffprobe -count_frames (codec must match negotiated=vp8, nb_read_frames>=290) ==="
FAIL=0
for f in dump_360p.ivf dump_1080p.ivf; do
  echo "--- $f ---"
  OUT=$(ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=codec_name,nb_read_frames -of default=noprint_wrappers=1 "$DIR/$f")
  echo "$OUT"
  CODEC=$(echo "$OUT" | sed -n 's/^codec_name=//p')
  NF=$(echo "$OUT" | sed -n 's/^nb_read_frames=//p')
  if [ "$CODEC" != "vp8" ] || [ "${NF:-0}" -lt 290 ]; then
    echo "  !! FAIL ($f): codec=$CODEC frames=$NF"; FAIL=1
  else
    echo "  ok ($f): codec=$CODEC frames=$NF"
  fi
done
[ "$FAIL" = 0 ] && echo "=== S1.4 DoD PASS ===" || { echo "=== S1.4 DoD FAIL ==="; exit 1; }
