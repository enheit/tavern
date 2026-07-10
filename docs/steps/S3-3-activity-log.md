# S3.3 — Activity log

- after: S3.2 · unlocks: S3.4, S2.2, S10.1 · FRs: FR-39
- references: PLAN §1.7, §5.2 (activity), §6.1 (activity route), App-A (activity.new, activity.types)

## Goal

A persisted per-server activity log: an append API used by every event producer, an
`activity.new` broadcast for live UIs, and a paginated HTTP read for the Activity tab.

## Preconditions (run these; red = STOP)

- `grep -q "^## S3.2" docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test:ws` → exit 0

## Tasks

1. Create `worker/src/do/activity.ts` (`ActivityModule`, signatures below). Storage: `activity`
   table from S3.1's migration.
2. `append` inserts and returns the entry; the ServerRoom caller broadcasts
   `activity.new { entry }` to all sockets. Types are the App-A closed enum — nothing else
   compiles (`ActivityType` union).
3. `page` mirrors chat pagination exactly: `before?` on id, limit clamped to
   `LIMITS.historyPageSize`, `ORDER BY id DESC`, `hasMore`.
4. DO internal route `GET /internal/activity?before&limit` → `{ entries, hasMore }` (zod
   `ActivityPage` from `@tavern/shared` api.ts — must exist from S0.2, STOP if absent).
5. Worker route `GET /api/servers/:id/activity?before&limit` (`requireMember`) proxying to the DO
   — add to `worker/src/routes/servers.ts`.
6. Wire the two producers that already exist:
   - `/internal/member-join` handler (S3.1) → `append('member.join', userId)`
   - `/internal/kick` handler (S3.1) → `append('member.kick', kickedUserId)`
   (voice/stream/recording producers arrive with S3.4, S8, S9 — their append calls are pinned in
   those steps; this module is complete now.)

## Pinned interfaces & artifacts

Files created: `worker/src/do/activity.ts`, `worker/test/ws/activity.spec.ts`,
`worker/test/activity-http.test.ts`. Modified: `worker/src/do/ServerRoom.ts` (route + producer
wiring), `worker/src/routes/servers.ts`.

```ts
// activity.ts
import type { ActivityType } from '@tavern/shared'   // the closed union, defined once in domain.ts (S0.2)
export class ActivityModule {
  constructor(sql: SqlStorage)
  append(type: ActivityType, userId: string, meta?: Record<string, string>, now?: number): ActivityEntry
  page(input: { before?: number; limit: number }): { entries: ActivityEntry[]; hasMore: boolean }
}
```

`ActivityEntry { id: number; type: ActivityType; userId: string; meta: Record<string, string>;
at: number }` — from `@tavern/shared` domain.ts.

## Tests

- `worker/test/ws/activity.spec.ts` — `describe('FR-39 activity broadcast')`: member join (via
  `/internal/member-join`) → connected member receives `activity.new{type:'member.join'}`; kick →
  `member.kick` entry broadcast to survivors.
- `worker/test/activity-http.test.ts` (default project — no WS needed) —
  `describe('FR-39 activity read')`: seed 55 entries via `runInDurableObject` → page 1 = 50 +
  `hasMore:true`, page 2 via `before` = 5 + `hasMore:false`; response parses with
  `ActivityPage`; non-member request → 403.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker typecheck` → exit 0
- [ ] `pnpm -F @tavern/worker test && pnpm -F @tavern/worker test:ws` → exit 0, 0 failed
- [ ] `pnpm -F @tavern/worker test` → lines ≥80% (default project; the `test` script already runs `--coverage`)
- [ ] `pnpm lint && pnpm format:check` → exit 0
- [ ] `grep -rl "FR-39" worker/test` → ≥2 files

## STOP conditions (beyond global R1)

- Any producer needing a type outside the pinned enum → blocker (the enum is the App-A contract;
  widening it is a plan change).

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/api/sql-storage/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
