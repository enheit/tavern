# S0.2 — @tavern/shared: schemas, limits, presets, layout (the contract package)

- after: S0.1
- unlocks: every backend and client step (S1.1+, S4.1+)
- FRs: FR-32 (layout algorithm); contract surface for all others
- references: PLAN §5.4, §6.1, §6.3, App-A, App-B, App-C, App-D, §9.8

## Goal

Implement the single source of truth every other package imports: the complete WS protocol
(App-A) as zod discriminated unions, REST body schemas (§6.1), the IPC bridge contract (§6.3),
domain types (§5.4), the preset/bitrate tables (App-D), the canvas layout algorithm (App-C), all
numeric limits (App-B), and the error-code union. Everything below is a contract consumed
verbatim by dependent steps — field names and values are not adjustable.

## Preconditions (run these; red = STOP)

- `pnpm typecheck` → exit 0 (S0.1 green)
- `cat docs/progress.md | grep "S0.1"` → entry exists

## Tasks (numbered, imperative, zero alternatives)

1. `pnpm -F @tavern/shared add -E zod@4.4.3`
2. `pnpm -F @tavern/shared add -DE vitest@4.1.10 @vitest/coverage-istanbul@4.1.10`
3. Create `shared/src/limits.ts`, `errors.ts`, `domain.ts`, `presets.ts`, `layout.ts`,
   `protocol.ts`, `api.ts`, `ipc.ts` per the contract below; re-export all of them (and nothing
   else) from `shared/src/index.ts` — the workspace's ONLY barrel (PLAN §9.4).
4. Create `shared/vitest.config.ts` as pinned below; add package scripts
   `"test": "vitest run"`, `"test:coverage": "vitest run --coverage"`.
5. Write the tests listed under **Tests**.
6. Run DoD gates; progress entry; commit `feat(S0.2): shared contract package`.

## Pinned interfaces & artifacts

`limits.ts` — export a single `LIMITS` object (`as const`) with EXACTLY these keys/values:
`usernameRe: /^[a-z0-9_]{3,20}$/` · `displayNameMin: 1` · `displayNameMax: 32` ·
`passwordMinLen: 8` · `serverNicknameRe: /^[a-z0-9-]{3,32}$/i` · `serverPasswordMinLen: 4` ·
`colorRe: /^#[0-9a-f]{6}$/` · `avatarMaxBytes: 2_000_000` · `avatarSizePx: 256` ·
`messageMaxChars: 2000` · `historyPageSize: 50` · `soundMaxBytes: 10_000_000` ·
`soundMaxDurationMs: 300_000` · `soundMinTrimMs: 200` · `soundNameMax: 32` ·
`recordingMaxDurationMs: 14_400_000` · `recordingTimesliceMs: 10_000` ·
`recordingPartBytes: 5_242_880` · `maxConcurrentScreenShares: 4` · `maxServersPerUser: 20` ·
`maxMembersPerServer: 25` · `speakingRmsThreshold: 0.02` · `speakingSustainMs: 100` ·
`speakingHangoverMs: 300` · `wsTicketTtlMs: 30_000` · `helloTimeoutMs: 5_000` ·
`pingIntervalMs: 30_000` · `reconnectCapMs: 30_000` · `emptyVoiceCloseMs: 60_000` ·
`rateAuthPerIpPerMin: 10` · `rateChatPerSec: 5` · `rateChatBurst: 10` ·
`rateSoundPlayPerSec: 1` · `rateUploadsPerHour: 10` · `rateRtcOpsPerMin: 60` ·
`egressWarnGB: 700` · `egressKillGB: 900`

