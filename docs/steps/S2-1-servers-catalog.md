# S2.1 — Servers: create / join / list / membership

- after: S1.3
- unlocks: S3.1, S5.2  *(S2.2 needs S3.1+S3.3 too, per PLAN §12 — not unlocked by S2.1 alone)*
- FRs: FR-08, FR-09, FR-13, FR-41 (persistence); FR-03, FR-43 (fan-out/boot wiring only)
- references: PLAN §5.1 (DDL), §6.1, App-B

## Goal

The global server catalog in D1: create a server (creator = admin, default channels seeded), join
by nickname+password, list memberships, member guard middleware. Also completes three S1.3 stubs
(`/api/me` servers array; profile-change fan-out; `/api/media/*` membership check).

## Preconditions (run these; red = STOP)

- `grep -q "^## S1.3" docs/progress.md` → exit 0
- `pnpm --filter @tavern/worker test` → exit 0

## Tasks (numbered, imperative, zero alternatives)

1. Create migration `worker/migrations/0002_servers.sql` with the `servers`, `memberships`,
   `channels` DDL from PLAN §5.1 VERBATIM (keep the `REFERENCES` clauses as written there — they
   are documentation; D1 does not enforce them by default). ONE intentional deviation from
   verbatim: PLAN §5.1's `password_hash` column comment reads `scrypt via better-auth's hasher` —
   that comment is STALE. Server passwords use WebCrypto PBKDF2 (task 2), NOT better-auth's hasher
   (better-auth hashes only *user* passwords). Write the column comment as
   `-- NULL = open server; PBKDF2-SHA256, see worker/src/lib/passwords.ts`. Do NOT STOP on the
   PLAN-vs-step mismatch — this note is the resolution. Apply local + remote.
2. Create `worker/src/lib/passwords.ts` (server passwords only — user passwords are better-auth's):

   ```ts
   export async function hashServerPassword(plain: string): Promise<string>  // 'pbkdf2$100000$<saltB64>$<hashB64>'
   export async function verifyServerPassword(plain: string, stored: string): Promise<boolean>
   ```

   Pinned: WebCrypto PBKDF2-SHA256, 100_000 iterations, 16-byte random salt, 32-byte derived key,
   comparison via `crypto.subtle.timingSafeEqual`. No new dependencies.
3. Create `worker/src/routes/servers.ts`:
   - `POST /api/servers` (requireAuth, zodJson `CreateServerRequest` = `{ nickname:
     serverNickname regex App-B, password?: string 4..128 }`):
     nickname uniqueness (NOCASE) → `409 nickname_taken`; membership count of creator ≥
     `LIMITS.maxServersPerUser` → `403 server_cap`; insert server (id = `crypto.randomUUID()`,
     `admin_user_id` = caller, `password_hash` = task-2 hash or NULL), seed TWO channels
     (voice "Voice", text "General", ids `crypto.randomUUID()`), insert creator membership —
     one `DB.batch`. Response `201 ServerSummary`.
   - `POST /api/servers/join` (requireAuth, zodJson `JoinServerRequest` = `{ nickname, password?
     }`): lookup NOCASE → `404 not_found`; if `password_hash` set, verify → `403 wrong_password`;
     already a member → `200` existing summary (idempotent — checked BEFORE the fullness guard so a
     rejoin is never blocked); per-user `server_cap` check; server member count ≥
     `LIMITS.maxMembersPerServer` → `403 server_full` (FR-09 — enforces the max-members cap);
     insert membership; notify DO `member.joined` via `ctx.waitUntil` (stub tolerated until S3.1 —
     catch → `console.error`). Response `200 ServerSummary`.
   - `GET /api/servers/:id/members` (requireMember) → `{ members: UserProfile[] }` joined from
     memberships × user (presence comes from the DO via WS — NOT here).
4. Add to `worker/src/middleware.ts`:

   ```ts
   export const requireMember: MiddlewareHandler // reads :id param; 404 not_found if server absent; 403 not_member if no membership; sets c.var.serverId
   ```

5. Complete the three pinned S1.3 stubs:
   - `/api/me`: replace `servers: []` with the memberships JOIN → `ServerSummary[]`
     (`{ id, nickname, adminUserId, hasPassword, createdAt, joinedAt }` — `hasPassword` =
     `password_hash IS NOT NULL`, never the hash).
   - Wire `notifyJoinedServers(env, userId, { t: 'member.update', profile })` into
     `PATCH /api/me/profile` and `POST /api/me/avatar` via `ctx.waitUntil`.
   - `/api/media/*`: add the membership check for `sounds/{serverId}/…` and
     `recordings/{serverId}/…` prefixes (serverId = second path segment).
6. Write tests, run DoD, append progress entry.

## Pinned interfaces & artifacts

- Files created: `worker/migrations/0002_servers.sql`, `worker/src/lib/passwords.ts`,
  `worker/src/routes/servers.ts`, `worker/test/servers.test.ts`.
- Modified: `worker/src/middleware.ts`, `worker/src/routes/me.ts`, `worker/src/routes/media.ts`,
  `worker/src/index.ts`.
- Shared schemas used: `CreateServerRequest`, `JoinServerRequest`, `ServerSummary`.
- ErrorCodes used: `nickname_taken`, `wrong_password`, `server_cap`, `server_full`, `bad_request`,
  `not_found`, `not_member` (all must already exist in `shared/src/errors.ts` — a missing one is
  S0.2 drift, STOP).
- Dependents rely on: `requireMember` + `c.var.serverId`; ServerSummary field set;
  channel seed names `Voice`/`General` and `kind` values `voice`/`text` (FR-13).

## Tests

`worker/test/servers.test.ts` (pool-workers):

- `describe('FR-08 create server')`:
  - `creates server, caller is admin, membership exists, 201 ServerSummary`
  - `seeds exactly one voice + one text channel (FR-13)`
  - `duplicate nickname case-insensitive → 409 nickname_taken`
  - `nickname failing App-B regex → 400 bad_request`
  - `password stored as pbkdf2$100000$… (never plaintext), hasPassword=true in response`
- `describe('FR-09 join server')`:
  - `join open server by nickname (case-insensitive) succeeds`
  - `join password server: wrong → 403 wrong_password; right → 200`
  - `re-join is idempotent → 200 same summary, single membership row`
  - `unknown nickname → 404 not_found`
  - `21st server → 403 server_cap`
  - `join when server already has LIMITS.maxMembersPerServer members → 403 server_full` (seed the
    server to the cap first; an existing member re-joining still gets 200, not server_full)
- `describe('FR-13 channels schema')`: `kind CHECK constraint rejects other values`
- `describe('FR-43 boot integration')`: `/api/me lists joined servers with hasPassword flag and no password_hash`
- `describe('membership guard')`: `GET /api/servers/:id/members → 403 not_member for outsider, 200 profiles for member`
- `describe('FR-03 fan-out wiring')`: `PATCH profile calls notifyJoinedServers once per joined server (spy on DO stub fetch)`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/worker test` → all green, coverage lines ≥80%, exit 0
- [ ] `pnpm --filter @tavern/worker run migrate:local` → exit 0
- [ ] `pnpm -w lint && pnpm -w typecheck` → exit 0

## STOP conditions (beyond global R1)

- `crypto.subtle.timingSafeEqual` unavailable in workerd (runtime drift) — do not substitute a
  JS `===` compare.
- Any §5.1 DDL fails to apply on D1 as written.

## Docs (consult only these)

- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/d1/worker-api/d1-database/ (batch)
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits (PBKDF2)
