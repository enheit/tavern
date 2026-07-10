# S5.2 — Server join/create/switch UI + app shell

- after: S2.1, S3.1, S5.1
- unlocks: S6.1, S7.3, S9.1, S10.3
- FRs: FR-08, FR-09, FR-41, FR-45 (display side), FR-11 (kicked client handling)
- references: PLAN §1.2, §4, §6.1, §7.6, §9, §App-A, §App-B

## Goal

The `/join` page (join or create a server), the persistent app shell laid out exactly per §7.6,
the header with server switcher + connection dot + user menu, and the People panel with live
presence. After this step two users can create/join servers and see each other.

## Preconditions (run these; red = STOP)

- `grep -q "^## S2.1" docs/progress.md && grep -q "^## S3.1" docs/progress.md && grep -q "^## S5.1" docs/progress.md` → exit 0
  (S3.1 is required — DoD gate 2's live-presence e2e needs the ServerRoom DO's WS/hello/broadcast)
- `pnpm -F @tavern/e2e exec playwright test --project=web web/auth.spec.ts` → exit 0

## Tasks

1. `app/src/features/servers/useServers.ts`:
   ```ts
   export function useServers(): {
     servers: ServerSummary[];                       // from servers store (hydrated at boot)
     activeServerId: string | null;
     createServer(input: CreateServerRequest): Promise<string>; // → serverId
     joinServer(input: JoinServerRequest): Promise<string>;     // → serverId
     pending: boolean;
     error: ErrorCode | null;
   }
   ```
   TanStack Query mutations POST `/api/servers` and `/api/servers/join`; on success: upsert into
   servers store, `wsClient.connect(serverId)`, return id. Callers navigate `/s/${id}`.
2. `app/src/features/servers/JoinOrCreatePage.tsx` (route `/join`): two shadcn Cards side by side
   — Join (nickname + password input always visible, optional) and Create (nickname + optional
   password). RHF + shared schemas (`serverNickname` per §App-B; server password ≥4 when present).
   Server `ErrorCode`s render in a form-level slot via `errorMessage(code)` (the S4.3 resolver —
   no dynamic key construction, §9.6).
3. `app/src/features/servers/ServerSwitcher.tsx`: shadcn DropdownMenu in the header, trigger shows
   active server nickname (or `m.servers_switcher_none()`); items = joined servers (active one
   check-marked) navigating `/s/:id`; separator; `m.servers_switcher_join_or_create()` item → `/join`.
4. `app/src/features/shell/AppShell.tsx` + `Header.tsx`: CSS grid pinned —
   `grid-template-rows: 40px 1fr 56px; grid-template-columns: 240px 1fr 320px;` named areas:
   header spans all columns; left column (rows 2–3) = flex column with Channels (auto height) over
   People (fill); center row 2 = canvas slot, center row 3 = controls slot; right column
   (rows 2–3) = flex column with tabs slot (fill) over soundboard slot (fixed 280px).
   Canvas/controls/tabs/soundboard render empty named placeholder panels (filled by S6.1/S7.3/
   S8.2/S9.1). Header children: ServerSwitcher (left), spacer, connection dot, UserMenu.
   Connection dot reads the SERVERS store `connState[activeServerId]` (S4.3 — there is no room-store
   `wsStatus`), mapped by a pinned static record (no dynamic key construction, §9.6):
   `open`→`bg-green-500` + `m.shell_connection_connected()`; `connecting`→`bg-amber-500` +
   `m.shell_connection_connecting()`; `reconnecting`→`bg-amber-500` +
   `m.shell_connection_reconnecting()`; `closed`→`bg-gray-400` + `m.shell_connection_offline()`.
   The chosen label is the dot's `title`.
   UserMenu (avatar button → dropdown): ONLY `shell_user_menu_logout` in this step (Settings item
   is added by S6.2).
5. `app/src/features/servers/PeoplePanel.tsx`: subscribes room store members. Sort comparator
   pinned: `isAdmin` desc → presence rank (`in-voice`=0, `online`=1, `offline`=2) → `displayName`
   `localeCompare`. Presence dots pinned: offline gray-400, online green-500, in-voice violet-500.
   Name rendered in `member.color`. Avatar `img src="/api/media/avatars/{userId}.webp"`, on error
   fall back to a colored block with the first displayName character.
6. `app/src/features/servers/ChannelsPanel.tsx`: static rows — `m.channels_voice()` (inert until
   S7.3) and `m.channels_general()` under a `m.channels_title()` heading.
7. `app/src/features/servers/ServerPage.tsx` (route `/s/:serverId`): guards membership (unknown id
   → redirect `/join`), sets `activeServerId`, renders AppShell bound to that server's room store.
   Kicked handling: an effect watches the room store `kicked` flag (S4.3 sets it on the App-A
   `kicked` frame) for server S → `toast(m.servers_kicked_toast({ server }))` (sonner), remove S
   from servers store, if S was active navigate `/join`.
