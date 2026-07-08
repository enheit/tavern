# S5.5 — Webcam manual QA (macOS)

Requires a human + real webcam: the first `webcam_start` triggers the macOS camera TCC
prompt (must be granted interactively), and picture quality/orientation need eyes.
Win/Linux rows deferred per PLAN §1 platform-reality.

## Procedure

1. `pnpm dev:worker` (terminal 1), `pnpm tauri dev` (terminal 2).
2. Register/login two users on two machines (or one machine + a second `run --user b`
   voice participant via `spikes/e2e-voice`); both join the same voice channel.
3. User A: Voice panel → **Webcam** → pick the built-in camera, 720p @ 30 → **Turn on**.
   - Expect: macOS camera permission prompt on first use (grant it), then the
     "📷 Webcam on" indicator.
4. User B: a webcam tile for A appears in the stream grid → **Join Stream**.
   - Expect: live camera picture, correct orientation/colors, motion ≈ smooth 30 fps
     (dev fps counter on the tile's `data-fps` attribute).
5. User A: change to 360p @ 15 (turn off, re-open picker, turn on) → B re-joins.
   - Expect: visibly lower resolution; motion ≈ 15 fps.
6. User A: **Turn off webcam** → A's tile disappears from B's grid.
7. Repeat step 3 with the 480p mode (4:3): picture aspect is 4:3, not stretched.

## Results (macOS)

| Check | Result |
|---|---|
| TCC prompt on first start, granted flow works | PENDING |
| 720p30 live picture on watcher (quality/orientation) | PENDING |
| 360p15 visibly lower res + fps | PENDING |
| 480p 4:3 aspect not stretched | PENDING |
| Turn off removes the tile server-wide | PENDING |

Automated coverage (already green): picker→`webcam_start` mapping for all 6 §0 combos,
stop mapping, indicator states, §1-table encoding params (engine `video.rs` tests),
capture-crate fake webcam lifecycle.