`errors.ts` — `export const ERROR_CODES = [...] as const` and
`export type ErrorCode = (typeof ERROR_CODES)[number]` with EXACTLY these 31 codes (the union
required by S1–S12; the `contract.test.ts` count assertion below locks the length at 31):
`bad_message, bad_request, invalid_ticket, unauthorized, forbidden, not_found, not_member,
not_admin, not_in_voice, not_implemented, voice_elsewhere, share_cap, cost_cap, pull_denied,
already_recording, rate_limited, rtc_rate_limited, invalid_credentials, username_taken,
nickname_taken, wrong_password, password_mismatch, password_too_short, server_cap, server_full,
payload_too_large, unsupported_media, sound_too_long, bad_trim, bad_part_size,
recording_too_long`.
(`server_full` = server has reached `LIMITS.maxMembersPerServer`; emitted by S2.1's join route.)
(`voice_elsewhere` is client-side-only — the DO never emits it; it exists for UI copy mapping.)

`presets.ts` — data `as const` + types; no logic beyond lookups:

```ts
export type PresetId = '480p15'|'480p30'|'480p60'|'720p15'|'720p30'|'720p60'
  |'1080p15'|'1080p30'|'1080p60'|'1440p15'|'1440p30'|'1440p60';
export interface Preset { id: PresetId; width: number; height: number; fps: number; maxKbps: number }
export const SCREEN_PRESETS: Record<PresetId, Preset>;   // exact numbers below
export const DEFAULT_SCREEN_PRESET: PresetId = '1080p30';
export const LOW_LAYER = { heightTarget: 270, fps: 15, maxKbps: 250 } as const;
export const WEBCAM_PRESET = { width: 1280, height: 720, fps: 30, maxKbps: 1000 } as const;
export const WEBCAM_LOW = { heightTarget: 180, fps: 15, maxKbps: 150 } as const;
export function presetKbps(id: PresetId): number;                  // the h-layer bitrate
export function kbpsFor(preset: PresetId, rid: 'h' | 'l'): number; // 'h' → presetKbps(preset); 'l' → LOW_LAYER.maxKbps (250)
export function lowLayerScaleDown(id: PresetId): number;  // = height / LOW_LAYER.heightTarget
```

Bitrate table (kbps — App-D, memorize nothing, copy): 480p(854×480): 15→400, 30→600, 60→900 ·
720p(1280×720): 15→700, 30→1200, 60→1800 · 1080p(1920×1080): 15→1200, 30→2000, 60→3000 ·
1440p(2560×1440): 15→1800, 30→3000, 60→4500.

`layout.ts`:

```ts
export const LAYOUT_GAP_PX = 8;
export function fittedTileArea(cellW: number, cellH: number): number; // min(w, h*16/9) * min(h, w*9/16)
export function computeLayout(n: number, canvasW: number, canvasH: number): { rows: number[] };
```

Pinned behavior: `n<=0 → {rows:[]}`. `n=1 → [1]`. `n=2` → `[2]` when
`fittedTileArea(canvasW/2, canvasH) >= fittedTileArea(canvasW, canvasH/2)` (tie → `[2]`), else
`[1,1]`. `n=3..8` → image-locked table `[2,1] [2,2] [2,3] [3,3] [4,3] [4,4]`. `n>=9` →
`ceil(n/4)` rows, sizes as even as possible, larger rows first (gives `[3,3,3] [4,3,3] [4,4,3]
[4,4,4]` for 9–12, `[4,3,3,3]` for 13). Cells are 16:9, letterboxed, `LAYOUT_GAP_PX` gap.

`domain.ts` — zod schemas + `z.infer` types, using `LIMITS` regexes (PLAN §5.4). Each name below
is exported as BOTH a zod schema and its inferred type:
`Theme = 'light'|'dark'|'system'` (standalone `z.enum`; do NOT inline — S4.2 imports it) ·
`Locale = 'en'|'uk'` (standalone `z.enum`; S4.2 imports it) ·
`UserProfile { userId: uuid, username, displayName, color, avatarKey?: string }` ·
`Presence = 'offline'|'online'|'in-voice'` ·
`Member = UserProfile & { presence: Presence, isAdmin: boolean, joinedAt: number }` ·
`MemberInit = { userId, username, displayName, color, avatarKey?: string, isAdmin: boolean, joinedAt: number }`
(Member without `presence` — the shape S3.1's DO seeds a member cache from) ·
`StreamInfo { trackName: string(1..128), kind: 'screen'|'webcam', userId, hasAudio: boolean, preset: PresetId }` ·
`VoiceMember { userId, muted: boolean, deafened: boolean }` ·
`VoiceState { members: VoiceMember[], sessionStartedAt: number|null }` ·
`RecordingState { active: boolean, recordingId?, startedBy?, startedAt? }` ·
`ChatMessage { id: int, userId, body: string(1..2000), mentions: userId[], at: number }` ·
`ActivityType = 'voice.join'|'voice.leave'|'stream.start'|'stream.stop'|'rec.start'|'rec.stop'|'member.join'|'member.kick'` ·
`ActivityEntry { id: int, type: ActivityType, userId, meta: Record<string, string | number | boolean>, at: number }`
(meta value union — App-A pins `rec.stop meta:{aborted:true}`, a boolean, so a string-only record
would reject it; `z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))`) ·
`UserSettings { notifyAll: boolean, notifyMentions: boolean, locale: Locale, theme: Theme }` ·
`VolumesV1 { v: 1, users: Record<string, number>, streams: Record<string, number>, soundboard: number, mutedUsers: string[] }`
(all numbers are GAIN floats in `0..2`; PLAN §5.4 — the ONE authoritative volumes shape, quoted
verbatim by S4.3 and S7.3, defined only here) ·
`ServerSummary { id: uuid, nickname, adminUserId, hasPassword: boolean, createdAt: number, joinedAt: number }`
(no `isAdmin` field — clients derive it as `adminUserId === self.userId`) ·
`CostStatus { usedGB: number, capGB: number, blocked: boolean }`

`protocol.ts` — two zod discriminated unions on `t`, exported as the schemas
`clientMessageSchema` (15 members) and `serverMessageSchema` (20 members), with inferred types
`export type ClientMessage = z.infer<typeof clientMessageSchema>` and `ServerMessage` likewise,
plus `export function parseClientMessage(raw: unknown): ClientMessage` and `parseServerMessage`
(throwing `ZodError` on mismatch). All four schema/type names AND the two parse functions are
load-bearing exports (S3.1/S3.2 import `clientMessageSchema`/`serverMessageSchema` directly). Exact members:

Client→Server: `hello {proto: literal 1}` · `chat.send {body: 1..messageMaxChars, nonce: uuid}` ·
`chat.history {beforeId?: int>0, limit: int 1..historyPageSize}` · `voice.join {}` ·
`voice.leave {}` · `voice.state {muted, deafened}` ·
`stream.start {kind, trackName, audioTrackName?, preset: PresetId}` ·
`stream.preset {trackName, preset: PresetId}` (FR-27 on-the-fly change — keeps DO registry + cost meter in sync) ·
`stream.stop {trackName}` ·
`watch.start {trackName}` · `watch.stop {trackName}` · `sound.play {soundId: uuid}` ·
`rec.start {}` · `rec.stop {}` · `ping {}`

Server→Client: `hello.ok {self: UserProfile, serverMeta: {id, nickname, adminUserId}, members:
Member[], voice: VoiceState, streams: StreamInfo[], recording: RecordingState, lastMessageId:
int|null, costStatus: CostStatus}` · `error {code: ErrorCode, ref?: string}` · `pong {}` ·
`chat.new {message: ChatMessage, nonce?: uuid}` · `chat.page {messages: ChatMessage[], hasMore}` ·
`activity.new {entry: ActivityEntry}` — and, each carrying `at: number` (epoch ms):
`presence.update {userId, presence, at}` · `member.update {profile: UserProfile, at}` ·
`member.joined {member: Member, at}` · `member.left {userId, at}` ·
`voice.state {voice: VoiceState, at}` · `stream.added {stream: StreamInfo, at}` ·
`stream.updated {trackName, preset: PresetId, at}` ·
`stream.removed {trackName, at}` · `sound.played {soundId, byUserId, at}` · `sound.updated {at}` ·
`rec.state {recording: RecordingState, at}` · `server.updated {nickname, at}` · `kicked {at}` ·
`cost.warning {usedGB, capGB, at}`

WS close codes as consts: `CLOSE_PROTOCOL_VIOLATION = 1008`, `CLOSE_KICKED = 4001`,
`CLOSE_BAD_TICKET = 4002`, `CLOSE_REPLACED = 4003`.

`api.ts` — request/response zod schemas (names exact; fields per §6.1 + domain types):
`RegisterForm {username, password, repeatPassword}` (with `.refine` equality) · `LoginForm
{username, password}` · `MeResponse {user: UserProfile, settings: UserSettings, servers:
ServerSummary[]}` · `PatchProfileRequest {displayName?, color?, username?}` (≥1 key) ·
`CreateServerRequest {nickname, password?}` · `JoinServerRequest {nickname, password?}` ·
`PatchServerRequest {nickname?, password?: string|null}` (≥1 key) · `WsTicketRequest {serverId}` ·
`WsTicketResponse {ticket: string}` · `MembersResponse {members: (UserProfile & {isAdmin,
joinedAt})[]}` · `ActivityPage {entries: ActivityEntry[], hasMore}` · `StatsResponse {perUser:
{userId, messages: int, streamSeconds: int}[], watchPairs: {viewerId, streamerId, seconds:
int}[]}` · `Sound {id: uuid, name: 1..soundNameMax, uploaderId, durationMs: int, trimStartMs: int,
trimEndMs: int, createdAt, playCount: int}` · `SoundsResponse {sounds: Sound[]}` ·
`PatchSoundRequest {name?, trimStartMs?, trimEndMs?}` (≥1 key) · `Recording {id, startedBy,
durationMs: int|null, startedAt, endedAt: int|null}` · `RecordingsResponse {recordings:
Recording[]}` · `OpenRecordingResponse {recordingId, uploadId}` · `UploadPartResponse {etag}` ·
`CompleteRecordingRequest {parts: {partNumber: int, etag}[], durationMs}` · `RtcSessionResponse
{sessionId}` · `RtcTracksLocalRequest {sessionDescription: {sdp, type: 'offer'}, tracks:
{location: 'local', mid, trackName}[]}` · `RtcTracksRemoteRequest {tracks: {location: 'remote',
sessionId, trackName, simulcast?: {preferredRid: 'h'|'l'}}[]}` · `RtcTracksResponse
{requiresImmediateRenegotiation: boolean, tracks: {trackName, mid?, error?: {code, message}}[],
sessionDescription?: {sdp, type: 'answer'|'offer'}}` · `RtcRenegotiateRequest
{sessionDescription: {sdp, type: 'answer'}}` · `RtcClosePayload {tracks: {mid}[],
sessionDescription?: {sdp, type: 'offer'}, force: boolean}` · `IceServersResponse {iceServers:
{urls: string | string[], username?, credential?}[]}` · `ApiErrorBody {error: ErrorCode}`

`ipc.ts` — the `window.tavern` contract (PLAN §6.3): zod schemas for every method's args/return +
the TS interface. The interface is named `TavernIpc` (NOT `PlatformBridge` — that name is owned
solely by S4.3's `app/src/platform/types.ts`, the renderer-side wrapper that adds
`kind: 'desktop'|'web'` on top of this surface). `window.tavern` is desktop-only, so `platform`
has no `'web'` member here:

```ts
export interface ScreenSource { id: string; name: string; thumbnailDataUrl: string; appIcon?: string }
export interface TavernIpc {
  platform: 'win32' | 'darwin' | 'linux';
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): Promise<boolean>;
  };
  notifications: {
    show(n: { title: string; body: string; tag: string }): Promise<void>;
    onClick(cb: (tag: string) => void): void;
  };
  updates: { onUpdateReady(cb: (info: { version: string }) => void): void; restartToUpdate(): Promise<void> };  // push channel 'update://ready'
  shell: { setBadge(count: number | null): Promise<void>; focusWindow(): Promise<void> };
}
```

`shared/vitest.config.ts` (complete):

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'istanbul', include: ['src/**'], thresholds: { lines: 90 } },
  },
});
```

## Tests

- `shared/test/layout.test.ts` — `describe('FR-32 canvas auto-layout')`:
  - locks the full table at canvas 1600×900 for n=1..12:
    `[1] [2] [2,1] [2,2] [2,3] [3,3] [4,3] [4,4] [3,3,3] [4,3,3] [4,4,3] [4,4,4]`
  - n=2 tie-break (pre-computed, assert these): 2100×900 → `[2]` (side-by-side area 620156.25 >
    stacked 360000); 1600×900 → `[2]` (tie 360000 = 360000); 1200×900 → `[1,1]` (202500 < 360000)
  - `fittedTileArea` spot values: (800,900)→360000, (1050,900)→620156.25
  - extension rule: n=13 → `[4,3,3,3]`, n=16 → `[4,4,4,4]`; n=0 → `[]`
- `shared/test/protocol.test.ts` — `describe('App-A protocol round-trips')`:
  - one valid fixture per message parses (all 15 c2s + 20 s2c — a fixture table, count asserted)
  - invalid cases reject: unknown `t`, `chat.send` body 2001 chars, `chat.history` limit 51,
    `stream.start` bad preset id, `hello` proto 2, `error` with unknown code
- `shared/test/limits.test.ts` — `describe('App-B limits')`:
  - usernameRe accepts `roman_1` and `abc`; rejects `ab` (too short), `ROMAN` (uppercase),
    a 21-char string, `has space`
  - serverNicknameRe accepts `Tavern-01` (case-insensitive), rejects `ab` and 33-char string
  - colorRe accepts `#a1b2c3`, rejects `#A1B2C3`, `#fff`, `a1b2c3`