8. i18n keys — add to `app/messages/en.json` AND `app/messages/uk.json` (FLAT snake_case, §9.6;
   parameters are single-brace inlang syntax `{server}`, called as `m.servers_kicked_toast({ server })`).
   Do NOT add any `error_<code>` keys: server errors (`not_found`, `wrong_password`,
   `nickname_taken`, `server_cap`) are already seeded by S4.2 and rendered via `errorMessage(code)`.
   There is no `already_member` code — join is idempotent (re-join returns 200), so no such key.

   | key | en | uk |
   |---|---|---|
   | servers_join_title | Join a server | Приєднатися до сервера |
   | servers_join_nickname | Server nickname | Нікнейм сервера |
   | servers_join_password | Password (if required) | Пароль (якщо потрібен) |
   | servers_join_submit | Join | Приєднатися |
   | servers_create_title | Create a server | Створити сервер |
   | servers_create_password | Password (optional) | Пароль (необов'язково) |
   | servers_create_submit | Create | Створити |
   | servers_switcher_none | Select a server | Оберіть сервер |
   | servers_switcher_join_or_create | Join or create… | Приєднатися або створити… |
   | servers_kicked_toast | You were kicked from {server} | Вас вигнали з сервера {server} |
   | shell_connection_connected | Connected | Підключено |
   | shell_connection_connecting | Connecting… | Підключення… |
   | shell_connection_reconnecting | Reconnecting… | Перепідключення… |
   | shell_connection_offline | Offline | Офлайн |
   | shell_user_menu_logout | Log out | Вийти |
   | people_title | People | Учасники |
   | channels_title | Channels | Канали |
   | channels_voice | Voice | Голосовий |
   | channels_general | general | general |

## Pinned interfaces & artifacts

Files created: `app/src/features/servers/{useServers.ts,JoinOrCreatePage.tsx,ServerSwitcher.tsx,
PeoplePanel.tsx,ChannelsPanel.tsx,ServerPage.tsx}`, `app/src/features/shell/{AppShell.tsx,
Header.tsx}` + colocated tests, `e2e/web/servers.spec.ts`. Modified: `app/src/router.tsx`,
`app/messages/{en,uk}.json`.

Contracts consumed verbatim: `POST /api/servers` / `POST /api/servers/join` request+response per
§6.1; room store `members: Member[]` and `kicked: boolean` flag, servers store
`connState[serverId]` (values `connecting|open|reconnecting|closed`), `Member.presence ∈
{'offline','online','in-voice'}` (§5.4, S3.1/S4.3). Server switching preserves per-server room
store state (stores are per-server instances — switching only changes `activeServerId`).

## Tests

- `PeoplePanel.test.tsx` — `describe('FR-45 people panel')`:
  1. `sorts admin first, then presence rank, then name` (5-member matrix)
  2. `renders pinned dot color class per presence state`
  3. `renders displayName in member color`
  4. `falls back to initial block when avatar 404s`
- `ServerSwitcher.test.tsx` — `describe('FR-41 server switcher')`:
  1. `lists joined servers and check-marks the active one`
  2. `join-or-create item navigates /join`
- `useServers.test.ts` — `describe('FR-08 FR-09 server mutations')`:
  1. `create posts payload, upserts store, connects ws, resolves id`
  2. `join maps wrong_password to error state`
- `ServerPage.test.tsx` — `describe('FR-11 kicked handling')`:
  1. `kicked event shows toast, removes server, navigates /join when active`
  2. `unknown serverId redirects /join`
- `AppShell.test.tsx` — `describe('shell layout')`: `renders pinned grid template and named slots`
- `e2e/web/servers.spec.ts` — `describe('FR-08 FR-09 FR-41 FR-45 servers')`:
  1. `A creates a server, lands on /s/:id, sees self in People`
  2. `B joins by nickname+password and appears in A's People live`
  3. `wrong password shows error and does not join`
  4. `A switches between two servers; shell renders each server's name and members`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --run --coverage` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test --project=web web/servers.spec.ts` → all passed
- [ ] `pnpm typecheck && pnpm lint && pnpm check:i18n` → exit 0

## STOP conditions (beyond global R1)

- Room store has no `kicked` flag, or servers store has no `connState` map (S4.3 contract drift).
- `presence` values beyond the three pinned states appear on the wire.
- The §7.6 grid cannot host a later panel without changing pinned dimensions.

## Docs (consult only these)

- https://ui.shadcn.com/docs/components (Base UI tab: dropdown-menu, card, dialog)
- https://tanstack.com/query/latest/docs/framework/react/guides/mutations
- https://sonner.emilkowal.ski/ (toast API)
