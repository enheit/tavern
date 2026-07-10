# S6.2 — Notifications + settings UI

- after: S6.1
- unlocks: S11.1
- FRs: FR-16; UI + persistence for FR-03, FR-04, FR-05, FR-06, FR-07
- references: PLAN §1.1, §1.3 (FR-16 AC), §4, §6.1, §6.3, §9, §App-B

## Goal

System notifications with the pinned decision rule and per-account toggles, plus the Settings
dialog: profile (display name, username, color, avatar), app (theme, language), notifications.

## Preconditions (run these; red = STOP)

- `grep -q "^## S6.1" docs/progress.md` → exit 0
- `pnpm -F @tavern/e2e exec playwright test --project=web web/chat.spec.ts` → exit 0

## Tasks

1. `app/src/lib/focusState.ts`: module tracking `focused = document.hasFocus() &&
   document.visibilityState === 'visible'`, updated on window `focus`/`blur` and
   `visibilitychange` (pinned definition), exposed as a zustand-vanilla store for testability.
2. `app/src/lib/notifications.ts`:
   ```ts
   export type NotifyContext = {
     windowFocused: boolean;
     activeServerId: string | null;
     settings: { notifyAll: boolean; notifyMentions: boolean };
     myUserId: string;
   };
   export function shouldNotify(msg: { serverId: string; userId: string; mentions: string[] }, ctx: NotifyContext): boolean;
   export function truncateBody(body: string): string;      // 120 chars + '…' — see NOTIFY_BODY_MAX below
   export function initNotifications(): () => void;         // subscribe all room stores' chat.new
   ```
   `shouldNotify` pinned truth: `(!ctx.windowFocused || ctx.activeServerId !== msg.serverId) &&
   (mentionsMe ? settings.notifyMentions : settings.notifyAll)` where `mentionsMe =
   msg.mentions.includes(ctx.myUserId)`. NOTE the pinned semantics: for mention messages ONLY
   `notifyMentions` decides — `notifyAll` is ignored for them.
   Payload pinned: title `` `${displayName} — ${serverNickname}` ``, body = `truncateBody(body)`,
   mention notifications prefix the body with `'@ '`. Click → `platform.shell.focusWindow()` +
   navigate `/s/${serverId}`. Never notify for own messages (guard `msg.userId !== myUserId`).
   Constant pinned: `120` is a module-local `const NOTIFY_BODY_MAX = 120` in notifications.ts —
   it is exempt from App-B's single-source rule (a UI truncation length, not a domain limit; §9.3
   UPPER_SNAKE-in-limits.ts rule does not apply), so do NOT add it to `LIMITS`.
3. Platform bridges: route through `platform.notifications.show({ title, body, tag })` (§6.3).
   `tag` pinned: the message's `serverId` — it is the only value the `onClick(cb: (tag) => void)`
   callback receives, and the click handler navigates to `/s/${tag}`.
   Web impl: `Notification` API; permission is requested only on the user gesture of enabling a
   notification toggle (pinned); if `denied`, show one-time toast `settings_notifications_denied`
   and no-op. Desktop impl: IPC to main-process Notification (S4.1, already gated by zod).
   Test hook pinned: when `TAVERN_E2E=1`, BOTH impls push `{ title, body, serverId }` into
   `window.__tavernTestNotifications` instead of displaying.
4. `app/src/lib/imageResize.ts`: `resizeToWebp(file: File, size: 256): Promise<Blob>` — center
   square crop via canvas `drawImage`, `toBlob('image/webp', 0.9)`; accepts png/jpeg/webp only;
   result must be ≤ `LIMITS.avatarMaxBytes` (guard, then POST).
