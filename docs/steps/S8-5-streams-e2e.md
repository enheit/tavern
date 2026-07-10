# S8.5 — Streams end-to-end suite (PR-hermetic + @realtime nightly)

- after: S8.3, S8.4, S7.4
- unlocks: S11.1, S12.1, S12.3
- FRs: FR-27, FR-30, FR-31, FR-32, FR-33 acceptance; FR-39 cross-check
- references: PLAN §10 (hermeticity split, fake-media pins), §App-C, §App-D, §8 (G4)

## Goal

Executable acceptance for the whole streams feature: PR suites prove signaling/state/layout/UX
against the SFU mock; the nightly `@realtime` suite proves actual media (frames, layer switches,
preset drops) against the real Cloudflare Realtime SFU.

## Preconditions (run these; red = STOP)

- `pnpm --filter @tavern/app test && pnpm --filter @tavern/worker test` → green (S8.1–S8.4)
- `pnpm --filter @tavern/e2e exec playwright test web/voice.spec.ts` → green (S7.4 harness works)
- `ls e2e/fixtures/tone-440hz-10s.wav e2e/fixtures/motion-160x120.y4m` → both exist (S4.4 frozen names)

## Tasks

1. Test-only seed route (pinned mechanism for the G4 cap toast): worker route
   `POST /api/__test/seed-shares { serverId, count }` registers `count` synthetic active screen
   shares in the DO registry. Route exists ONLY when `TAVERN_SFU_MOCK=1` (the PR/e2e worker env);
   module is excluded from production build by an env guard at router assembly — add a unit test
   asserting a 404 when the flag is absent.
2. `e2e/web/streams.spec.ts` (PR suite, `TAVERN_SFU_MOCK=1`, chromium, fake media flags +
   `e2e/fixtures/motion-160x120.y4m`): two contexts A/B in one server+voice, scenarios below.
3. `e2e/web/streams-realtime.spec.ts` tagged `@realtime` (nightly): same harness, real SFU env.
4. `e2e/desktop/share-smoke.spec.ts`: Electron `_electron.launch` with `TAVERN_E2E=1`.
5. Wire the PR e2e job in `.github/workflows/ci.yml` to run the `web` project with
   `--grep-invert @realtime` (add the arg to the web e2e command). The `@realtime` project runs in
   `nightly.yml` (created in S12.2) — not wired here.

## Pinned interfaces & artifacts

Files created: `e2e/web/streams.spec.ts`, `e2e/web/streams-realtime.spec.ts`,
`e2e/desktop/share-smoke.spec.ts`, `worker/src/routes/testSeed.ts`, `worker/test/testSeed.test.ts`.
Modified: `.github/workflows/ci.yml` (add `--grep-invert @realtime` to the web e2e job),
`worker/src/index.ts` (router-assembly env guard mounting the seed route),
`worker/src/do/ServerRoom.ts` (internal seed-shares op registering synthetic active shares).
Test hooks (window-scoped, exposed only when `platform.isE2E`, defined in S7.4's
`app/src/lib/testHooks.ts` on `window.__tavernTestRtc`):
`__tavernTestRtc.pullStates: Record<string, PullState>` (keys `'voice'` + trackName; `PullState`
= `'idle'|'connecting'|'connected'|'renegotiating'|'closed'|'failed'` from S7.2),
`__tavernTestRtc.layerCalls: Array<{trackName: string, rid: 'h'|'l'}>` (this field extends S7.4's
`__tavernTestRtc` contract; the S8.2/S8.4 `setLayer` path populates it).

### PR scenarios (streams.spec.ts)

