# S7.4 — Voice e2e (two-client, fake media; PR-hermetic + @realtime nightly)

- after: S7.3 · unlocks: — (required for S12.4) · FRs: FR-18, FR-19, FR-20, FR-23, FR-24, FR-26 (end-to-end ACs)
- references: PLAN §10 (hermeticity split, Electron e2e pinned patterns), App-B, §7.6, S4.4 harness

## Goal

Prove voice works between two real clients: PR suite (SFU mock — signaling/state/local-media
assertions) and an `@realtime`-tagged nightly spec (real Cloudflare Realtime — remote-media
`getStats` assertions, FR-19's AC).

## Preconditions (run these; red = STOP)

- `grep -q "^## S7.3" docs/progress.md` → exit 0 (S4.4 harness is an ancestor of S7.3).
- `grep -q "TAVERN_TEST_FAST_ALARM" worker/src/do/roomState.ts` → exit 0 (S3.4's fast-alarm
  artifact must be present — this step only consumes it, never adds it).
- `pnpm -F @tavern/e2e exec playwright test --project=web web/smoke.spec.ts` → exit 0.

## Tasks

1. **Test-mode plumbing** (this step owns it):
   - `app/src/lib/testHooks.ts`: installs `window.__tavernTestAudio` / `__tavernTestRtc`
     (contract below) iff `platform.isE2E`. `isE2E` plumbing: add `isE2E: boolean` to the
     `window.tavern` IPC surface in `shared/src/ipc.ts`; `desktop/src/preload/index.ts` sets it to
     `process.env.TAVERN_E2E === '1'`; `app/src/platform/types.ts` exposes `isE2E` on the bridge —
     desktop reads `window.tavern.isE2E`, web reads `new URLSearchParams(location.search).has('e2e')`.
     Wire installation in `voiceController.ts` init.
   - Fast alarm for e2e is **provided by S3.4** — `worker/src/do/roomState.ts` already reads
     `env.TAVERN_TEST_FAST_ALARM === '1'` → 5_000 ms empty-voice close (verified by the precondition
     grep). This step does NOT touch roomState.ts; it only sets the env var in the e2e worker env
     (below).
   - `worker/wrangler.jsonc`: add an `env.e2e` block that RE-DECLARES the non-inheritable bindings
     verbatim from the top level — named environments do NOT inherit bindings, so copy the
     `d1_databases`, `r2_buckets`, `durable_objects`, and `assets` entries into `env.e2e` exactly as
     at top level. Create `worker/.dev.vars.e2e` with EXACTLY these keys:
     `BETTER_AUTH_SECRET=<same value as worker/.dev.vars>`, `TAVERN_SFU_MOCK=1`,
     `TAVERN_TEST_FAST_ALARM=1` (no other vars; "non-secret dev vars" is not a judgment call —
     this is the full list).
   - `e2e/playwright.config.ts`: the e2e worker `webServer` entry command becomes
     `pnpm -F @tavern/worker exec wrangler dev --env e2e --port 8787` (wrangler picks
     `.dev.vars.e2e` for `--env e2e`). See Task 4 for the config-level `webServer` array shape.
2. `e2e/web/voice.spec.ts` (PR suite; two browser contexts A/B + third context C observer; fake
   media flags + tone WAV from the S4.4 harness; every page opened with `?e2e=1`).
3. `e2e/desktop/voice-smoke.spec.ts`: one Electron instance (S4.4 `launchDesktop` with
   `TAVERN_E2E=1`), join voice with fake mic → publish state `connected` (rtc hook), speaking
   ring on self within 2 s.
4. `e2e/web/voice-realtime.spec.ts` (Playwright project `web-realtime`, same testDir) tagged
   `@realtime`: same two-context flow against the REAL SFU —
   `test.skip(!process.env.REALTIME_APP_ID, 'realtime secrets absent')`. Playwright has **no
   per-project `webServer`**, so `webServer` is a single config-level array: the app dev server,
   the e2e worker (Task 1, port 8787), and — appended only when `process.env.REALTIME_APP_ID` is
   set, via a conditional spread — the realtime worker
   `pnpm -F @tavern/worker exec wrangler dev --port 8788` (real `.dev.vars`, WITHOUT
   `TAVERN_SFU_MOCK`). Pinned mechanism:
   `webServer: [ appServer, e2eWorker, ...(process.env.REALTIME_APP_ID ? [realtimeWorker8788] : []) ]`.
   The `web-realtime` project's `baseURL` targets the app server; its worker fetches hit 8788.
5. Wire root `package.json` scripts (exact strings, pinned):
   - `"e2e": "pnpm -F @tavern/e2e exec playwright test --project=web --project=desktop"`
   - `"e2e:realtime": "pnpm -F @tavern/e2e exec playwright test --project=web-realtime"`

## Pinned interfaces & artifacts

Files created: `app/src/lib/testHooks.ts`, `e2e/web/voice.spec.ts`,
`e2e/web/voice-realtime.spec.ts`, `e2e/desktop/voice-smoke.spec.ts`, `worker/.dev.vars.e2e`.
Modified: `shared/src/ipc.ts` (add `isE2E: boolean` to the window.tavern surface),
`desktop/src/preload/index.ts` (set `isE2E` from `process.env.TAVERN_E2E`),
`app/src/platform/types.ts` (+electron.ts/web.ts), `app/src/features/voice/voiceController.ts`,
`worker/wrangler.jsonc`, `e2e/playwright.config.ts`, root `package.json` scripts.
(NOT `worker/src/do/roomState.ts` — the fast alarm is S3.4's, consumed only.)

Test-hook contract (only when `platform.isE2E`; typed in `testHooks.ts`, consumed via
`page.evaluate`):

```ts
declare global {
  interface Window {
    __tavernTestAudio?: {
      deafened: boolean;
      userGains: Record<string, number>;          // userId → gain 0..2
      speakingUserIds: string[];
      soundboardPlays: Array<{ soundId: string; at: number }>;  // consumed by S9.2 (FR-36 sync AC)
    };
    __tavernTestRtc?: {
      publishState: PublishState;
      pullStates: Record<string, PullState>;       // 'voice' + trackName keys
      stats(session: 'voice'): Promise<{ bytesReceived: number; audioLevel: number | null }>; // inbound-rtp audio summary
    };
  }
}
```

## Tests

`e2e/web/voice.spec.ts` — `test.describe('FR-18 FR-19 voice (mock SFU)')`:
- 'A and B join → both see 2 voice members; observer C sees both chips and the timer (FR-24)'.
- 'publish session reaches connected on both (rtc hook)'.
- 'speaking ring appears on A within 2s of joining (tone WAV → local analyser, FR-23)'.
- 'A mutes → B sees mute badge ≤1s (FR-26)'.
- 'B deafens → hook __tavernTestAudio.deafened === true and B auto-muted (FR-26)'.
- 'A sets B volume to 150 → userGains[B]===1.5; persists across reload (localStorage, FR-20)'.
- 'both leave → within 5s (fast alarm) activity shows session closed and timer disappears (FR-24)'.
`e2e/desktop/voice-smoke.spec.ts` — `test.describe('FR-18 desktop voice smoke')`: as Task 3.
`e2e/web/voice-realtime.spec.ts` — `test.describe('FR-19 voice @realtime')`:
- 'B receives A: inbound-rtp bytesReceived strictly increases over 5s AND audioLevel > 0 while
  the tone plays' (two samples 5 s apart via `__tavernTestRtc.stats('voice')`).
- 'A mute → B audioLevel falls to ~0 within 3s'.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/e2e exec playwright test web/voice.spec.ts desktop/voice-smoke.spec.ts` → exit 0 (headless, CI-equivalent).
- [ ] `pnpm e2e:realtime` run ONCE locally with real secrets → exit 0; paste the two getStats
      samples (bytesReceived t0/t1, audioLevel) into the progress.md entry (FR-19 AC evidence).
- [ ] `grep -rn "__tavernTest" app/src | grep -v "testHooks.ts"` → only the single install call site in voiceController.
- [ ] `pnpm lint && pnpm typecheck` → exit 0.

## STOP conditions (beyond global R1)

- PR spec needs remote-media assertions to pass (i.e., mock SFU can't express a required AC) →
  blocker; do NOT silently move the assertion to nightly.
- `wrangler dev --env e2e` does not pick up `.dev.vars.e2e` → blocker (config assumption broken).
- Any e2e test needs retry >1 to pass → treat as a bug (§14), fix or file blocker.

## Docs (consult only these)

- https://playwright.dev/docs/api/class-electron
- https://github.com/microsoft/playwright/issues/16621 (why flags go through appendSwitch)
- https://developers.cloudflare.com/workers/configuration/secrets/ (.dev.vars.<env> convention)
