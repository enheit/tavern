# S4.1 — Electron shell (main + preload, typed IPC, security baseline)

- after: S0.2
- unlocks: S4.4
- FRs: FR-16 (notification transport), FR-28 (capture plumbing), FR-44 (update plumbing stubs)
- references: PLAN §2 (A10), §3.2, §3.6, §4, §6.3, §9, §10 (Electron e2e pinned patterns)

## Goal

Create `@tavern/desktop`: Electron 43 main process + preload exposing the typed `window.tavern`
bridge from `shared/src/ipc.ts`. No UI here — the renderer is `@tavern/app` (dev: its Vite server;
prod: bundled dist served over the `app://` scheme). Security checklist items are implemented
here, once, and never revisited.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/shared test` → exit 0 (S0.2 green; `shared/src/ipc.ts` exists)
- `node -e "require('node:assert').ok(process.version.match(/^v2[2-9]/))"` → exit 0

## Tasks

1. Create `desktop/package.json`: name `@tavern/desktop`, `"main": "out/main/index.js"`,
   private, scripts `dev` (`electron-vite dev`), `build` (`electron-vite build`),
   `typecheck` (`tsc --noEmit`), `test` (`vitest run`). Install exact (R2):
   `pnpm -F @tavern/desktop add -DE electron@43.1.0 electron-vite@5.0.0 vite@7 electron-updater@6.8.9
   vitest@4.1.10 @vitest/coverage-istanbul@4.1.10 @types/node@24.7.0`.
2. Create `desktop/electron.vite.config.ts` with ONLY `main` and `preload` sections (no
   `renderer` — the renderer is external). Both build to `out/main` / `out/preload`, target
   `node24`, externalize `electron`.
3. Implement main modules (one responsibility each). This step's `desktop/src/main/` set
   extends PLAN §4's listing with `protocol.ts`, `permissions.ts`, and `flags.ts` (§4 shows the
   core set; these three split out cross-cutting concerns — not a §4 conflict):
   - `src/main/index.ts` — startup order pinned: read env/flags → `singleInstance` gate →
     protocol registration → app.whenReady → permissions → ipc → window.
   - `src/main/window.ts` — BrowserWindow: `width:1280,height:800,minWidth:940,minHeight:560`,
     `show:false` (+`ready-to-show`), `autoHideMenuBar:true`, `backgroundColor:'#111111'`,
     `title:'Tavern'`, webPreferences `{ contextIsolation:true, sandbox:true,
     nodeIntegration:false, preload:<out/preload/index.js> }`. Load: if
     `process.env.TAVERN_RENDERER_URL` → `loadURL(it)`, else `loadURL('app://tavern/index.html')`.
     Navigation lockdown (checklist #13/#14): `will-navigate` → `preventDefault` unless target
     origin is the loaded origin; `setWindowOpenHandler` → `{action:'deny'}` and
     `shell.openExternal(url)` only for `https:`.
   - `src/main/protocol.ts` — `protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:
     {standard:true, secure:true, supportFetchAPI:true}}])` before ready;
     `protocol.handle('app', …)` after ready, serving files from
     `path.join(app.getAppPath(), 'renderer')` in packaged mode (inside the asar — matches
     S12.1's electron-builder `files` mapping; NOT `process.resourcesPath`) and
     `path.join(__dirname, '../../..', 'app/dist')` when unpackaged; path-traversal guard
     (resolve + prefix check); correct `Content-Type` by extension. Never `file://` (checklist #18).
   - `src/main/singleInstance.ts` — `app.requestSingleInstanceLock()`; on `second-instance`
     focus+restore the window. Skipped entirely when `TAVERN_E2E==='1'`.
   - `src/main/ipc.ts` — registers every channel of §6.3 (channel names pinned below); each
     `ipcMain.handle` first validates `event.senderFrame.url` starts with `app://tavern` or
     `process.env.TAVERN_RENDERER_URL` (checklist #17), then zod-parses args with the schema from
     `shared/src/ipc.ts`; invalid → throw, never partial-apply.
   - `src/main/permissions.ts` — on the default session: `setPermissionRequestHandler` and
     `setPermissionCheckHandler` both allow exactly `['media','speaker-selection']`, deny all
     else. (electron#42713: `media` must be allowed in the CHECK handler or `enumerateDevices`
     breaks.) In `TAVERN_E2E` mode requests auto-grant (same allowlist).
   - `src/main/capture.ts` — holds the armed source id set by `capture:selectSource`;
     `session.setDisplayMediaRequestHandler((req, cb) => …)` resolves the armed
     `desktopCapturer` source with audio per FR-28: `win32:'loopback'`, `darwin:'loopback'`
     (Electron≥39 CoreAudio tap — S8.1 probes; §3.7 fallback), `linux:'loopback'` only when the
     PipeWire flag path is validated (S8.1) else no audio key. `capture:getScreenSources` maps
     `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{width:320,height:180}})`
     to the `ScreenSource` schema. `loopbackAudioSupported()` pinned initial matrix:
     `win32→true`, `darwin→true`, `linux→false` (S8.1 owns revisions).
   - `src/main/flags.ts` — before ready: when `TAVERN_E2E==='1'` append switches
     `use-fake-device-for-media-stream`, `use-fake-ui-for-media-stream`,
     `use-file-for-fake-audio-capture=${process.env.TAVERN_FAKE_AUDIO}` (§10 — launch-args do NOT
     work, playwright#16621); when `TAVERN_USER_DATA` set → `app.setPath('userData', it)`; on
     linux append `enable-features=PulseaudioLoopbackForScreenShare`; GPU crash guard: if
     `<userData>/gpu-crash` flag file exists → `append-switch disable-gpu`; runtime handler on
     `child-process-gone` (`type==='GPU'`, twice within 10s) writes the flag file,
     `app.relaunch()`, `app.exit(0)`. `ELECTRON_OZONE_PLATFORM_HINT` is left to the OS env
     (no default flip).
   - `src/main/notifications.ts` — `app.setAppUserModelId('com.tavern.app')` on win32;
     `notifications:show` → `new Notification({title,body})` with click → focus window +
     `webContents.send('notifications:clicked', tag)`.
   - `src/main/secrets.ts` — token string ⇄ `safeStorage.encryptString/decryptString`, persisted
     at `<userData>/secrets.bin`; absent/corrupt file → `null` (never throw to renderer).
   - `src/main/updates.ts` — v1 STUB with the final surface: exports `initUpdates(win)` that
     no-ops unless packaged; sends the `update://ready` webContents event (channel string pinned
     by PLAN §6.3; S12.2 emits on the same string); `updates:restartToUpdate` handler no-ops.
     S12.2 fills the electron-updater body — the IPC surface is frozen HERE.
4. Implement `src/preload/index.ts` — `contextBridge.exposeInMainWorld('tavern', …)`
   implementing `shared/src/ipc.ts` exactly; wraps `ipcRenderer.invoke` per channel; push events
   (`notifications:clicked`, `update://ready`) exposed as `onX(cb)` subscription functions —
   raw `ipcRenderer` is NEVER exposed (checklist #20). Preload zod-parses main→renderer payloads.
5. Write tests (below), wire `desktop` into root `pnpm test` / `pnpm typecheck`.

## Pinned interfaces & artifacts

IPC channel names (frozen; renderer/preload/main all reference these exact strings):

```
secrets:getToken · secrets:setToken · capture:getScreenSources · capture:selectSource ·
capture:loopbackAudioSupported · notifications:show · notifications:clicked (push) ·
update://ready (push) · updates:restartToUpdate · shell:setBadge · shell:focusWindow
```

Env contract (frozen): `TAVERN_RENDERER_URL`, `TAVERN_E2E`, `TAVERN_USER_DATA`,
`TAVERN_FAKE_AUDIO`.

`desktop/electron.vite.config.ts` shape (no renderer key):

```ts
export default defineConfig({
  main:    { build: { outDir: 'out/main',    lib: { entry: 'src/main/index.ts' } } },
  preload: { build: { outDir: 'out/preload', lib: { entry: 'src/preload/index.ts' } } },
})
```

Files created: everything under `desktop/` listed above + `desktop/tsconfig.json` (extends
`tsconfig.base.json`, `types: ["node"]`, `include: ["src", "test"]`) + `desktop/vitest.config.ts`
(pinned below). No other package touched.

`desktop/vitest.config.ts` (pinned):

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'istanbul', include: ['src/**'], thresholds: { lines: 70 } },
  },
})
```

## Tests

`desktop/test/` (vitest, node env, `vi.mock('electron', …)` with a shared mock in
`desktop/test/electron-mock.ts`):

- `ipc.test.ts` — `describe('A10/§6.3 IPC bridge')`: rejects payload failing zod; rejects
  senderFrame with foreign origin; happy path per channel returns schema-valid data.
- `permissions.test.ts` — `describe('§7.3 permission handlers')`: matrix — media allowed
  (request+check), speaker-selection allowed, geolocation/notifications(permission)/others denied.
- `capture.test.ts` — `describe('FR-28 capture plumbing')`: selectSource arms id; display-media
  handler resolves armed source then clears it; audio key per platform matrix (mock
  `process.platform`); unarmed request → callback with denial.
- `loopback.test.ts` — `describe('FR-28 loopbackAudioSupported')`: win32 true / darwin true /
  linux false.
- `secrets.test.ts` — `describe('A5 token storage')`: roundtrip; corrupt file → null;
  `setToken(null)` deletes file.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/desktop test -- --coverage` → exit 0, line coverage ≥70%
