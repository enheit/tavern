# S3.2 — Chat: persistence, mentions, history

- after: S3.1 · unlocks: S3.3, S6.1 · FRs: FR-14, FR-15, FR-17
- references: PLAN §1.3, §5.2 (messages), §6.2, App-A (chat.*), App-B (message/history/rate limits)

## Goal

`chat.send` / `chat.history` work end-to-end inside the DO: validated, rate-limited, persisted in
DO SQLite, mentions extracted server-side against the member cache, broadcast as `chat.new`, and
paginated history via `chat.page`.

## Preconditions (run these; red = STOP)

- `grep -q "^## S3.1" docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test:ws` → exit 0

## Tasks

1. Create `worker/src/do/chat.ts` (`ChatModule`, signatures below). Storage: the `messages` table
   from S3.1's migration — no schema change.
2. Validation in `send`: body length 1..2000 (`LIMITS.messageMaxChars`) — violations return
   `error 'bad_message'` (schema-level length is already enforced by `clientMessageSchema`; the
   module re-checks as the trust boundary).
3. Rate limit in `send`: token bucket per userId — capacity `LIMITS.rateChatBurst` (10), refill
   `LIMITS.rateChatPerSec` (5/s), held in a **per-`ChatModule`-instance** field
   `Map<string, {tokens, lastRefillAt}>` (one ChatModule per DO → buckets are per-server; a
   module-scoped Map would leak one user's budget across DOs colocated in an isolate).
   In-memory is pinned: the bucket resets on DO hibernation/eviction, which only ever REFILLS —
   acceptable. Exceeded → `error{code:'rate_limited'}` on that socket only; the socket stays open.
4. Mention extraction (server-side, pinned): run `/@([a-z0-9_]{3,20})/gi` over the body; for each
   capture, case-insensitive match against current `members.username`; store the matching
   `userId`s deduplicated, in first-occurrence order, as the `mentions` JSON column. Non-member
   handles are silently ignored.
5. Persist (`INSERT INTO messages`) with `channel_id = 'main'` (v1 constant, §5.2 FR-13 readiness)
   and `created_at = Date.now()`; broadcast `chat.new` — the
   sender's copy carries the echoed `nonce`, every other socket's copy omits it (two broadcast
   calls: `{toUserId: sender}` with nonce, `{except: senderSockets}` without).
6. `chat.history {beforeId?, limit}` → clamp limit to `LIMITS.historyPageSize` (50); query
   `ORDER BY id DESC` with `id < beforeId` when given; reply `chat.page { messages, hasMore }`
   (messages returned oldest→newest within the page; `hasMore` = a further row exists). Reply
   goes only to the requesting socket.
7. Replace S3.1's `hello.ok` stub: `lastMessageId` now comes from `ChatModule.lastMessageId()`
   (`SELECT MAX(id)`, 0 when empty).
8. Register `chat.send` and `chat.history` in the ServerRoom router map.

## Pinned interfaces & artifacts

Files created: `worker/src/do/chat.ts`, `worker/test/ws/chat.spec.ts`. Modified:
`worker/src/do/ServerRoom.ts` (router entries), `worker/src/do/roomState.ts` (helloSnapshot uses
lastMessageId).

```ts
// chat.ts
export class ChatModule {
  constructor(sql: SqlStorage)
  send(input: { userId: string; body: string; nonce: string; members: Member[]; now: number }):
    { ok: true; message: ChatMessage } | { ok: false; code: 'bad_message' | 'rate_limited' }
  history(input: { beforeId?: number; limit: number }): { messages: ChatMessage[]; hasMore: boolean }
  lastMessageId(): number
  messageCountByUser(): Map<string, number>   // consumed by S3.4 /internal/stats
}
```

`ChatMessage { id: number; userId: string; body: string; mentions: string[]; at: number }` — from
`@tavern/shared` domain.ts. Error code `rate_limited` must exist in `shared/src/errors.ts`
(added by S0.2; if missing → STOP).

## Tests

`worker/test/ws/chat.spec.ts`:

- `describe('FR-14 chat send/receive')`: A sends → B receives `chat.new` without nonce, A receives
  with nonce; 2001-char body → `error bad_message`, nothing broadcast, nothing persisted;
  11 sends in one tick → 11th gets `error rate_limited`, socket still usable afterwards
- `describe('FR-15 mentions')`: `@Bob` matches member `bob` case-insensitively → mentions =
  [bob's userId]; `@ghost` (non-member) → `[]`; `@bob hi @bob @ann` → `[bob, ann]` (deduped,
  ordered); mentioned ids arrive in B's `chat.new`
- `describe('FR-17 history')`: seed 55 messages → `chat.history{}` returns 50 oldest→newest with
  `hasMore:true`; `{beforeId}` returns remaining 5 with `hasMore:false`; `limit: 51` (over WS) →
  `error bad_message` + close 1008 (`clientMessageSchema` rejects >50 at the router before
  ChatModule; the task-6 clamp is trust-boundary defense-in-depth, like the task-2 length
  re-check); rows survive re-read via `runInDurableObject` direct `sql` query (persistence proof);
  `hello.ok.lastMessageId` equals the max seeded id on a fresh connection

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker typecheck` → exit 0
- [ ] `pnpm -F @tavern/worker test && pnpm -F @tavern/worker test:ws` → exit 0, 0 failed
- [ ] `pnpm lint && pnpm format:check` → exit 0
- [ ] `grep -rlE "FR-1[457]" worker/test/ws/chat.spec.ts` → match

## STOP conditions (beyond global R1)

- Any need to alter the `messages` DDL → blocker (schema is pinned in §5.2/S3.1).
- Mention semantics beyond the pinned regex (unicode usernames, display-name mentions) — out of
  scope; do not extend.

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/api/sql-storage/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
