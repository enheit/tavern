# S9.1 — Soundboard: upload, trim, manage

- after: S3.1 (ServerRoom DO + §5.2 DDL + internal-route dispatch), S5.2 (server UI, membership routes, `GET /api/media/*`)
- unlocks: S9.2
- FRs: FR-34, FR-35, FR-37 (list ordering only)
- references: PLAN §1.6, §3.4 (music-metadata), §3.7 (contingency), §5.2, §5.3, §6.1, §7.4, §7.6, §App-B

## Goal

Members upload mp3 clips (≤5 min, ≤10 MB) to a per-server soundboard, non-destructively trim them
(metadata only — no re-encode), rename/delete their own (admin: any). Playback is S9.2.

## Preconditions (run these; red = STOP)

- `grep -q "^## S3.1" docs/progress.md && grep -q "^## S5.2" docs/progress.md` → both present
- `pnpm -F @tavern/worker test` → exit 0
- `grep -n "sound.updated" shared/src/protocol.ts` → non-empty
- `grep -n "soundMaxBytes" shared/src/limits.ts` → non-empty
- `grep -rn "api/media" worker/src/routes/` → media streaming route exists
- `ffmpeg -version` → present (task 7 generates beep.mp3)

## Tasks

1. Add `worker/src/do/soundboard.ts`: DO-side sound metadata module over the `sounds` +
   `sound_plays` tables (§5.2 DDL already applied by S3.1's `sql.ts`).
2. Add `worker/src/routes/sounds.ts` implementing the four routes below; wire into `index.ts`.
   All routes require membership (S2.1 middleware); PATCH/DELETE require uploader-or-admin —
   the Worker resolves admin from D1 (`servers.admin_user_id`) and forwards `X-Tavern-Admin: 1`
   on the internal DO call.
3. Validation chain for POST (in this exact order, fail-fast):
   a. `Content-Length` ≤ `LIMITS.soundMaxBytes` → else 413 `payload_too_large`.
   b. Magic bytes: first 3 bytes `ID3` OR first 2 bytes match MPEG sync (`0xFF`, second byte
      `& 0xE0 === 0xE0`) → else 415 `unsupported_media`.
   c. `music-metadata` `parseBuffer(bytes, undefined, { duration: true })` → `durationMs` =
      `Math.round(format.duration * 1000)` (float seconds → whole ms — matches the TrimDialog's
      `Math.round` convention; the schema requires `durationMs: z.int()`); require
      ≤ `LIMITS.soundMaxDurationMs` → else 422 `sound_too_long`.
   d. On success: `MEDIA.put('sounds/{serverId}/{soundId}.mp3', bytes)` then DO
      `/internal/sounds/create`. `soundId = crypto.randomUUID()`.
   **§3.7 contingency (pre-authorized, not a STOP):** if `music-metadata` fails under workerd
   (import error or runtime crash in the S9.1 smoke test), set `SOUND_VALIDATION_MODE=basic`
   (module-level const in `sounds.ts`): skip (c), trust the request's `durationMs` field
   (client-computed via `decodeAudioData`, still bounds-checked ≤ 300_000). The multipart request
   shape carries `durationMs` in BOTH modes so the flip is a flag, not a redesign. Record in
   progress.md.
4. Rate limit (DO-enforced — no shared upload middleware exists): the `/internal/sounds/create`
   handler keeps a per-user in-memory sliding window and rejects with `rate_limited` (→ 429) once
   the user has created `LIMITS.rateUploadsPerHour` (10) sounds within 3_600_000 ms (same in-memory
   token style as S9.2's sound-play bucket). On a `rate_limited` reject the Worker route deletes the
   R2 object it just put in step 3d, so no orphan remains.
5. Broadcast `sound.updated { at }` from the DO after create/patch/delete (clients refetch, S9.2).
6. Add `app/src/features/soundboard/`: `SoundboardPanel.tsx` (bottom-right region per §7.6:
   scrollable grid of sound buttons — name + playCount badge; header has upload button and the
   volume slider slot filled in S9.2; per-sound context menu with Edit/Delete visible to
   uploader/admin only), `UploadDialog.tsx` (file input `accept="audio/mpeg"`; client-side
   `decodeAudioData` duration check with i18n error `soundboard.upload.tooLong`; name field,
   1..32 chars, RHF + shared zod), `TrimDialog.tsx` (see pinned wavesurfer usage), plus
   `useSounds.ts` (TanStack Query over GET, invalidated on `sound.updated`).
7. Commit the e2e fixture `e2e/fixtures/beep.mp3` (1 s, 440 Hz sine, public-domain,
   generated once with `ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -codec:a libmp3lame
   -qscale:a 9 beep.mp3`) + `e2e/fixtures/README.md` documenting provenance and the
   command. The fixture is committed, never generated at test time.

## Pinned interfaces & artifacts

Files created: `worker/src/do/soundboard.ts`, `worker/src/routes/sounds.ts`,
`app/src/features/soundboard/{SoundboardPanel,UploadDialog,TrimDialog}.tsx`,
`app/src/features/soundboard/useSounds.ts`, `e2e/fixtures/beep.mp3`,
`e2e/fixtures/README.md`, `worker/test/sounds.spec.ts`,
`app/test/soundboard/UploadDialog.test.tsx`, `app/test/soundboard/TrimDialog.test.tsx`.
Modified: `worker/src/index.ts`, `worker/src/do/ServerRoom.ts` (internal sounds routes +
`sound.updated` broadcast). `Sound` / `SoundsResponse` / `PatchSoundRequest` already live in
`shared/src/api.ts` from S0.2 — reuse verbatim, do NOT touch that file.

Public routes (§6.1):

| Route | Auth | Request | Response |
|---|---|---|---|
| `GET /api/servers/:id/sounds` | member | — | `SoundsResponse { sounds: Sound[] }` ordered `playCount DESC, createdAt DESC` |
| `POST /api/servers/:id/sounds` | member | multipart: `file` (mp3 bytes), `name` (1..32), `durationMs` (int, client-measured) | `201 { sound: Sound }` |
| `PATCH /api/servers/:id/sounds/:soundId` | uploader/admin | `{ name?, trimStartMs?, trimEndMs? }` (`PatchSoundRequest`) | `{ sound: Sound }` |
| `DELETE /api/servers/:id/sounds/:soundId` | uploader/admin | — | `204` (R2 object deleted + row deleted) |

Shared schemas: use S0.2's `Sound` / `SoundsResponse { sounds: Sound[] }` / `PatchSoundRequest`
from `shared/src/api.ts` verbatim — this step does NOT redefine them. For reference, `Sound` =
`{ id: uuid, name (1..32), uploaderId, durationMs: int, trimStartMs: int, trimEndMs: int,
createdAt: int, playCount: int }`.

Internal DO routes (`worker/src/do/ServerRoom.ts` dispatch, all under S3.1's `X-Tavern-Internal: 1`
guard; the Worker resolves admin from D1 and forwards `X-Tavern-Admin: 1` on patch/delete):

| Internal route | Body | Response | Side-effect |
|---|---|---|---|
| `GET  /internal/sounds` | — | `{ sounds: Sound[] }` | — |
| `POST /internal/sounds/create` | `{ sound: Omit<Sound,'playCount'> }` | `{ sound: Sound }` | broadcast `sound.updated { at }` |
| `POST /internal/sounds/patch` | `{ soundId, patch, actor: { userId, isAdmin } }` | `{ sound: Sound }` | broadcast `sound.updated { at }` |
| `POST /internal/sounds/delete` | `{ soundId, actor: { userId, isAdmin } }` | `{ r2Key: string }` | broadcast `sound.updated { at }` |

Trim invariants (enforced in DO on create + PATCH; violation → 422 `bad_trim`):
`0 ≤ trimStartMs < trimEndMs ≤ durationMs` AND `trimEndMs − trimStartMs ≥ LIMITS.soundMinTrimMs`.
On create: `trimStartMs = 0`, `trimEndMs = durationMs`.

DO module signatures (`worker/src/do/soundboard.ts`):

```ts
export function listSounds(sql: SqlStorage): Sound[]
export function createSound(sql: SqlStorage, s: Omit<Sound,'playCount'>): Sound
export function patchSound(sql: SqlStorage, soundId: string, patch: SoundPatch, actor: Actor): Sound  // throws TavernError('bad_trim'|'forbidden'|'not_found')
export function deleteSound(sql: SqlStorage, soundId: string, actor: Actor): { r2Key: string }
// Actor = { userId: string; isAdmin: boolean }
```

Wavesurfer pins (TrimDialog): imports `WaveSurfer from 'wavesurfer.js'` and
`RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'` (7.12.10). ONE region,
`drag: true, resize: true`, bounded to `[0, duration]`, `color: 'rgba(99, 102, 241, 0.25)'`
(plugin option — Shadow DOM, external CSS will not work). Preview = `wavesurfer.play(region.start,
region.end)`. Save → `PATCH` with `Math.round(region.start*1000)` / `Math.round(region.end*1000)`.
Audio source = authed fetch of the mp3 → object URL (wavesurfer `load(url)`).

Error codes used (must already exist in `shared/src/errors.ts` — a missing one is S0.2 drift, STOP):
`payload_too_large`, `unsupported_media`, `sound_too_long`, `bad_trim`, `forbidden`, `not_found`,
`rate_limited`.

## Tests

`worker/test/sounds.spec.ts` — `describe('FR-34 soundboard upload')`:
1. `rejects file over soundMaxBytes with 413 payload_too_large`
2. `rejects bad magic bytes with 415 unsupported_media`
3. `rejects duration over soundMaxDurationMs with 422 sound_too_long`
4. `accepts valid mp3: 201, R2 object exists, row has trimEnd=durationMs, sound.updated broadcast`
- `describe('FR-35 trim rules')`: 5. `rejects trimStart < 0`, 6. `rejects trimEnd > duration`,
  7. `rejects window smaller than soundMinTrimMs` (all 422 `bad_trim`)
- `describe('FR-35 permissions')`: `uploader can PATCH`, `admin can PATCH`, `other member gets 403`,
  `DELETE removes R2 object and row`
- `describe('FR-37 list ordering')`: `orders by playCount desc then createdAt desc` (seed
  `sound_plays` directly via `runInDurableObject`)

`app/test/soundboard/UploadDialog.test.tsx` — `describe('FR-34 upload dialog')`:
`rejects a clip longer than 5 minutes before uploading` (stub the decode seam to report 360 s —
no big fixture), `submits name + durationMs for a valid file`, `name over 32 chars shows inline error`.

`app/test/soundboard/TrimDialog.test.tsx` — `describe('FR-35 trim dialog')`:
`maps region seconds to whole ms on save`, `save disabled when window < soundMinTrimMs`
(wavesurfer mocked behind a factory seam).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker test` → exit 0, all suites green
- [ ] `pnpm -F @tavern/app test` → exit 0
- [ ] `pnpm typecheck && pnpm lint` → exit 0
- [ ] `grep -rl "FR-34\|FR-35" worker/test app/test | wc -l` → ≥ 3
- [ ] `test -f e2e/fixtures/beep.mp3` → exit 0
- [ ] progress.md entry states whether `SOUND_VALIDATION_MODE` is `full` or `basic` (with the
      failing output if basic)

## STOP conditions (beyond global R1)

- wavesurfer 7.12.10 regions API does not match the pinned imports/options.
- The `sounds` table DDL in the repo differs from §5.2.
- `music-metadata` failure mode is anything OTHER than the workerd incompatibility covered by §3.7
  (e.g. wrong durations on valid files).

## Docs (consult only these)

- https://wavesurfer.xyz/plugins/regions
- https://github.com/Borewit/music-metadata (parseBuffer, ESM entry points)
- https://developers.cloudflare.com/r2/objects/upload-objects/
- https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData
