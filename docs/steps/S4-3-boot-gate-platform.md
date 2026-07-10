# S4.3 — Boot gate, platform bridge, stores & client libs

- after: S4.2
- unlocks: S4.4, S5.1
- FRs: FR-43 (boot loading gate), FR-45 (presence store plumbing)
- references: PLAN §2 (A1/A4/A5/A6), §4, §6.2, §6.3, §7.3 (volumes schema), §9.5/9.9, §10

## Goal

The renderer's non-UI backbone: one `PlatformBridge` abstraction over desktop/web, the REST and
WS clients (zod at every boundary), the zustand store set, and the FR-43 boot state machine with
the global loader. Everything unit-tested against mocks — no live backend in this step.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/app test` → exit 0 (S4.2 green)
- `grep -q "VolumesV1" shared/src/domain.ts` → exit 0 (S0.2 defines it; if absent that is an
  S0.2 gap → STOP, do not define it here).

## Tasks

1. `src/platform/types.ts` — the ONE abstraction (A1); `electron.ts` adapts `window.tavern`
   (validating outbound args per §6.3); `web.ts` implements: notifications → `Notification` API
   (+ permission request on first enable), capture → native `getDisplayMedia` picker
   (`getScreenSources` returns `[]`, `selectSource` no-op), `loopbackAudioSupported` → `false`,
   secrets → no-op (cookie mode), updates → no-op. Module-level
   `export const platform: PlatformBridge` selected once by `window.tavern` presence.
2. `src/lib/authTransport.ts` (A5) — pinned surface below; desktop persists the bearer token via
   `platform.secrets` and captures it from the `set-auth-token` response header; web relies on
   same-origin cookies (all methods no-op except `clear`).
3. `src/lib/apiClient.ts` — `fetch` wrapper: `baseUrl = import.meta.env.VITE_API_URL ?? ''`;
   merges `authTransport.getAuthHeaders()`; parses success bodies with the matching
   `shared/src/api.ts` schema and non-2xx into `ApiError` (§9.5). Also `upload()` for multipart.
   Also `src/lib/errorMessage.ts` — `errorMessage(code: ErrorCode): string`, an EXHAUSTIVE
   `Record<ErrorCode, () => string>` mapping each code to its `m.error_<code>()` paraglide message
   (seeded in S4.2). This is the ONLY code→message resolver; feature steps (S5.1/S5.2/…) call it
   for server-error slots — no dynamic key construction (§9.6). A missing/extra code fails to
   typecheck (the `Record` is exhaustive over `ErrorCode`).
4. `src/lib/wsClient.ts` (§6.2, A4, A6) — pinned surface below. Pinned WS base derivation:
   `wsBase = (import.meta.env.VITE_API_URL ?? location.origin).replace(/^http/, 'ws')` (rewrites
   `http→ws` / `https→wss`; same env var apiClient uses). Connect flow:
   `POST /api/ws-ticket {serverId}` → open
   `${wsBase}/api/servers/${serverId}/ws?ticket=…` → send `hello {proto:1}` → expect `hello.ok`
   within `LIMITS.helloTimeoutMs`. Reconnect: backoff `min(1000·2ⁿ, 30000)` ±20% jitter
   (`LIMITS.reconnectCapMs`); every reconnect refetches a ticket; `hello.ok` snapshot REPLACES
   room state (no deltas). Inbound frames zod-parsed against the §App-A union — invalid frames
   are dropped + `console.error` (§9.5 exemption: also sets `lastProtocolError` on the store).
   Sending while not open throws `WsNotOpenError` — callers disable UI instead of queueing.
   `ping` every `LIMITS.pingIntervalMs`.
5. `src/stores/` (zustand 5, one file per store, §9.9 selectors):
   - `session.ts` `{ status:'booting'|'unauthed'|'authed', profile:UserProfile|null }`
   - `servers.ts` `{ servers:ServerSummary[], activeServerId:string|null,
     connState:Record<serverId,'connecting'|'open'|'reconnecting'|'closed'> }`
   - `room.ts` — `createRoomStore(serverId)` factory: `{ members:Member[], messages:ChatMessage[],
     hasMoreHistory, voice:VoiceState, streams:StreamInfo[], recording:RecordingState,
     activityTail:ActivityEntry[], serverMeta, kicked:boolean }` + reducers applying each s2c
     frame (§App-A). The App-A `kicked` frame sets `kicked = true` (consumed by S5.2's ServerPage;
     this is the only `kicked` signal — there is no separate `wsStatus` field, connection state
     lives on the servers store `connState`).
   - `media.ts` `{ devices, selectedMicId, selectedSinkId, captureState }` (S7 fills behavior).
   - `settings.ts` — EXTEND S4.2's file with notification prefs mirror + `volumes` persisted under
     localStorage `settings.volumes.v1` (schema `VolumesV1` from shared).
6. Boot machine (FR-43) in `src/features/boot/`: states
   `loading → unauthed | loadingMe → connectingActive → ready` — pinned rules: no token/401 →
   `unauthed`; `GET /api/me` populates session+servers; WS connects to ALL joined servers in
   parallel (A6) but `ready` fires after the ACTIVE server's `hello.ok` (others stream in);
   zero joined servers → `ready` routes to `/join`. `<BootGate>` wraps every route except
   `/login|/register`, rendering `boot-loader` until `ready` — no feature component mounts before
   `ready` (the FR-43 no-flash guarantee). Export `bootStore` (pinned surface below):
   `restart()` re-runs the machine from `loading` (called by S5.1 after login) and `reset()`
   returns it to `unauthed` (called by S5.1 after logout).

## Pinned interfaces & artifacts

```ts
// platform/types.ts (frozen — S5+ features import ONLY this)
interface PlatformBridge {
  kind: 'desktop' | 'web'
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> }
  capture: {
    getScreenSources(): Promise<ScreenSource[]>
    selectSource(id: string | null): Promise<void>
    loopbackAudioSupported(): Promise<boolean>
  }
  notifications: { show(n: { title: string; body: string; tag: string }): Promise<void>
                   onClick(cb: (tag: string) => void): () => void }
  updates: { onUpdateReady(cb: () => void): () => void; restartToUpdate(): void }
  shell: { setBadge(count: number | null): void; focusWindow(): void }
}

