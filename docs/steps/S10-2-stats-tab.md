# S10.2 — Stats tab

- after: S6.1, S8.4 (§12 lists S8.4; S6.1 added here because the tab shell is a hard import — graph correction flagged to the verifier)
- unlocks: S12.4
- FRs: FR-40
- references: PLAN §1.7, §5.2 (stat tables + derived message counts), §6.1 (stats route), §7.6, §9, §10 (hermeticity split)

## Goal

Add the **Stats** tab: per-member counters (messages sent, hours streamed) and the
"you watch most" ranking derived from server-authoritative watch pairs — the FR-40
promise "I want to know who I watch the most".

## Preconditions (run these; red = STOP)

- `grep -q '^## S8.4' docs/progress.md && grep -q '^## S6.1' docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test -- stats` → all green (DO stats accumulation + `GET /api/servers/:id/stats` exist per S3.4/S8.4)

## Tasks

1. Add the `Stats` tab trigger + panel to `app/src/features/chat/ChatTabs.tsx`
   (position 3 per PLAN §7.6).
2. Create `app/src/features/stats/StatsTab.tsx`: TanStack Query on
   `GET /api/servers/:id/stats` — `enabled` only while the tab is active,
   `staleTime: 10_000`, refetch on tab activation (query remount via `enabled` is the
   pinned mechanism; no manual `refetch()` calls).
3. Members table (shadcn table primitives already generated in S4.2): columns
   Member · Messages · Hours streamed. Sort: `messages` DESC, tie-break
   `displayName` ASC. Member cell = avatar + colored displayName (same member-cell
   component chat uses — reuse, don't fork). `userId` absent from the room-store
   member map renders `t('stats.formerMember')` with no avatar.
4. "You watch most" section under the table: `watchPairs` filtered
   `viewerId === self`, sorted `seconds` DESC, top 5, rendered as streamer name +
   `formatHoursMinutes(seconds)`. Empty → `t('stats.noWatchData')`.
5. Add `formatHoursMinutes(seconds: number): string` to `app/src/lib/time.ts` —
   `h:mm`, no leading-zero hours, minutes floor-rounded and zero-padded
   (`0 → "0:00"`, `3661 → "1:01"`, `445500 → "123:45"`).
6. Add i18n keys below to `en.json` + `uk.json`.

## Pinned interfaces & artifacts

Files created: `app/src/features/stats/StatsTab.tsx`,
`app/src/features/stats/StatsTab.test.tsx`, `e2e/web/stats.spec.ts`.
Files modified: `app/src/features/chat/ChatTabs.tsx`, `app/src/lib/time.ts` (+ test),
`app/messages/en.json`, `app/messages/uk.json`.

```ts
// shared/src/api.ts (defined in S0.2 — verify, do not redefine):
// ServerStats = {
//   members: Array<{ userId: string; messages: number; streamSeconds: number }>;
//   watchPairs: Array<{ viewerId: string; streamerId: string; seconds: number }>;
// }
// GET /api/servers/:id/stats → ServerStats

// app/src/lib/time.ts
export function formatHoursMinutes(seconds: number): string;
```

i18n keys (flat; en / uk):

| key | en | uk |
|---|---|---|
| `tabs.stats` | Stats | Статистика |
| `stats.member` | Member | Учасник |
| `stats.messages` | Messages | Повідомлення |
| `stats.hoursStreamed` | Hours streamed | Годин стріму |
| `stats.youWatchMost` | You watch most | Ви найбільше дивитесь |
| `stats.noWatchData` | You haven't watched anyone yet | Ви ще нікого не дивилися |
| `stats.formerMember` | Former member | Колишній учасник |
| `stats.empty` | No stats yet | Статистики поки немає |

## Tests

- `app/src/lib/time.test.ts` — `describe('FR-40 hours formatting')`: `'0 → 0:00'`,
  `'59s floors to 0:00'`, `'60s → 0:01'`, `'3661s → 1:01'`, `'360000s → 100:00'`,
  `'445500s → 123:45'`.
- `app/src/features/stats/StatsTab.test.tsx` — `describe('FR-40 stats tab')` (apiClient
  mocked with a seeded `ServerStats` fixture): `'sorts members by messages desc'`,
  `'tie-breaks by displayName asc'`, `'renders former member row without avatar'`,
  `'watch-most filters viewer=self, sorts desc, caps at 5'`, `'renders noWatchData
  empty state'`, `'renders empty state when no members'`.
- `e2e/web/stats.spec.ts` — `describe('FR-40 stats e2e')`, two contexts, mock-SFU mode:
  `'message counts appear: A sends 3 messages, B stats tab shows A row with ≥3'`
  (watch seconds asserted for presence only — mock mode moves no media);
  `'@realtime watch seconds accrue: B watches A stream 10s, B watch-most shows A with
  >0'` (nightly-only tag per PLAN §10).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- src/features/stats src/lib/time` → exit 0, 0 skipped
- [ ] `pnpm -F @tavern/app typecheck` → exit 0
- [ ] `pnpm check:i18n` → exit 0
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test web/stats.spec.ts --project=web --grep-invert @realtime` → all green
- [ ] `grep -rn "FR-40" app/src e2e | wc -l` → ≥ 3

## STOP conditions (beyond global R1)

- `ServerStats` shape in `shared/src/api.ts` differs from the pinned shape → blocker.
- The stats endpoint returns per-pair data that cannot answer "who do I watch most"
  (e.g. only aggregates) → blocker naming the actual shape (FR-40 AC is per-pair).
- Any charting/table library temptation → forbidden (R2); shadcn table + prose only.

## Docs (consult only these)

- https://tanstack.com/query/v5/docs/framework/react/reference/useQuery (`enabled`, `staleTime`)
