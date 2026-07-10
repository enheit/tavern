# S6.1 — Chat UI: messages, emoji, mentions

- after: S3.2, S5.2
- unlocks: S6.2, S10.1
- FRs: FR-14, FR-15, FR-17
- references: PLAN §1.3, §3.3 (frimousse), §4, §7.6, §9, §10, §App-A (chat frames), §App-B

## Goal

The Chat tab: paginated message history, sending with optimistic echo, unicode emoji via the
frimousse picker, and `@username` mention autocomplete + highlighting. Two clients chat live.

## Preconditions (run these; red = STOP)

- `grep -q "^## S3.2" docs/progress.md && grep -q "^## S5.2" docs/progress.md` → exit 0
- `pnpm -F @tavern/e2e exec playwright test --project=web web/servers.spec.ts` → exit 0

## Tasks

1. Verify the emoji picker component is present (installed by S4.2, the actual first consumer):
   `test -f app/src/components/ui/emoji-picker.tsx` → exit 0 (frimousse 0.3.0 per §3.3). Do NOT
   re-run `shadcn add` for it — the component already exists and re-adding prompts to overwrite.
2. Extend the room store (flat shape from S4.3 — `messages: ChatMessage[]` and `hasMoreHistory`
   already exist at the top level; add the three members below alongside them, do NOT nest under a
   `chat` key):
   ```ts
   // room store additions (top-level, next to the existing `messages` / `hasMoreHistory`)
   pendingNonces: ReadonlySet<string>;
   sendMessage(body: string): void;   // trim → guard 1..LIMITS.messageMaxChars → ws chat.send {body, nonce}
   loadOlder(): Promise<void>;        // ws chat.history {beforeId: messages[0]?.id, limit: LIMITS.historyPageSize}
   ```
   Optimistic echo pinned: `sendMessage` appends a local pending message with the nonce;
   `chat.new` carrying the same nonce replaces it; foreign `chat.new` appends.
3. `app/src/features/chat/ChatTabs.tsx`: shadcn Tabs in the right-column tabs slot; pinned tab ids
   `'chat' | 'activity' | 'stats' | 'recordings'`; only Chat renders content now — the other three
   panes render a centered `m.common_coming_soon()` placeholder (replaced by S10.x / S9.3).
4. `app/src/features/chat/MessageList.tsx`: normal-column scroll container that sticks to bottom
   when the user is at bottom; an IntersectionObserver sentinel at the top calls `loadOlder()`
   while `hasMoreHistory`; after prepend, restore position by scrollHeight delta (pinned mechanism).
   Rows via `MessageRow.tsx`: 32px avatar, displayName in `member.color`, `HH:mm` time via
   `Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })`, body
   `whitespace-pre-wrap break-words`. No day dividers (non-goal). Pending rows render at 60%
   opacity until echoed.
5. Mention rendering pinned: split body on `/@[a-z0-9_]{3,20}/gi`; every mention token renders as
   an accent-colored span; when `message.mentions` includes my userId AND the token equals my
   username (case-insensitive), the span additionally gets the self-highlight background.
   Unicode emoji render natively — no twemoji/images (pinned).
6. `app/src/features/chat/Composer.tsx` + `MentionAutocomplete.tsx`:
   - Textarea auto-grows 1–5 rows (line-count clamp); Enter sends trimmed body, Shift+Enter
     inserts newline; body >`LIMITS.messageMaxChars` blocked; live counter appears at >1800 chars (pinned
     threshold), format `chat.composer.counter`.
   - Emoji button opens a shadcn Popover hosting the frimousse picker; pick inserts at caret and
     refocuses the textarea.
   - Autocomplete opens when the caret word matches `/^@[a-z0-9_]*$/`: lists ≤6 members by
     username prefix; ArrowUp/Down cycles, Enter/Tab picks (replaces token with `@username` +
     space), Esc closes; while open, Enter does NOT send (pinned).
7. i18n keys (both locales):

   | key | en | uk |
   |---|---|---|
   | tabs.chat | Chat | Чат |
   | tabs.activity | Activity | Активність |
   | tabs.stats | Stats | Статистика |
   | tabs.recordings | Recordings | Записи |
   | common.comingSoon | Coming soon | Незабаром |
   | chat.composer.placeholder | Message #general | Повідомлення в #general |
   | chat.composer.send | Send | Надіслати |
   | chat.composer.counter | {{n} } / 2000 | {{n} } / 2000 |
   | chat.emoji.label | Emoji | Емодзі |
   | chat.history.loading | Loading… | Завантаження… |

   (counter key uses the Paraglide `{n}` parameter — single braces, no space; shown here with a
   space only to survive this file's template.)

## Pinned interfaces & artifacts

Files created: `app/src/features/chat/{ChatTabs.tsx,MessageList.tsx,MessageRow.tsx,Composer.tsx,
MentionAutocomplete.tsx}` + colocated tests, `e2e/web/chat.spec.ts`. Modified: room store (adds
`pendingNonces`/`sendMessage`/`loadOlder` to the flat S4.3 shape), AppShell tabs slot wiring,
`app/messages/{en,uk}.json`.

Wire contracts consumed verbatim (§App-A): c2s `chat.send { body, nonce }`, `chat.history
{ beforeId?, limit }`; s2c `chat.new { message, nonce? }`, `chat.page { messages, hasMore }`.
`ChatMessage = { id: number, userId: string, body: string, mentions: string[], at: number }`.
Mentions are extracted SERVER-side (S3.2) — the client never computes `mentions`, only renders.

## Tests

- `Composer.test.tsx` — `describe('FR-14 composer')`:
  1. `Enter sends trimmed body and clears`
  2. `Shift+Enter inserts newline without sending`
  3. `blocks >2000 chars and shows counter from 1801`
  4. `emoji pick inserts at caret and refocuses`
  5. `mention pick inserts @username with trailing space (FR-15)`
  6. `Enter selects mention instead of sending while autocomplete open`
- `MessageList.test.tsx` — `describe('FR-15 FR-17 message list')`:
  1. `self-mention gets highlight background; other mentions accent only`
  2. `top sentinel triggers loadOlder while hasMore`
  3. `scroll position preserved after prepend`
  4. `pending message at reduced opacity until nonce echo`
- room store: `describe('FR-14 chat slice')` — `optimistic nonce lifecycle`, `loadOlder passes
  beforeId of oldest message`.
- `e2e/web/chat.spec.ts` — `describe('FR-14 FR-15 FR-17 chat')`:
  1. `B sees A's message within 1s`
  2. `A mentions @B via autocomplete; highlighted on B, accent-only on A`
  3. `picked emoji appears in the delivered message`
  4. `history survives B reload and older page loads on scroll-top`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --run --coverage` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test --project=web web/chat.spec.ts` → all passed
- [ ] `pnpm typecheck && pnpm lint && node scripts/check-i18n-literals.mjs` → exit 0

## STOP conditions (beyond global R1)

- frimousse install fails on react 19.2.7 peers (§3.3 says compatible — a conflict is drift).
- `chat.new` arrives without `mentions` array (S3.2 contract drift).
- Any need to compute mentions client-side.

## Docs (consult only these)

- https://frimousse.liveblocks.io/ (picker props/styling)
- https://ui.shadcn.com/docs/components (Base UI tab: tabs, popover, scroll-area)
- https://paraglidejs.com/basics (message parameters `{name}` syntax)
