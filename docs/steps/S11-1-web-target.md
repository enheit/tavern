# S11.1 — Web target: worker-served app, parity, refresh gate

- after: S6.2, S8.5
- unlocks: S12.4
- FRs: FR-42, FR-43
- references: PLAN §1.8, §2 (A1/A5/A6), §3.4 (wrangler pins), §4 (`platform/web.ts`), §6.3 (bridge contract), §10 (hermeticity split), §11 (deploy account guard), §14 (`wrangler dev` rebuild note)

## Goal

Make the identical React app a first-class web client served by the Worker
(same origin as the API), with pinned platform fallbacks, the FR-43 refresh
loading gate proven by e2e, the full web e2e suite passing against the
worker-served build, and a first real deploy to the personal Cloudflare account.

## Preconditions (run these; red = STOP)

- `grep -q '^## S6.2' docs/progress.md && grep -q '^## S8.5' docs/progress.md` → exit 0
- `pnpm -F @tavern/app build` → exit 0 (produces `app/dist`)
- `grep -q '"single-page-application"' worker/wrangler.jsonc` → exit 0 (S1.1 assets block)

## Tasks

1. **Assets wiring audit** (S1.1 created it — verify, fix if drifted):
   `worker/wrangler.jsonc` `assets` block = `{ "directory": "../app/dist",
   "not_found_handling": "single-page-application", "binding": "ASSETS",
   "run_worker_first": ["/api/*"] }`. Document in the step's progress entry that the
   WS upgrade path `/api/servers/:id/ws` is covered by the `/api/*` glob (it is — no
   extra pattern).
2. Root script pins (root `package.json`):
   `"build:web": "pnpm -F @tavern/app build && pnpm -F @tavern/worker run deploy:dry"`;
   worker `package.json`: `"deploy:dry": "wrangler deploy --dry-run"`,
   `"deploy": "wrangler deploy"`.