| # | Named test | Assertions (state-level — no remote frames in PR, PLAN §10) |
|---|---|---|
| 1 | `FR-30 share appears as placeholder until watched` | A shares (720p30, y4m fake). B sees tile with A's displayName + Watch button; `pullStates` empty on B. |
| 2 | `FR-30 watch creates exactly one pull` | B clicks Watch → `pullStates[trackName]==='connected'`; video element present. |
| 3 | `FR-32 two-tile geometry at 1280×720 → stacked [1,1]` | A shares screen+cam. Viewport 1280×720 ⇒ canvas 720×624 (1280−240−320 × 720−40−56). Tie-break (§App-C, gapless halves — same as S0.2 `computeLayout`): side cell `fittedTileArea(360, 624)` = 360·202.5 = 72,900 px²; stacked cell `fittedTileArea(720, 312)` = 554.7·312 ≈ 173,066 px². Stacked wins ⇒ assert 2 rows of 1 via `getComputedStyle` grid templates. |
| 4 | `FR-32 two-tile geometry at 2600×1000 → side-by-side [2]` | Same shares, viewport 2600×1000 ⇒ canvas 2040×904 (2600−240−320 × 1000−40−56): side cell `fittedTileArea(1020, 904)` = 1020·573.75 = 585,225 px² beats stacked `fittedTileArea(2040, 452)` = 803.6·452 ≈ 363,227 px² ⇒ assert 1 row of 2. |
| 5 | `FR-33 focus requests high layer` | B double-clicks tile → `layerCalls` ends with `{rid:'h'}`; Esc → `{rid:'l'}`. |
| 6 | `FR-31 stream volume persists` | B sets slider 140% → reload → slider 140% (keyed userId:kind). |
| 7 | `FR-30 stop removes tile` | A stops → B tile gone; `pullStates[trackName]` cleared. |
| 8 | `FR-39 activity records stream lifecycle` | Activity tab shows `stream.start` + `stream.stop` entries for A. |
| 9 | `G4 share cap rejects the fifth share` | Seed 4 via `/api/__test/seed-shares` → A starts a share → toast with i18n `error.share_cap` (→ `error_share_cap`, S4.2's `error_<code>` seed); no tile appears. |

### Nightly scenarios (streams-realtime.spec.ts, `@realtime`)

| # | Named test | Assertions (real media) |
|---|---|---|
| 1 | `FR-30/32 real frames flow to watcher` | B watches → `video.videoWidth > 0` and `getStats` framesDecoded strictly increases over 5s. |
| 2 | `FR-27 preset drop reaches viewer` | A switches 720p30→480p30 → B inbound `frameHeight ≤ 480` within 10s. |
| 3 | `FR-33 focus raises resolution` | B focuses → inbound frameHeight rises above the l-layer (>270) within 10s. |

### Desktop smoke (share-smoke.spec.ts)

`FR-28 picker lists capture sources`: open SharePickerDialog → IPC returns an array (assert
`Array.isArray`, length ≥0 — xvfb may expose zero thumbnails; if ≥1, select first and assert
share reaches `sharing` state vs mock). Pinned fallback: when 0 sources under CI, the test
asserts dialog renders + IPC contract only, and logs `xvfb: no sources` (not a failure).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/e2e exec playwright test web/streams.spec.ts` → all PR scenarios pass
- [ ] `pnpm --filter @tavern/e2e exec playwright test desktop/share-smoke.spec.ts` → pass (xvfb ok)
- [ ] `pnpm --filter @tavern/worker test` → green (seed-route 404 guard test included)
- [ ] `pnpm e2e:realtime web/streams-realtime.spec.ts` run ONCE locally with real `.dev.vars`
      (S7.4 mechanism): all 3 pass; paste framesDecoded/frameHeight numbers into `docs/progress.md`
- [ ] PR e2e job command line contains `--grep-invert @realtime` (grep the workflow / job invocation)

## STOP conditions (beyond global R1)

- Scenario 3/4 geometry disagrees with the App-C tie-break arithmetic above → STOP: either the
  shell dimensions changed (someone edited §7.6 constants) or `computeLayout` drifted — a blocker,
  not a test tweak.
- Real-SFU nightly fails on requiresImmediateRenegotiation handling → blocker against S7.2 with
  the SFU response body attached.

## Docs (consult only these)

- https://playwright.dev/docs/api/class-electron
- https://developers.cloudflare.com/realtime/sfu/https-api/
