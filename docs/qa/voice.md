# S4.3 — Voice manual QA (cross-machine)

Automated P6 evidence: `docs/spike-results/p6-a.json` / `p6-b.json` (two real
`tavern-engine` processes, one machine, seeded local worker + real SFU, 60 s
bidirectional — see `spikes/e2e-voice/run_p6.sh`).

Manual QA below verifies what no automated gate can hear. Per PLAN §1
platform-reality: macOS now; Windows/Linux deferred to real hardware.

## Procedure (two machines, or one machine + phone-hotspot second instance)

1. Both: launch Tavern (`pnpm tauri dev` or a bundle), log in as two different
   users, join the same server, click the same voice channel.
2. **Echo on speakers**: user A plays audio on speakers, mic open. B speaks.
   PASS = B does not hear themselves echoed back from A (APM AEC3 active in
   A's engine).
3. **Deafen**: A deafens. PASS = A hears nothing; B stops hearing A (mic
   suppressed). A undeafens with mic previously unmuted → both directions
   resume; if A had muted BEFORE deafening, undeafen keeps A muted (§1 prior
   mic state restore).
4. **Per-user volume**: B drags A's slider 0 → 200%. PASS = perceived loudness
   follows the slider, is remembered across app restarts (pref `gain:{userId}`),
   and only affects B's playout (personal, §0).
5. **Speaking rings**: PASS = the green dot rings the speaking user within
   ~0.5 s and clears when they stop.

## Results

| Check | macOS | Windows | Linux |
|---|---|---|---|
| Echo on speakers (AEC) | PENDING (dev-machine session) | deferred (§1) | deferred (§1) |
| Deafen / undeafen restore | PENDING | deferred | deferred |
| Per-user volume 0–200% + persistence | PENDING | deferred | deferred |
| Speaking rings | PENDING | deferred | deferred |

> Fill PASS/FAIL + date when run. Win/Linux rows move out of "deferred" only
> on real hardware (never faked, per §1).
