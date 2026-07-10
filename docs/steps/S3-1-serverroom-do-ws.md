# S3.1 — ServerRoom DO: WebSockets, ticket auth, presence

- after: S2.1 · unlocks: S3.2, S2.2 · FRs: FR-45 (+infrastructure for all realtime FRs)
- references: PLAN §2 (A2, A4, A6, A9), §4 (worker/src/do layout), §5.2, §5.4, §6.2, App-A, App-B

## Goal

The per-server Durable Object exists: SQLite schema migrated idempotently, WebSocket connect via
one-time ticket, `hello`/`hello.ok` handshake, presence tracking, member-profile cache fed by
Worker internal routes, and a zod-validated message router that later steps plug domain modules
into.

## Preconditions (run these; red = STOP)

- `grep -q "^## S2.1" docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test` → exit 0
- `pnpm -F @tavern/shared test` → exit 0 (protocol schemas from S0.2 exist)

## Tasks

1. Create `worker/src/do/sql.ts`: `migrate(sql: SqlStorage): void` executing the §5.2 DDL below
   as `CREATE TABLE IF NOT EXISTS` statements, plus one typed row-mapper per table read in this
   step (`rowToMember`). Call `migrate` from the DO constructor inside
   `ctx.blockConcurrencyWhile`.
2. Create `worker/src/do/roomState.ts` (`RoomState` class — tickets, sockets, presence, member
   cache, broadcast, hello snapshot; signatures below).
3. Create `worker/src/do/ServerRoom.ts`: DO class extending `DurableObject<Env>` — WS lifecycle +
   internal-route dispatch + message router ONLY; all state logic lives in modules.
4. Internal HTTP routes on the DO (all require header `X-Tavern-Internal: 1`, else 403; the
   Worker sets it on every stub call — the DO has no other ingress path):
   - `POST /internal/ticket` body `{ userId }` → `200 { ticket }`
   - `POST /internal/member-join` body `{ member: MemberInit, serverMeta: { id: string,
     nickname: string, adminUserId: string } }` → upsert cache, write `serverMeta` to KV `meta`
     (idempotent — overwrite on every join), broadcast `member.joined` → 204 (S2.1 join/create
     passes both fields; S3.3 adds the activity append here)
   - `POST /internal/member-update` body `{ profile: UserProfile }` → upsert cache, broadcast
     `member.update` → 204 (called by S1.3 fan-out)
   - `POST /internal/kick` body `{ userId }` → remove from cache, broadcast `member.left`, close
     that user's sockets with code 4001 → 204 (called by S2.2)
   - `POST /internal/server-updated` body `{ nickname }` → patch the cached `meta.nickname`,
     broadcast `server.updated` → 204 (called by S2.2)
   - `GET /ws?ticket=…` → upgrade (below)
5. Ticket flow: `createTicket(userId)` stores `crypto.randomUUID()` in `ctx.storage` KV
   (`ticket:{uuid}` → `{ userId, expiresAt: now + LIMITS.wsTicketTtlMs }`). On `GET /ws`, consume
   the ticket (delete on read; reject if missing or expired). Invalid ticket → accept the socket,
   then immediately `close(4002, 'ticket')` (a plain 403 gives browsers an opaque error; 4002 lets
   the client re-ticket and retry).