5. `app/src/features/settings/{SettingsDialog.tsx,AccountSection.tsx,AppSection.tsx,
   NotificationsSection.tsx}`: shadcn Dialog opened from a new `shell.userMenu.settings` item
   (modify S5.2's UserMenu); internal Tabs `account | app | notifications`.
   - Account: displayName (1..32), username (App-B regex, lowercased), color = 12 pinned swatches
     `#e0e0e0 #f87171 #fb923c #facc15 #4ade80 #34d399 #22d3ee #60a5fa #818cf8 #c084fc #f472b6
     #a8a29e` + free hex input validated `/^#[0-9a-f]{6}$/`; avatar file input →
     `resizeToWebp` → `POST /api/me/avatar`. One Save button per section, disabled until dirty,
     success toast `common.saved`. Profile saves via `PATCH /api/me/profile` (propagation to
     other clients arrives as `member.update` — already handled by stores).
   - App: theme radio light/dark/system (settings store → html class + localStorage mirror, the
     S4.2 mechanism), language select en/uk (Paraglide `setLocale(locale, { reload: false })` + the store's `localeVersion` bump — S4.2 mechanism).
   - Notifications: switches for `notifyAll`, `notifyMentions`.
   - Persistence pinned: `PUT /api/me/settings` with the full camelCase wire body
     `{ notifyAll, notifyMentions, locale, theme }` (validated against S0.2's `UserSettings` zod —
     snake_case is the §5.1 DB column form only) on any change in App/Notifications sections;
     settings store hydrated from `GET /api/me` at boot (S4.3).
6. i18n keys (both locales):

   | key | en | uk |
   |---|---|---|
   | shell.userMenu.settings | Settings | Налаштування |
   | settings.title | Settings | Налаштування |
   | settings.tabs.account | Account | Акаунт |
   | settings.tabs.app | App | Застосунок |
   | settings.tabs.notifications | Notifications | Сповіщення |
   | settings.account.displayName | Display name | Відображуване ім'я |
   | settings.account.username | Username | Нікнейм |
   | settings.account.color | Name color | Колір імені |
   | settings.account.avatar | Avatar | Аватар |
   | settings.account.changeAvatar | Change avatar | Змінити аватар |
   | settings.app.theme | Theme | Тема |
   | settings.app.themeLight | Light | Світла |
   | settings.app.themeDark | Dark | Темна |
   | settings.app.themeSystem | System | Системна |
   | settings.app.language | Language | Мова |
   | settings.notifications.all | All messages | Усі повідомлення |
   | settings.notifications.mentions | Mentions | Згадки |
   | settings_notifications_denied | Notifications are blocked by the browser | Браузер заблокував сповіщення |
   | common.save | Save | Зберегти |
   | common.saved | Saved | Збережено |
   | errors.avatar_too_large | Image too large (max 2 MB) | Зображення завелике (макс. 2 МБ) |
   | errors.color_invalid | Use #rrggbb | Формат #rrggbb |

## Pinned interfaces & artifacts

Files created: `app/src/lib/{notifications.ts,focusState.ts,imageResize.ts}`,
`app/src/features/settings/{SettingsDialog.tsx,AccountSection.tsx,AppSection.tsx,
NotificationsSection.tsx}` + colocated tests, `e2e/web/notifications.spec.ts`,
`e2e/web/settings.spec.ts`. Modified: `Header.tsx`/UserMenu (S5.2 file — allowed touch-point),
platform bridges (`platform/electron.ts`, `platform/web.ts` — notification test hook),
`app/src/main.tsx` (initNotifications on boot ready), i18n JSONs.

Contracts consumed verbatim: `PATCH /api/me/profile { displayName?, color?, username? }`,
`POST /api/me/avatar` (webp bytes), `GET/PUT /api/me/settings` row per §5.1; `member.update`
fan-out is server-side (S1.3) — no client refetch loops.

## Tests

- `notifications.test.ts` — `describe('FR-16 shouldNotify')`, 8 pinned cases:
  1. `focused + active server + plain message → no`
  2. `focused + active server + mention → no`
  3. `focused + OTHER server + plain + all-on → yes`
  4. `unfocused + active server + plain + all-on → yes`
  5. `unfocused + plain + all-off → no`
  6. `unfocused + mention + mentions-on + all-off → yes`
  7. `unfocused + mention + mentions-off + all-on → no (mention gate wins)`
  8. `own message never notifies`
  plus `truncates body at 120 with ellipsis`.
- `imageResize.test.ts` — `describe('FR-05 avatar resize')`: `center-crops to 256×256 webp`,
  `rejects unsupported mime type`.
- `SettingsDialog.test.tsx` — `describe('FR-03 FR-04 FR-06 FR-07 settings')`:
  1. `save sends dirty-profile PATCH payload only`
  2. `invalid hex blocks save with errors.color_invalid`
  3. `theme radio applies html class instantly`
  4. `language select switches i18n language`
  5. `notification toggles PUT full settings row`
- `e2e/web/notifications.spec.ts` — `describe('FR-16 notifications')` (blur B via
  `page.evaluate` dispatching `blur` + visibility override — pinned technique):
  1. `unfocused B records a notification for A's message`
  2. `focused B on the active server records none`
  3. `all-off + mentions-on: only the mention notifies`
  4. `notification record carries the right serverId`
- `e2e/web/settings.spec.ts` — `describe('FR-03 FR-04 FR-05 FR-06 FR-07 settings persistence')`:
  1. `displayName + color changes propagate live to the other client's People/chat`
  2. `theme and language survive reload`
  3. `uploaded avatar renders in People for both clients`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --run --coverage` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test --project=web web/notifications.spec.ts web/settings.spec.ts` → all passed
- [ ] `pnpm typecheck && pnpm lint && node scripts/check-i18n-literals.mjs` → exit 0

## STOP conditions (beyond global R1)

- `user_settings` column names differ from §5.1 (contract drift).
- Desktop notification path would require the renderer to touch Electron APIs directly (A10
  violation — the bridge must stay the only route).
- Avatar upload rejected by worker for a ≤2MB webp produced by `resizeToWebp` (S1.3 drift).

## Docs (consult only these)

- https://developer.mozilla.org/en-US/docs/Web/API/Notification (permission states)
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob (webp quality)
- https://ui.shadcn.com/docs/components (Base UI tab: dialog, switch, tabs)
- https://paraglidejs.com/runtime (setLocale with { reload: false })