3. **`platform/web.ts` completeness audit** against `app/src/platform/types.ts` (S4.3's
   frozen `PlatformBridge`) — every method present with the pinned behavior:
   - `kind: 'web'` (the discriminant is `PlatformBridge.kind: 'desktop'|'web'` in
     `app/src/platform/types.ts`, S4.3 — the OS union `'win32'|'darwin'|'linux'` lives
     on the desktop-only `window.tavern`/`TavernIpc` surface, not here).
   - `secrets.getToken/setToken` → resolve `null` / no-op (same-origin cookies carry
     the session, PLAN A5).
   - `capture.getScreenSources` → `[]`; `capture.selectSource` → no-op;
     `capture.loopbackAudioSupported` → `false`. Web screen capture flows through the
     S7.2 media-engine `capture.ts` (the app's only `getDisplayMedia` call site) with the
     preset-derived ideal/max constraints (S8.1) — no `getDisplayMedia` call in this file
     or any feature hook (A1). `SharePickerDialog`'s web variant shows preset selection
     only; the share-audio switch is hidden because `loopbackAudioSupported()` is `false`.
   - `notifications.show` → `new Notification(title, { body, tag })`;
     `notifications.onClick` → `notification.onclick` fires the registered callback with
     the notification `tag` (navigation is the S6.2 callback's job); the bridge itself
     only calls `window.focus()`. Permission UX (pinned): flipping a notification toggle
     in Settings while `Notification.permission === 'default'` calls
     `Notification.requestPermission()`; `'denied'` → revert the switch + toast
     `m.settings_notifications_denied()` (the key S6.2 owns — do not add a new key).
   - `updates.onUpdateReady` → never fires; `updates.restartToUpdate` → no-op; the
     update pill component returns `null` on web (assert in test).
   - `shell.setBadge` → no-op (pinned: no web badge in v1); `shell.focusWindow` →
     `window.focus()`.
4. **FR-43 refresh gate e2e** (`e2e/web/refresh.spec.ts`): logged-in context at
   `/s/:serverId` with ≥1 chat message → `page.reload()` → assert (a) the boot loader
   `[data-testid="boot-loader"]` is visible before any route content, (b) the login
   page **never** appears (poll `getByTestId('page-login')` — the frozen S4.2 id —
   absent 20×100ms during boot), (c) final state is the same server view with history
   rendered. Also:
   `'deep link direct load'` — fresh `page.goto('/s/:id')` (BrowserRouter + SPA
   fallback) lands correctly. The "content never renders before ready" invariant is
   unit-tested in S4.3 — this e2e is the integration proof.
5. **Worker-target parity suite**: create a dedicated config
   `e2e/playwright.worker.config.ts` (Playwright has no per-project `webServer` — it is a
   top-level option only, so the worker-served run needs its own config rather than a
   project in `e2e/playwright.config.ts`). It pins one project `web-worker` (`testDir:
   'e2e/web'`, `use.baseURL: 'http://localhost:8787'`) and a single top-level
   `webServer: { command: 'pnpm -F @tavern/worker dev', url:
   'http://localhost:8787/api/health', reuseExistingServer: !process.env.CI }`. Root
   script `"e2e:worker-target": "pnpm build:web && pnpm -F @tavern/e2e exec playwright
   test --config playwright.worker.config.ts --grep-invert @realtime"`. Build ALWAYS
   precedes wrangler start (PLAN §14: wrangler crashes if the assets dir is rebuilt under
   it — this ordering avoids it by construction).
6. **Deploy** (first real deploy):
   - `pnpm -F @tavern/worker exec wrangler whoami` → the account MUST be
     `fd8a5f7a38f28a2cd11e79e85985c7d4` (Roman's personal). Anything else (e.g. any
     Icelook account) → STOP, do not deploy.
   - Required secrets exist (`secrets.required` in wrangler.jsonc validates on deploy).
   - `pnpm -F @tavern/worker run migrate:remote` → applies every not-yet-applied migration to
     the real `tavern-db` (S1.2 applied only the auth migration remotely; later migrations have
     been `--local`-only until now — skipping this makes the deployed smoke below fail on
     missing tables). From S12.2 on, `deploy.yml` runs this automatically before every deploy.
   - `pnpm -F @tavern/worker run deploy` → note the `*.workers.dev` URL.
   - Smoke (manual evidence pasted into progress.md, per repo verification rule):
     `curl -s https://<deployed-url>/api/health` → `{"ok":true}`; browser loads the
     login screen; register + send one chat message round-trips.

   (No new i18n key: the notification-denied toast reuses S6.2's `settings_notifications_denied`.)

## Pinned interfaces & artifacts

Files created: `e2e/web/refresh.spec.ts`, `e2e/web/deployed-smoke.spec.ts` (auth+chat
only; runs when `E2E_BASE_URL` env is set, skipped otherwise — the mechanism for the
manual deployed smoke), `e2e/playwright.worker.config.ts` (worker-served parity config).
Files modified: root `package.json`, `worker/package.json`,
`app/src/platform/web.ts` (+ its test), Settings notification toggle component
(permission UX), `worker/wrangler.jsonc` (only if the audit finds drift).

FR-42 AC interpretation (pinned): "full e2e against the deployed worker" is satisfied
by (a) the full hermetic suite against the locally worker-served build
(`e2e:worker-target`), plus (b) the auth+chat `deployed-smoke.spec.ts` against the real
deployment — voice/media against production is nightly `@realtime` territory (PLAN
§10), not a PR/step gate.

## Tests

- `app/src/platform/web.test.ts` — `describe('FR-42 web platform bridge')`:
  `'satisfies the PlatformBridge zod contract'`, `'secrets resolve null'`,
  `'loopbackAudioSupported false'`, `'notification toggle requests permission when
  default'`, `'denied permission reverts toggle'`, `'update pill renders null'`.
- `e2e/web/refresh.spec.ts` — `describe('FR-43 refresh gate')`: `'reload shows loader
  then same server view, login never flashes'`, `'deep link direct load lands on
  server view'`.
- `e2e/web/deployed-smoke.spec.ts` — `describe('FR-42 deployed smoke')`:
  `'register, login, send and receive a chat message'` (skips without `E2E_BASE_URL`).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm build:web` → exit 0
- [ ] `pnpm -F @tavern/app test -- src/platform` → exit 0, 0 skipped
- [ ] `pnpm -F @tavern/e2e exec playwright test web/refresh.spec.ts --project=web` → all green
- [ ] `pnpm e2e:worker-target` → all green (full web suite, worker-served, mock SFU)
- [ ] `pnpm check:i18n && pnpm lint && pnpm -F @tavern/app typecheck` → exit 0
- [ ] Deploy evidence in progress.md: `wrangler whoami` account line, deploy output URL, curl health output, chat round-trip statement (`E2E_BASE_URL=<url> pnpm -F @tavern/e2e exec playwright test web/deployed-smoke.spec.ts --project=web` → green; the spec navigates to `process.env.E2E_BASE_URL` directly, ignoring the project baseURL)

## STOP conditions (beyond global R1)

- `wrangler whoami` shows any account other than `fd8a5f7a38f28a2cd11e79e85985c7d4` →
  STOP before any deploy (hard rule from memory/PLAN §11 — never the Icelook account).
- A web e2e spec fails ONLY under `web-worker` (passes under `web`) → blocker
  naming the spec; do not fork spec behavior per project.
- `PlatformBridge.kind` in `app/src/platform/types.ts` (S4.3) has no `'web'` member →
  blocker (S4.3 owns the bridge discriminant).

## Docs (consult only these)

- https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- https://developers.cloudflare.com/workers/wrangler/commands/#deploy
- https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- https://playwright.dev/docs/test-webserver
