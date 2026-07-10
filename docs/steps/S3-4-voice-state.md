# S3.4 — Voice state, session timer, alarm, stats accumulators

- after: S3.3 · unlocks: S7.1 · FRs: FR-18 (server side), FR-24, FR-26 (relay), FR-40 (accumulators)
- references: PLAN §1.4, §5.2 (voice_sessions, stat_*), §5.4 (VoiceState/VoiceMember), §6.1 (stats
  route), §8 (G5 tick slot), App-A (voice.*), App-B (emptyVoiceCloseMs)

## Goal

The DO owns voice-channel truth: join/leave with full-snapshot broadcasts, self mute/deafen flag
relay, the session timer, a single multiplexed idempotent alarm that reconciles ghosts and
flushes stat accumulators, and the server-authoritative watch/stream stats plumbing that S8.4
will feed.

## Preconditions (run these; red = STOP)

- `grep -q "^## S3.3" docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test:ws` → exit 0

## Tasks

1. Extend `worker/src/do/roomState.ts` with the voice section (signatures below). Voice state
   persists in `ctx.storage` KV key `voice` as `{ members: VoiceMember[], sessionStartedAt:
   number | null }` — hibernation-safe; the `voice_sessions` SQL table records history rows.
2. `voice.join` (idempotent — a second join from the same user returns the current snapshot):
   append `{ userId, muted:false, deafened:false }`; if first member → `INSERT INTO
   voice_sessions(channel_id, started_at) VALUES ('main', …)` (v1 constant, §5.2 FR-13
   readiness), set `sessionStartedAt`; `append('voice.join', userId)` activity +
   `activity.new`; broadcast `voice.state` full snapshot to ALL sockets (FR-24: non-voice members
   see the timer); ensure alarm armed (task 5).
