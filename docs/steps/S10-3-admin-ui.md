# S10.3 — Admin UI (rename, password, kick)

- after: S2.2, S5.2, S7.3
- unlocks: S12.4
- FRs: FR-10, FR-11, FR-12
- references: PLAN §1.2, §6.1 (`PATCH /api/servers/:id`, `DELETE /api/servers/:id/members/:userId`), §7.6 (header), §9, App-A (`server.updated`, `kicked`), App-B (`serverNickname`, `serverPassword`)

## Goal

Give the server admin a settings dialog (rename server, set/clear password, kick
members) and a kick entry in the member context menu — wiring the S2.2 backend ops
into UI with live propagation (`server.updated`) and the kicked-client flow.

## Preconditions (run these; red = STOP)

- `grep -q '^## S2.2' docs/progress.md && grep -q '^## S5.2' docs/progress.md && grep -q '^## S7.3' docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test -- admin` → all green (S2.2 routes exist: rename w/ `nickname_taken`, password set/clear, kick → DO eviction 4001)

## Tasks

1. Create `app/src/features/admin/ServerSettingsDialog.tsx` (shadcn Dialog, Base UI
   variant). Trigger: gear icon button in the shell header
   (`app/src/features/shell/Header.tsx` — modify), rendered **iff**
   `self.userId === serverMeta.adminUserId`.
2. **Rename section**: RHF + zod form, schema reused from
   `shared` (`serverNickname` rule `/^[a-z0-9-]{3,32}$/i` — import, do not restate).
   Submit → `PATCH /api/servers/:id { nickname }`. Error code `nickname_taken` →
   inline field error `m.admin_nickname_taken()`. Success → toast `m.admin_renamed()`.
3. **Password section**: one password input (min 4 per `LIMITS.serverPasswordMinLen`)
   with `m.admin_password_set()` submit → `PATCH { password }`; separate
   `m.admin_password_clear()` button gated by a confirm (shadcn `alert-dialog`) →
   `PATCH { password: null }`. Both → toast `m.admin_password_updated()`. The dialog
   never displays the current password (server never returns it).
4. **Members section**: room-store member list; each non-self row gets a
   `m.admin_kick()` button → confirm alert-dialog interpolating the member's
   displayName (`m.admin_kick_confirm({ name })`) → `DELETE /api/servers/:id/members/:userId`
   → toast `m.admin_kicked({ name })`. Self row has no kick button.
5. Add a **Kick** item to the member context menu created in S7.3 (the People-panel
   context menu component pinned by S5.2/S7.3 — extend that file, do not fork a second
   menu). Visible iff self is admin AND target ≠ self; opens the same confirm flow
   (extract the `useKickMember(serverId)` hook — signature pinned below — in
   `app/src/features/admin/useKickMember.ts` so dialog + menu share one path).
6. Live rename propagation: on `server.updated { nickname }`, the WS dispatch (S5.2's
   `wsClient` routing) calls `serversStore.applyServerUpdated(serverId, nickname)` —
   add that action; it updates both the server list (header dropdown) and the active
   room's `serverMeta`. (FR-12 AC: all members see the new name live.)
7. Kicked-client verification (flow built in S5.2): e2e here asserts close 4001 →
   `/join` + toast, and rejoin-with-password works.
8. If `alert-dialog` was not generated in S4.2:
   `pnpm dlx shadcn@latest add alert-dialog` (generated files exempt from R5).
9. Add i18n keys below.

## Pinned interfaces & artifacts

Files created: `app/src/features/admin/ServerSettingsDialog.tsx`,
`app/src/features/admin/useKickMember.ts`,
`app/src/features/admin/ServerSettingsDialog.test.tsx`, `e2e/web/admin.spec.ts`.
Files modified: `app/src/features/shell/Header.tsx`,
`app/src/features/voice/VolumeMenu.tsx` (the S7.3 member context menu),
`app/src/stores/servers.ts` (+ test), `app/messages/en.json`,
`app/messages/uk.json`, possibly `app/src/components/ui/alert-dialog.tsx` (generated).

