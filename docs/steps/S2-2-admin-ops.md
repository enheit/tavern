# S2.2 — Admin ops: rename, password change, kick

- after: S2.1, S3.1, S3.3  *(refines PLAN §12's "[after S3.1]": the kick activity entry uses
  S3.3's `appendActivity`; S3.3 is on the same track, no cycle)*
- unlocks: S10.3
- FRs: FR-10, FR-11, FR-12
- references: PLAN §5.1, §6.1, App-A (`server.updated`, `kicked`, close code 4001,
  activity type `member.kick`)

## Goal

Admin-only server management: rename (unique, id stable), set/clear password, kick a member —
kick removes the D1 membership AND force-closes the member's live sockets with a `kicked` frame.

## Preconditions (run these; red = STOP)

- `grep -q "^## S2.1" docs/progress.md && grep -q "^## S3.1" docs/progress.md && grep -q "^## S3.3" docs/progress.md` → exit 0
- `pnpm --filter @tavern/worker test` → exit 0
- `pnpm --filter @tavern/worker run test:ws` → exit 0 (script exists from S3.1)

## Tasks (numbered, imperative, zero alternatives)

1. Add to `worker/src/middleware.ts`:

   ```ts
   export const requireAdmin: MiddlewareHandler // runs after requireMember semantics; 403 not_admin unless servers.admin_user_id === c.var.userId
   ```

2. Extend `worker/src/routes/servers.ts`:
   - `PATCH /api/servers/:id` (requireAdmin, zodJson `PatchServerRequest` =
     `{ nickname?: serverNickname regex, password?: string(4..128) | null }`; empty object →
     `400 bad_request`):
     - `nickname`: uniqueness NOCASE excluding self → `409 nickname_taken`; on success update D1
       and POST `/internal/server-updated { nickname }` to the DO stub (DO broadcasts
       `server.updated` — task 3). `id` never changes (FR-12).
     - `password`: string → store task-S2.1 hash (FR-10); explicit `null` → set `password_hash`
       NULL (open server). Existing members are untouched.
     - Response `200 ServerSummary`.
   - `DELETE /api/servers/:id/members/:userId` (requireAdmin):
     - `:userId === caller` → `400 bad_request` (admin cannot kick self; ownership transfer is a
       non-goal).
     - target has no membership → `404 not_found`.
     - Order pinned: (1) DELETE membership row in D1, (2) POST `/internal/kick { userId }` to the
       DO — so a racing rejoin re-checks the password. Response `204`.
3. MODIFY the two internal routes S3.1 already created in `worker/src/do/ServerRoom.ts` (S3.1
   built them returning `204` with a minimal body; this step changes their responses to `200` with
   the JSON bodies below and adds the admin-op side effects). Do NOT add new routes — refine these:
   - `POST /internal/server-updated` body `{ nickname }` → update the DO's cached
     `serverMeta.nickname`, then broadcast `server.updated { nickname }` to all sockets. Response
     changes from S3.1's `204` to `200 { ok: true }`.
   - `POST /internal/kick` — body pinned exactly once as `{ userId, by }` (`by` = the acting
     admin's userId). Behavior, in order: to every socket of `userId` send `kicked {}` then
     `close(4001, 'kicked')`; remove `userId` from the members cache and broadcast
     `member.left { userId }`; broadcast `presence.update { userId, presence: 'offline' }` (the
     kicked user is now gone — this is the frame the live-eviction test asserts remaining members
     receive); append activity via S3.3's
     `appendActivity(sql, { type: 'member.kick', userId, meta: { by } })` and broadcast
     `activity.new`. Response changes from S3.1's `204` to `200 { closed: <n> }` (`n` = sockets closed).
4. Write tests, run DoD, append progress entry.

## Pinned interfaces & artifacts

- Modified: `worker/src/middleware.ts`, `worker/src/routes/servers.ts`,
  `worker/src/do/ServerRoom.ts` (+ its internal router only — no protocol changes).
- New tests: `worker/test/admin.test.ts`, `worker/test/ws/kick.spec.ts`.
- Shared schemas used: `PatchServerRequest`; App-A frames `server.updated`, `kicked`,
  `activity.new`.
- ErrorCodes used: `not_admin`, `nickname_taken`, `bad_request`, `not_found`.
- Dependents rely on: `requireAdmin` export; internal routes `/internal/server-updated`,
  `/internal/kick` with the exact bodies above; close code 4001.

## Tests

`worker/test/admin.test.ts` (pool-workers, HTTP only):

- `describe('FR-12 rename')`:
  - `admin renames; GET /api/me shows new nickname; server id unchanged`
  - `rename to another server's nickname (case-insensitive) → 409 nickname_taken`
  - `non-admin member → 403 not_admin; outsider → 403 not_member`
- `describe('FR-10 password change')`:
  - `set password: next join requires it (wrong → 403 wrong_password)`
  - `clear password with null: join succeeds with no password`
  - `existing member unaffected (their /api/me still lists the server)`
- `describe('FR-11 kick — catalog side')`:
  - `membership row deleted; kicked user's /api/me no longer lists the server`
  - `rejoin after kick requires the current password`
  - `kick self → 400 bad_request; kick non-member → 404 not_found`

`worker/test/ws/kick.spec.ts` (WS project; runs via `test:ws` = `--max-workers=1 --no-isolate`
per PLAN §10):

- `describe('FR-11 kick — live eviction')`:
  - `connected member receives kicked frame then close code 4001`
  - `remaining member receives activity.new (member.kick) and presence.update`
  - `DO responds { closed: 2 } when the user had two sockets`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/worker test` → all green, coverage lines ≥80%, exit 0
- [ ] `pnpm --filter @tavern/worker run test:ws` → all green, exit 0
- [ ] `pnpm -w lint && pnpm -w typecheck` → exit 0

## STOP conditions (beyond global R1)

- S3.1's internal-router or broadcast helpers don't expose what task 3 needs (seam drift between
  step files) — blocker naming the exact missing export, do not restructure the DO.

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/api/websockets/
- https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/ (WS + DO isolation)