6. Accept via `this.ctx.acceptWebSocket(server)`;
   `ws.serializeAttachment({ userId, connId: crypto.randomUUID(), hello: false })` — ids only,
   16 KB cap. Arm a 5 s `setTimeout`: if `hello` still false → `close(1008, 'hello timeout')`
   (`LIMITS.helloTimeoutMs`; a 5 s pending timer's hibernation cost is negligible).
7. Protocol pings never wake the DO:
   `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}','{"t":"pong"}'))`.
8. `webSocketMessage`: parse with `clientMessageSchema` (from `@tavern/shared`); invalid frame or
   first frame ≠ `hello` → send `error{code:'bad_message'}` + `close(1008)`. On `hello` → mark
   attachment, send `hello.ok` snapshot. Route map for later steps:
   `Record<ClientMessage['t'], handler>` — this step implements `hello` only; unknown-but-valid
   types answer `error{code:'not_implemented'}` (temporary until S3.2/S3.4/S8/S9 fill the map;
   S12.4 verifies none remain).
9. `hello.ok` snapshot (App-A shape, zod-validated OUTBOUND too — §9.8 applies to both
   directions): `self` + `serverMeta` (`{ id, nickname, adminUserId }`, read from the
   `ctx.storage` KV `meta` — written in full by `/internal/member-join`, `nickname` patched by
   `/internal/server-updated`), `members` from cache with live presence, and stubs pinned until
   later steps: `voice: { members: [], sessionStartedAt: null }` (S3.4), `streams: []` (S8),
   `recording: { active: false }` (S9.3), `lastMessageId: 0` (S3.2),
   `costStatus: { usedGB: 0, capGB: LIMITS.egressKillGB, blocked: false }` (S7.1).
10. Presence: `userId → live-socket count` derived from `ctx.getWebSockets()` attachments (no
    in-memory map — hibernation-safe). Broadcast `presence.update` only on 0↔1 transitions. No
    device dedup: multiple connections per user are allowed; presence = count > 0. Close code
    4003 stays reserved/unused in v1.
11. `webSocketClose`/`webSocketError`: recompute presence, broadcast transition if any.
12. Worker routes in `worker/src/routes/wsTicket.ts`:
    - `POST /api/ws-ticket` body `{ serverId }`, `requireMember` middleware (S2.1) → DO
      `/internal/ticket` → `{ ticket }`
    - `GET /api/servers/:id/ws` → forward the upgrade `Request` to the DO stub unchanged except
      added `X-Tavern-Internal: 1` (already matched by S1.1's `run_worker_first: ["/api/*"]`).
13. Wire S2.1's create/join handlers to call `/internal/member-join` (touch-point listed in
    S2.1's `Pinned interfaces`; the route was reserved there).
14. Add the WS vitest project: `worker/vitest.config.ws.ts` (same `cloudflareTest` plugin +
    wrangler config as S1.1's, `include: ['test/ws/**/*.spec.ts']`) and package script
    `"test:ws": "vitest run --config vitest.config.ws.ts --max-workers=1 --no-isolate"`
    (per-file isolated storage does not support DO WebSockets — official known issue). WS-project
    tests are excluded from the coverage gate (shared-storage single-worker runs are serial; the
    default project owns the ≥80% gate).

## Pinned interfaces & artifacts

Files created: `worker/src/do/{ServerRoom,roomState,sql}.ts`, `worker/src/routes/wsTicket.ts`,
`worker/vitest.config.ws.ts`, `worker/test/ws/room.spec.ts`. Modified: `worker/src/index.ts`
(route mount), `worker/src/routes/servers.ts` (member-join calls), `worker/package.json` (script).

```ts
// sql.ts
export function migrate(sql: SqlStorage): void
export function rowToMember(row: Record<string, SqlStorageValue>, presence: Presence): Member

// roomState.ts
export type ConnAttachment = { userId: string; connId: string; hello: boolean }
export class RoomState {
  constructor(ctx: DurableObjectState, env: Env)
  createTicket(userId: string): Promise<string>
  consumeTicket(ticket: string): Promise<string | null>      // userId | null; single-use
  presenceOf(userId: string): Presence                        // 'offline'|'online'|'in-voice'
  upsertMember(m: MemberInit): void
  removeMember(userId: string): void
  listMembers(): Member[]
  socketsOf(userId: string): WebSocket[]
  broadcast(msg: ServerMessage, opts?: { except?: WebSocket | WebSocket[]; toUserId?: string }): void
  // `except` accepts an array so a sender's OTHER sockets are all excluded (chat echo, S3.2)
  helloSnapshot(userId: string): Extract<ServerMessage, { t: 'hello.ok' }>
}
```

`MemberInit`, `Member`, `UserProfile`, `Presence` from `@tavern/shared` (domain.ts);
`clientMessageSchema`, `serverMessageSchema`, `ClientMessage`, `ServerMessage` from
`@tavern/shared` (protocol.ts) — these export names are load-bearing for every later step.

DO SQLite DDL (verbatim §5.2 **plus the member-profile cache table** — the DO must resolve
usernames/colors without D1 access; profiles are pushed via the internal routes above):

```sql
CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY, username TEXT NOT NULL,
  display_name TEXT NOT NULL, color TEXT NOT NULL, avatar_key TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL);
-- …followed by the nine §5.2 tables verbatim: messages, activity, sounds, sound_plays,
-- recordings, voice_sessions, stat_stream_seconds, stat_watch_seconds, egress_log.
-- Per updated §5.2, `messages` and `voice_sessions` each carry
-- `channel_id TEXT NOT NULL DEFAULT 'main'` (FR-13 readiness; v1 always writes 'main').
```

## Tests

`worker/test/ws/room.spec.ts` — `describe('FR-45 presence & room lifecycle')`:

- ticket is single-use: second `GET /ws` with the same ticket → close code 4002
- expired ticket rejected: seed `ticket:{uuid}` with past `expiresAt` via `runInDurableObject`,
  connect → 4002
- hello handshake: connect with valid ticket → send `hello{proto:1}` → `hello.ok` parses with
  `serverMessageSchema`; snapshot has `self`, seeded member in `members`, pinned stubs
- first frame ≠ hello → `error{code:'bad_message'}` then close 1008
- malformed JSON frame after hello → close 1008
- presence transitions: 2 sockets same user → exactly one `presence.update{online}` observed by a
  second member; closing one socket → none; closing both → `presence.update{offline}`
- member cache: `/internal/member-update` → `member.update` broadcast received; kick →
  `member.left` + socket closed 4001
- internal-route guard: DO `fetch('/internal/ticket')` without `X-Tavern-Internal` → 403
  (via `runInDurableObject`)
- hibernation registry: after N accepts, `runInDurableObject` asserts
  `ctx.getWebSockets().length === N` and `deserializeAttachment()` round-trips `ConnAttachment`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker typecheck` → exit 0
- [ ] `pnpm -F @tavern/worker test` → exit 0 (pre-existing suites untouched)
- [ ] `pnpm -F @tavern/worker test:ws` → exit 0, 0 failed
- [ ] `pnpm lint && pnpm format:check` → exit 0
- [ ] `grep -rl "FR-45" worker/test/ws` → ≥1 file

## STOP conditions (beyond global R1)

- `--no-isolate`/`--max-workers=1` rejected by vitest 4.1.10 or the pool errors anyway → blocker
  (quote the error; do not restructure tests to dodge it).
- `setWebSocketAutoResponse` or `WebSocketRequestResponsePair` missing at the pinned
  compatibility date → blocker.
- Any needed protocol/domain export missing from `@tavern/shared` → blocker naming the export
  (do NOT add schemas to the worker package).

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/api/base/
- https://developers.cloudflare.com/durable-objects/api/sql-storage/
- https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
