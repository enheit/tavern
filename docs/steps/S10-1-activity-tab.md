# S10.1 — Activity tab

- after: S3.3, S6.1
- unlocks: S12.4
- FRs: FR-39
- references: PLAN §1.7, §6.1 (activity route), §7.6 (right-column tabs), §9 (all), §10, App-A (`activity.types`, `activity.new`), App-B (`historyPageSize`)

## Goal

Add the **Activity** tab to the right-column tab group: a persisted, paginated,
live-updating log of server events (voice join/leave, stream start/stop, recording
start/stop, member join/kick), rendered per-type with i18n templates and relative
timestamps.

## Preconditions (run these; red = STOP)

- `grep -q '^## S3.3' docs/progress.md && grep -q '^## S6.1' docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test -- activity` → all green (DO activity module + HTTP read route exist)
- `pnpm -F @tavern/app test -- src/features/chat` → all green (ChatTabs shell exists)

## Tasks

1. Add the `Activity` tab trigger + panel to the existing right-column tab group
   component created in S6.1 (`app/src/features/chat/ChatTabs.tsx`). Tab order is
   pinned by PLAN §7.6: Chat · Activity · Stats · Recordings — insert Activity in
   position 2; Stats/Recordings triggers may not exist yet (added by S10.2/S9.3) —
   do NOT stub them.
2. Create `app/src/features/activity/ActivityTab.tsx`: reverse-chronological list,
   TanStack Query `useInfiniteQuery` over `GET /api/servers/:id/activity?before&limit`
   (page size = `LIMITS.historyPageSize` = 50; cursor = lowest `id` of the previous
   page; `hasMore` from response). Scroll-down loads older pages (list is newest-first,
   pagination control at the bottom via intersection observer on a sentinel row).
3. Live updates: the room store already receives `activity.new` frames (S4.3's reducer
   wired the client-side WS dispatch). Extend the existing `activityTail: ActivityEntry[]`
   slice (created in S4.3) with the action `appendActivity(entry)` that **dedups by
   `entry.id`** (an entry may arrive both via tail and via a query refetch), replacing
   S4.3's plain-append reducer for `activity.new`. `ActivityTab` renders `activityTail`
   merged in front of query pages, deduped by id, sorted by `id` DESC.
4. Create `app/src/features/activity/ActivityRow.tsx`: icon + i18n template + relative
   time. One row per `activity.types` value (App-A). The `{name}` parameter resolves
   through the room-store member map; unknown `userId` (departed member) falls back to
   `m.activity_former_member()`.
5. Relative time: add `formatRelativeTime(at: number, locale: string): string` to
   `app/src/lib/time.ts` (create the file if no earlier step created it; if it exists,
   add the export). Implementation constraint: `Intl.RelativeTimeFormat` only — no date
   library (R2). Pinned thresholds: <60s → seconds; <60min → minutes; <24h → hours;
   otherwise days.
6. Add the i18n keys below to `app/messages/en.json` + `app/messages/uk.json` (parity
   test from S4.2 will fail if one side is missing).

## Pinned interfaces & artifacts

Files created: `app/src/features/activity/ActivityTab.tsx`,
`app/src/features/activity/ActivityRow.tsx`,
`app/src/features/activity/ActivityTab.test.tsx`,
`app/src/features/activity/ActivityRow.test.tsx`, `e2e/web/activity.spec.ts`.
Files modified: `app/src/features/chat/ChatTabs.tsx`, `app/src/stores/room.ts`,
`app/src/lib/time.ts` (+ its test), `app/messages/en.json`, `app/messages/uk.json`.

```ts
// shared/src/domain.ts (ActivityEntry, defined in S0.2 — verify, do not redefine):
// ActivityEntry = { id: number; type: ActivityType; userId: string;
//                   meta: Record<string, string>; at: number }
// shared/src/api.ts (defined in S0.2): GET /api/servers/:id/activity
//   → { entries: ActivityEntry[]; hasMore: boolean }

// app/src/stores/room.ts (additions)
activityTail: ActivityEntry[];
appendActivity(entry: ActivityEntry): void;   // dedup by id, cap tail at 200

// app/src/lib/time.ts
export function formatRelativeTime(at: number, locale: string): string;
```