- [ ] `pnpm -F @tavern/desktop build` → exit 0, `out/main/index.js` and `out/preload/index.js` exist
- [ ] `pnpm typecheck && pnpm lint` → exit 0
- [ ] Manual evidence (progress.md, per repo verification rule): S4.2 is a parallel step, so this
      gate does NOT require the real renderer. Run
      `TAVERN_RENDERER_URL='data:text/html,<title>Tavern</title><h1>shell ok</h1>' pnpm -F @tavern/desktop dev`
      → a window titled "Tavern" opens and loads the placeholder — one line + screenshot path in
      the entry. (Loading the real `@tavern/app` renderer is exercised by S4.4's desktop smoke,
      after S4.2 exists.)

## STOP conditions (beyond global R1)

- `electron-vite build` fails **solely because the `renderer` section is absent** → pre-authorized
  contingency (record in progress.md, not a blocker): add a dead-stub renderer
  `renderer: { root: 'src/renderer-stub', build: { outDir: 'out/renderer-stub' } }` with a
  one-line `index.html` that is never loaded; architecture unchanged.
- `protocol.handle` cannot serve the unpackaged `app/dist` path in dev-packaged smoke → STOP
  (do not fall back to `file://`).

## Docs (consult only these)

- https://electron-vite.org/config/ and https://electron-vite.org/guide/
- https://www.electronjs.org/docs/latest/tutorial/security (items 7, 13, 14, 17, 18, 20)
- https://www.electronjs.org/docs/latest/api/session (display media handler, permission handlers)
- https://www.electronjs.org/docs/latest/api/desktop-capturer
- https://www.electronjs.org/docs/latest/api/safe-storage · /api/protocol · /api/notification