// lib/authTransport.ts (frozen)
interface AuthTransport {
  getAuthHeaders(): Promise<Record<string, string>>
  storeFromResponse(headers: Headers): Promise<void>   // reads 'set-auth-token' (desktop only)
  clear(): Promise<void>
}

// lib/apiClient.ts (frozen)
class ApiError extends Error { code: ErrorCode; status: number }

// lib/wsClient.ts (frozen)
type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'
interface WsConnection {
  status: WsStatus
  send(msg: C2S): void                    // throws WsNotOpenError when status !== 'open'
  on<T extends S2C['t']>(t: T, cb: (m: Extract<S2C, { t: T }>) => void): () => void
  close(): void
}
function connectRoom(serverId: string): WsConnection

// lib/errorMessage.ts (frozen)
function errorMessage(code: ErrorCode): string   // exhaustive Record<ErrorCode, () => string>

// features/boot/bootStore (frozen — consumed by S5.1)
interface BootStore { restart(): void; reset(): void }
declare const bootStore: BootStore
```

Files created/modified: `app/src/platform/*`, `app/src/lib/*` (incl. `errorMessage.ts`),
`app/src/stores/*`, `app/src/features/boot/*` (incl. `bootStore`). No shared/ touch —
`VolumesV1` is defined once in S0.2 and imported.

## Tests

- `app/test/wsClient.test.ts` — `describe('§6.2 wsClient')` (mock WebSocket + fetch, fake
  timers): backoff sequence `1s,2s,4s…30s cap` with jitter bounds; ticket refetched per attempt;
  `hello.ok` resync replaces state; invalid frame dropped, connection stays open; send-while-closed
  throws `WsNotOpenError`; ping cadence.
- `app/test/apiClient.test.ts` — `describe('§9.8 apiClient')`: schema-mismatch response →
  `ApiError('bad_message')`; non-2xx `{error}` → typed code; bearer header attached on desktop.
  Plus `describe('errorMessage')`: `errorMessage(code)` returns a non-empty string for every
  entry of `ERROR_CODES` (proves the Record is exhaustive).
- `app/test/authTransport.test.ts` — both modes: desktop stores/reads/clears via platform mock;
  web is cookie no-op.
- `app/test/boot.test.tsx` — `describe('FR-43 boot gate')` 5 named cases: no-token → login;
  401 on /api/me → unauthed (token cleared); happy path → loader until active `hello.ok` then
  ready; zero servers → /join; loader visible the entire time before ready (no intermediate UI —
  assert `page-*` never mounts early).
- `app/test/stores.test.ts` — room reducer applies each s2c frame type once (table-driven over
  §App-A); volumes persistence round-trip validates `VolumesV1`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --coverage` → exit 0; overall ≥70% (the threshold pinned in
      S4.2's `app/vitest.config.ts` — this step adds no per-glob override)
- [ ] `pnpm typecheck && pnpm lint && node scripts/check-i18n-literals.mjs` → exit 0

## STOP conditions (beyond global R1)

- Any need for a platform-conditional outside `src/platform/` → STOP; the bridge is the only
  seam. Enforcing grep: `grep -rl "window.tavern" app/src | grep -v "^app/src/platform/"` must
  output nothing (the sole `window.tavern` reference is `app/src/platform/electron.ts`).

## Docs (consult only these)

- PLAN §App-A (message catalog), §App-B (timing constants)
- https://zustand.docs.pmnd.rs (v5) · https://tanstack.com/query/latest