```ts
// app/src/stores/servers.ts (addition)
applyServerUpdated(serverId: string, nickname: string): void;

// app/src/features/admin/useKickMember.ts
export function useKickMember(serverId: string): {
  confirmAndKick(userId: string): void;   // opens confirm; DELETE on confirm
  dialog: ReactNode;                      // the alert-dialog instance to render once
};
```

i18n keys (flat snake_case; en / uk). Parameter syntax is inlang message-format
single-brace `{name}`; call as `m.admin_kick_confirm({ name })`.

| key | en | uk |
|---|---|---|
| `admin_title` | Server settings | Налаштування сервера |
| `admin_rename_label` | Server nickname | Нікнейм сервера |
| `admin_nickname_taken` | This nickname is already taken | Цей нікнейм уже зайнятий |
| `admin_renamed` | Server renamed | Сервер перейменовано |
| `admin_password_label` | Server password | Пароль сервера |
| `admin_password_set` | Set password | Встановити пароль |
| `admin_password_clear` | Remove password | Прибрати пароль |
| `admin_password_clear_confirm` | Remove the server password? Anyone will be able to join. | Прибрати пароль сервера? Будь-хто зможе приєднатися. |
| `admin_password_updated` | Password updated | Пароль оновлено |
| `admin_members_title` | Members | Учасники |
| `admin_kick` | Kick | Виключити |
| `admin_kick_confirm` | Kick {name} from the server? | Виключити {name} із сервера? |
| `admin_kicked` | {name} was kicked | {name} виключено |
| `common_save` | Save | Зберегти |
| `common_cancel` | Cancel | Скасувати |
| `common_confirm` | Confirm | Підтвердити |

`common_save` / `common_cancel` / `common_confirm` are the alert-dialog button labels;
add them only if an earlier step hasn't already (skip if present — identical copy).

## Tests

- `app/src/features/admin/ServerSettingsDialog.test.tsx` —
  `describe('FR-10 FR-11 FR-12 admin dialog')` (apiClient mocked):
  `'gear button absent for non-admin'`, `'dialog renders three sections for admin'`,
  `'rename rejects invalid nickname client-side'`, `'rename shows inline error on
  nickname_taken'`, `'rename success PATCHes and toasts'`, `'password set PATCHes
  {password}'`, `'password clear requires confirm then PATCHes {password:null}'`,
  `'kick shows confirm with member name and DELETEs on confirm'`, `'self row has no
  kick button'`.
- `app/src/stores/servers.test.ts` — `describe('FR-12 rename propagation')`:
  `'applyServerUpdated updates dropdown list and active serverMeta'`.
- `e2e/web/admin.spec.ts` — `describe('FR-10 FR-11 FR-12 admin e2e')`, three contexts
  (A admin, B member, C fresh): `'rename: A renames, B header shows new name without
  reload'`, `'password: A sets password, C join fails without and succeeds with it'`,
  `'kick: A kicks B, B lands on /join with toast, B rejoins using password'`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- src/features/admin src/stores/servers` → exit 0, 0 skipped
- [ ] `pnpm -F @tavern/app typecheck` → exit 0
- [ ] `pnpm check:i18n` → exit 0
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test web/admin.spec.ts --project=web` → all green
- [ ] `grep -rn "FR-1[012]" app/src/features/admin app/src/stores/servers.test.ts e2e/web/admin.spec.ts | wc -l` → ≥ 3

## STOP conditions (beyond global R1)

- S2.2's error code for a duplicate nickname is not `nickname_taken` → blocker (codes
  live in `shared/src/errors.ts`; do not invent a mapping).
- The S7.3 context-menu component has no extension point that avoids duplicating menu
  markup → blocker naming the component's actual shape.
- Admin identification differs from `serverMeta.adminUserId` in `hello.ok` → blocker.

## Docs (consult only these)

- https://ui.shadcn.com/docs/components/dialog (Base UI tab)
- https://ui.shadcn.com/docs/components/alert-dialog (Base UI tab)
- https://react-hook-form.com/docs/useform (with zodResolver, §3.3)