i18n keys (flat snake_case; en / uk). Parameter syntax is inlang message-format
single-brace `{name}`; call as `m.activity_voice_join({ name })`.

| key | en | uk |
|---|---|---|
| `activity_voice_join` | {name} joined voice | {name} приєднався до голосового чату |
| `activity_voice_leave` | {name} left voice | {name} покинув голосовий чат |
| `activity_stream_start` | {name} started streaming | {name} почав стрім |
| `activity_stream_stop` | {name} stopped streaming | {name} зупинив стрім |
| `activity_rec_start` | {name} started a voice recording | {name} почав запис голосу |
| `activity_rec_stop` | {name} stopped the voice recording | {name} зупинив запис голосу |
| `activity_member_join` | {name} joined the server | {name} приєднався до сервера |
| `activity_member_kick` | {name} was kicked | {name} виключено з сервера |
| `activity_former_member` | Former member | Колишній учасник |
| `activity_empty` | No activity yet | Поки що немає активності |

`tabs_activity` (Activity / Активність) is defined in S6-1 — verify present, do not
re-add. `activity_former_member` is owned by this step (S10.2 pins its own
`stats_former_member` for the Stats tab — the two do not share a key).

Type→key mapping is a pinned constant `ACTIVITY_I18N: Record<ActivityType, string>` in
`ActivityRow.tsx`. Icons: lucide-react is NOT in §3 — use the pinned 2-letter monochrome
glyph fallback unconditionally (CSS, no new dependency, R2): `voice.join`→VJ,
`voice.leave`→VL, `stream.start`→SS, `stream.stop`→SX, `rec.start`→RS, `rec.stop`→RX,
`member.join`→MJ, `member.kick`→MK.

## Tests

- `app/src/lib/time.test.ts` — `describe('FR-39 relative time')`: `'formats 5s ago'`,
  `'formats 59min ago as minutes'`, `'formats 23h ago as hours'`, `'formats 3d ago as
  days'`, `'formats uk locale'`.
- `app/src/features/activity/ActivityRow.test.tsx` — `describe('FR-39 activity rows')`:
  one case per all 8 `activity.types` asserting the interpolated en string; `'falls
  back to former-member label for unknown userId'`.
- `app/src/features/activity/ActivityTab.test.tsx` — `describe('FR-39 activity tab')`:
  `'renders first page newest-first'`, `'appends older page on sentinel intersect'`,
  `'prepends live activity.new entry'`, `'dedups entry present in both tail and page'`,
  `'shows empty state'`.
- `e2e/web/activity.spec.ts` — `describe('FR-39 activity e2e')`, two contexts:
  `'voice join and leave by A appear live in B activity tab without refresh'` (assert
  both rows, correct order, A's displayName interpolated).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- src/features/activity src/lib/time` → exit 0, 0 skipped
- [ ] `pnpm -F @tavern/app typecheck` → exit 0
- [ ] `pnpm check:i18n` → exit 0 (key parity + no JSX literals)
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test web/activity.spec.ts --project=web` → all green
- [ ] `grep -rn "FR-39" app/src e2e | wc -l` → ≥ 4

## STOP conditions (beyond global R1)

- `ActivityEntry` (`shared/src/domain.ts`) or the route response (`shared/src/api.ts`)
  shape differs from the pinned shapes above → blocker (do not adapt silently).
- S6.1's tab component is not at `app/src/features/chat/ChatTabs.tsx` or exposes no way
  to register a tab without editing unrelated code → blocker (name the actual shape).
- Any need for a date/icon library → forbidden by R2; use the pinned fallbacks.

## Docs (consult only these)

- https://tanstack.com/query/v5/docs/framework/react/guides/infinite-queries
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/RelativeTimeFormat
- https://paraglidejs.com/basics (parameters: `m.key({ name })` — no component interpolation)