- `shared/test/presets.test.ts` — `describe('App-D presets')`:
  - 12 preset ids exist; `presetKbps('1080p60') === 3000`; `presetKbps('480p15') === 400`
  - `kbpsFor('1080p30','h') === 2000` (= `presetKbps('1080p30')`); `kbpsFor('1080p30','l') === 250`
  - `DEFAULT_SCREEN_PRESET === '1080p30'`
  - `lowLayerScaleDown('1080p30') === 4` (1080/270); `lowLayerScaleDown('1440p60') === 1440/270`;
    every scale-down ≥ 1
- `shared/test/contract.test.ts` — `describe('contract surface')`:
  - `ERROR_CODES.length === 31` and the array has no duplicate members
  - imports the barrel `shared/src/index.ts` and round-trips one valid fixture through every
    `api.ts` request/response schema and the `ipc.ts` schemas (this is what pulls `api.ts`/`ipc.ts`
    into the ≥90% coverage set — without it those modules count as 0% and redden the gate)
  - `MeResponse` fixture uses the `user` field (not `profile`) and a `ServerSummary` with
    `adminUserId`/`hasPassword`/`createdAt`/`joinedAt` (no `isAdmin`)

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/shared test:coverage` → exit 0, coverage lines ≥ 90%
- [ ] `pnpm typecheck && pnpm lint && pnpm format:check` → exit 0
- [ ] `node -e "const d=Object.keys(require('./shared/package.json').dependencies);process.exit(d.length===1&&d[0]==='zod'?0:1)"` → exit 0 (zod is the only runtime dep)
- [ ] `grep -c "describe('FR-32" shared/test/layout.test.ts` → ≥ 1

## STOP conditions (beyond global R1)

- Any field/name/value here conflicts with PLAN App-A/B/C/D as you read it → blocker (name both).
  (The extra `at` fields on `sound.updated`/`kicked`/`voice.state`/`rec.state` etc. follow App-A's
  preamble rule "frames that mutate shared state also carry `at`" — that is NOT a conflict even
  where App-A's table shows the payload without `at`.)
- zod 4.4.3 lacks an API this contract needs (e.g. discriminated unions behaving differently than
  documented) → blocker; do not restructure the schemas around it.

## Docs (consult only these)

- https://zod.dev (v4 docs)
- https://vitest.dev/config/