3. `voice.leave` (and implicit leave when a user's LAST socket closes — hook `webSocketClose`):
   remove member; activity `voice.leave`; if now empty → `UPDATE voice_sessions SET ended_at`,
   `sessionStartedAt = null`, and close any open stream/watch intervals for that user via
   `StatsModule` (task 4); broadcast snapshot.
   One-voice-at-a-time (FR-18) is CLIENT-enforced (leave-before-join with confirm dialog, S7.3);
   a DO only knows its own room — the App-A `voice_elsewhere` error is reserved for the client's
   own guard, never emitted by the server.
4. Create `worker/src/do/stats.ts` (`StatsModule`, signatures below). Open intervals persist in
   `ctx.storage` KV key `stats:open` as `{ streams: Record<userId, startedAtMs>, watches:
   Record<"viewerId:streamerId", startedAtMs> }`. `flushOpenIntervals(now)` adds
   `floor((now-start)/1000)` to `stat_stream_seconds`/`stat_watch_seconds` and re-baselines
   `start = now` — correct across any number of alarm ticks plus the final stop. All methods take
   explicit `at`/`now` (no internal clock — testability).
5. Alarm (`ServerRoom.alarm`, single + multiplexed + idempotent — DO alarms are at-least-once):
   a. Reconcile ghosts: any voice member with zero live sockets (crash/eviction leftovers) goes
      through the `voice.leave` path (synthesized activity entry included).
   b. If voice still has members: `stats.flushOpenIntervals(now)`. (S7.1 appends
      `costMeter.tick(now)` at this exact point — leave the seam obvious.)
   c. Re-arm `setAlarm(now + intervalMs)` iff members remain or open intervals exist; otherwise
      let the alarm lapse.
   `intervalMs = LIMITS.emptyVoiceCloseMs` (60 000), or 5 000 when `env.TAVERN_TEST_FAST_ALARM
   === '1'` (set only in `.dev.vars` variants; never in production config). Ghost lifetime is
   therefore ≤ one alarm interval — that IS the FR-24 "empty >60 s" crash-safety close.
6. `voice.state` c2s `{ muted, deafened }` → update that member's flags → broadcast snapshot
   (FR-26 relay; no server-side audio semantics).
7. Replace the S3.1 `hello.ok` voice stub with the live snapshot.
8. Stats read path: DO `GET /internal/stats` →
   `{ perUser: [{ userId, messages, streamSeconds }], watchPairs: [{ viewerId, streamerId,
   seconds }] }` — `messages` from `ChatModule.messageCountByUser()`, `perUser` = union of the
   member cache and stat rows. Worker route `GET /api/servers/:id/stats` (`requireMember`) →
   proxy. Zod: `StatsResponse` from `@tavern/shared` api.ts (S0.2; STOP if absent).
9. Register `voice.join`, `voice.leave`, `voice.state` in the router map.

## Pinned interfaces & artifacts

Files created: `worker/src/do/stats.ts`, `worker/test/ws/voice.spec.ts`,
`worker/test/stats-http.test.ts`. Modified: `worker/src/do/{ServerRoom,roomState}.ts`,
`worker/src/routes/servers.ts`, `worker/.dev.vars.example` (+`TAVERN_TEST_FAST_ALARM=`).

```ts
// roomState.ts additions
voiceJoin(userId: string, now: number): VoiceState
voiceLeave(userId: string, now: number): { snapshot: VoiceState; closedSession: boolean }
setVoiceFlags(userId: string, flags: { muted: boolean; deafened: boolean }): VoiceState
voiceState(): VoiceState

// stats.ts
export class StatsModule {
  constructor(ctx: DurableObjectState)
  noteStreamStart(userId: string, at: number): Promise<void>
  noteStreamStop(userId: string, at: number): Promise<void>
  noteWatchStart(viewerId: string, streamerId: string, at: number): Promise<void>
  noteWatchStop(viewerId: string, streamerId: string, at: number): Promise<void>
  closeAllFor(userId: string, at: number): Promise<void>     // leave/disconnect sweep
  flushOpenIntervals(now: number): Promise<void>
  snapshot(messageCounts: Map<string, number>, members: Member[]): StatsResponse
}
```

`VoiceState`/`VoiceMember` per §5.4; `StatsResponse` (task-8 shape) imported from
`@tavern/shared` api.ts (S0.2). Env addition: `TAVERN_TEST_FAST_ALARM?: string` in the Worker
`Env` type.

## Tests

`worker/test/ws/voice.spec.ts`:

- `describe('FR-18 voice join/leave')`: A joins → both sockets get `voice.state` with A +
  `sessionStartedAt` set; B joins → snapshot has 2; double-join is a no-op snapshot; A's socket
  hard-closes → snapshot without A + `voice.leave` activity
- `describe('FR-24 session timer & auto-close')` (uses `runDurableObjectAlarm` +
  `TAVERN_TEST_FAST_ALARM=1` in the test env): first join inserts a `voice_sessions` row and arms
  an alarm (`ctx.storage.getAlarm() !== null` via `runInDurableObject`); last leave sets
  `ended_at` and nulls `sessionStartedAt`; GHOST: seed `voice` KV with a member having no socket
  via `runInDurableObject` → `runDurableObjectAlarm` → session closed + synthesized `voice.leave`
  activity; double alarm fire → no double-close, no negative/duplicated stats (idempotency)
- `describe('FR-26 flags relay')`: `voice.state{muted:true,deafened:false}` → broadcast snapshot
  carries the flags; deafen relayed likewise
- `describe('FR-40 stat accumulators')` (all with explicit timestamps, via `runInDurableObject`):
  watchStart(t0) → flush(t0+90s) → watchStop(t0+120s) ⇒ pair seconds = 120; streamStart/Stop ⇒
  stream seconds exact; `closeAllFor` closes both kinds; flush with no open intervals is a no-op

`worker/test/stats-http.test.ts` — `describe('FR-40 stats endpoint')`: seeded counts + pairs →
response parses with `StatsResponse`, message counts match seeded chat rows; non-member →
403.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker typecheck` → exit 0
- [ ] `pnpm -F @tavern/worker test && pnpm -F @tavern/worker test:ws` → exit 0, 0 failed
- [ ] `pnpm -F @tavern/worker test` → lines ≥80% (default project; the `test` script already runs `--coverage`)
- [ ] `pnpm lint && pnpm format:check` → exit 0
- [ ] `grep -rlE "FR-(18|24|26|40)" worker/test` → ≥2 files

## STOP conditions (beyond global R1)

- `runDurableObjectAlarm` cannot drive the pinned alarm flow → blocker with the exact failure
  (do not replace the alarm with timers or test-only code paths).
- Any temptation to store voice membership only in memory → forbidden (hibernation loses it);
  the KV pin stands.

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/api/sql-storage/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
