# S1.3 — Profile, settings, avatar endpoints

- after: S1.2
- unlocks: S2.1, S5.1
- FRs: FR-03, FR-04, FR-05, FR-06 (persistence), FR-07 (persistence), FR-43 (boot call)
- references: PLAN §5.1, §5.3, §6.1, App-B

## Goal

The account surface: `/api/me` (the single boot call), profile edits (displayName, color,
username), avatar upload to R2, and cross-device user settings. Live propagation to servers is
prepared as a helper but wired in S2.1 (no servers exist yet).

## Preconditions (run these; red = STOP)

- `grep -q "^## S1.2" docs/progress.md` → exit 0
- `pnpm --filter @tavern/worker test` → exit 0

## Tasks (numbered, imperative, zero alternatives)

1. Create migration `worker/migrations/0001_settings.sql` with the `user_settings` DDL from PLAN
   §5.1 verbatim, WITHOUT the `REFERENCES user(id)` clause (pinned: cross-step independence; D1
   does not enforce FKs by default anyway — note this in the migration header comment). Apply
   local + remote via the S1.1 scripts.
2. Create `worker/src/routes/me.ts` with:
   - `GET /api/me` (requireAuth) → `MeResponse` (schema in `@tavern/shared` `api.ts`):
     `{ user: UserProfile, settings: UserSettings, servers: ServerSummary[] }`.
     `user` = `{ userId, username, displayName, color, avatarKey }` read from the auth user row.
     `settings` = the `user_settings` row if present, else the §5.1 DDL defaults (notifyAll true,
     notifyMentions true, locale `en`, theme `system`) WITHOUT inserting (first PUT creates the
     row). `servers` = `[]` — pinned stub; S2.1 replaces it with the
     memberships JOIN (documented there). NO email field, ever.
   - `PATCH /api/me/profile` (requireAuth, zodJson) body `PatchProfileRequest`:
     `{ displayName? (1..32), color? (/^#[0-9a-f]{6}$/), username? (App-B regex) }`; reject empty
     object with `400 bad_request`. `displayName`/`color` update via `auth.api.updateUser`.
     `username` change: single D1 batch that updates `username`, `displayUsername` (same value —
     usernames are lowercase-only by regex) and the synthetic `email`
     (`${newUsername}@users.tavern.invalid`) together; uniqueness violation → `409
     username_taken`. Response: the updated `UserProfile`.
   - `POST /api/me/avatar` (requireAuth): raw body, `Content-Type: image/webp` required.
     Reject `content-length > LIMITS.avatarMaxBytes` → `413 payload_too_large`. Read bytes, check
     magic: bytes 0–3 = `RIFF` AND bytes 8–11 = `WEBP`, else `415 unsupported_media`.
     `env.MEDIA.put('avatars/' + userId + '.webp', bytes, { httpMetadata: { contentType:
     'image/webp' } })`; set `avatarKey` on the user; return `{ avatarKey }`.
   - `GET /api/me/settings` / `PUT /api/me/settings` (requireAuth, zodJson `UserSettings`):
     upsert the full row (all four fields required on PUT — no partials).
3. Create `worker/src/lib/fanout.ts` (also declares the internal-message type it carries — it
   exists nowhere else in the plan, so define it here):

   ```ts
   export type ServerInternalMsg = { t: 'member.update'; profile: UserProfile };
   export async function notifyJoinedServers(env: Env, userId: string, msg: ServerInternalMsg): Promise<void>
   ```

   Reads the user's `memberships` rows and POSTs `msg` to each server's DO stub at
   `/internal/member-update`. Pinned: S1.3 only CREATES this helper + its unit seam — it is NOT
   called from any route yet (memberships table does not exist until S2.1; S2.1 wires the call
   into `PATCH /api/me/profile` and avatar upload). `/internal/*` paths are reachable only via DO
   stubs — the Hono app must not route them.
4. Create `worker/src/routes/media.ts`: `GET /api/media/*` (requireAuth) — key = path remainder;
   `avatars/*` readable by any authed user; all other prefixes return `403 not_member` for now
   (S2.1 adds the membership check; pinned here so the route exists once). Stream from R2 with
   `Content-Type`, `ETag`, `Cache-Control: private, max-age=86400`; missing key → `404 not_found`.
5. Register routes in `worker/src/index.ts`. Write tests, run DoD, append progress entry.

## Pinned interfaces & artifacts

- Files created: `worker/migrations/0001_settings.sql`, `worker/src/routes/me.ts`,
  `worker/src/routes/media.ts`, `worker/src/lib/fanout.ts`, `worker/test/me.test.ts`.
- Modified: `worker/src/index.ts`.
- Shared schemas used (must exist in `@tavern/shared` per S0.2): `MeResponse` (`{ user: UserProfile,
  settings: UserSettings, servers: ServerSummary[] }`), `PatchProfileRequest`, `UserSettings`
  (`{ notifyAll: boolean, notifyMentions: boolean, locale: 'en'|'uk', theme:
  'light'|'dark'|'system' }`), `UserProfile`, `ServerSummary`.
- ErrorCodes used: `unauthorized`, `bad_request`, `username_taken`, `payload_too_large`,
  `unsupported_media`, `not_found`, `not_member`.
- R2 key scheme is LAW: `avatars/{userId}.webp` (PLAN §5.3).

## Tests

`worker/test/me.test.ts` (pool-workers):

- `describe('FR-43 boot call /api/me')`:
  - `returns user + default settings + empty servers for a fresh account`
  - `response parses with shared MeResponse schema (shape lock)`
  - `contains no email key anywhere (deep scan)`
- `describe('FR-03 display name & username')`:
  - `updates displayName within 1..32`
  - `rejects displayName of 0 and 33 chars → bad_request`
  - `username change updates login: old username fails, new one signs in`
  - `username change to an existing name → 409 username_taken`
- `describe('FR-04 color')`: `accepts #a1b2c3` / `rejects #zzz, red, #A1B2C3G → bad_request`
- `describe('FR-05 avatar')`:
  - `valid webp bytes → 200, avatarKey set, R2 object exists with contentType image/webp`
  - `png magic bytes → 415 unsupported_media`
  - `content-length over LIMITS.avatarMaxBytes → 413 payload_too_large`
  - `GET /api/media/avatars/{id}.webp streams bytes with ETag + Cache-Control`
- `describe('FR-06/FR-07 settings')`:
  - `GET before any PUT returns defaults (notifyAll on, mentions on, en, system) without creating a row`
  - `PUT then GET round-trips all four fields`
  - `PUT with partial body → 400 bad_request`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/worker test` → all green, coverage lines ≥80%, exit 0
- [ ] `pnpm --filter @tavern/worker run migrate:local` → exit 0 (idempotent re-run)
- [ ] `pnpm -w lint && pnpm -w typecheck` → exit 0

## STOP conditions (beyond global R1)

- `auth.api.updateUser` cannot update the username/email fields (plugin API drift) — do not fall
  back to raw D1 writes on auth tables without a blocker.
- Any test requires loosening a shared schema (S0.2 owns them).

## Docs (consult only these)

- https://developers.cloudflare.com/r2/objects/upload-objects/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://www.better-auth.com/docs/concepts/users-accounts
