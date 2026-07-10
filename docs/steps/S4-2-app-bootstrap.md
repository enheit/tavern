# S4.2 — App bootstrap (Vite, Tailwind 4, shadcn/Base UI, i18n, theme, router)

- after: S0.2, S0.3
- unlocks: S4.3
- FRs: FR-06 (theme), FR-07 (language)
- references: PLAN §3.3, §3.6 (traps 5–6), §4, §7.6 (routes), §9.3/9.6/9.9

## Goal

Create `@tavern/app`: the single React renderer for desktop AND web. This step delivers the
build/runtime skeleton — Tailwind 4 + shadcn (Base UI) primitives, typed i18n (en/uk) with the
literal-string CI gate, the light/dark/system theme system, and the router shell with placeholder
pages. No features yet.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/shared test` → exit 0

## Tasks

1. Create `app/package.json` (name `@tavern/app`). Scripts pinned:
   `"dev": "vite"`, `"build": "vite build"`, `"typecheck": "tsc --noEmit"`,
   `"test": "vitest run"`, `"test:coverage": "vitest run --coverage"`.
   Install exact (R2): `pnpm -F @tavern/app add -E react@19.2.7 react-dom@19.2.7
   react-router@8.2.0 @tanstack/react-query@5.101.2 zustand@5.0.14
   sonner@2.0.7 react-hook-form@7.81.0 @hookform/resolvers@5.4.0` and
   `pnpm -F @tavern/app add @tavern/shared@workspace:*` and
   `pnpm -F @tavern/app add -DE vite@7 @vitejs/plugin-react@5.0.4 tailwindcss@4.3.2
   @tailwindcss/vite@4.3.2 @inlang/paraglide-js@2.21.0 @testing-library/react@16.3.2
   jsdom@29.1.1 @types/node@24.7.0 vitest@4.1.10 @vitest/coverage-istanbul@4.1.10`.
   (`@base-ui/react` + `frimousse` arrive via the shadcn CLI — verify versions match §3.3 after.)
2. `app/vite.config.ts` (pinned): plugins `[react(), tailwindcss(),
   paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide',
   strategy: ['localStorage', 'baseLocale'] })]` (import
   `{ paraglideVitePlugin } from '@inlang/paraglide-js'`); `server: { port: 5173,
   strictPort: true, proxy: { '/api': { target: 'http://localhost:8787', ws: true } } }`;
   `resolve.alias { '@': path.resolve(__dirname, './src') }`; `build.target 'es2022'`.
   The `@/*` alias goes in all three places (§3.3 trap — or `shadcn add` emits broken imports):
   `vite.config.ts` `resolve.alias`, `app/tsconfig.json`, and `app/tsconfig.node.json`.
   `app/tsconfig.json` (pinned; extends the base + adds what `.tsx` + DOM need):

   ```json
   {
     "extends": "../tsconfig.base.json",
     "compilerOptions": {
       "jsx": "react-jsx",
       "lib": ["ES2023", "DOM", "DOM.Iterable"],
       "types": ["vite/client", "node"],
       "paths": { "@/*": ["./src/*"] }
     },
     "include": ["src", "test"],
     "references": [{ "path": "./tsconfig.node.json" }]
   }
   ```

   `app/tsconfig.node.json` (pinned; type-checks `vite.config.ts` in a node context):

   ```json
   {
     "extends": "../tsconfig.base.json",
     "compilerOptions": { "types": ["node"], "paths": { "@/*": ["./src/*"] } },
     "include": ["vite.config.ts", "vitest.config.ts"]
   }
   ```
3. `app/index.html`: `<div id="root">`, `<script type="module" src="/src/theme-boot.ts">` FIRST,
   then `/src/main.tsx`; CSP meta pinned EXACTLY:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' http://localhost:8787 ws://localhost:8787 https://*.workers.dev wss://*.workers.dev; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'`
   (one string for dev+prod, pinned decision; WebRTC is not governed by `connect-src`).
   `src/theme-boot.ts` = tiny external module (inline scripts are CSP-blocked): reads
   `localStorage['tavern.theme']`, applies `.dark` to `<html>` (system → `matchMedia`).
4. `src/styles/app.css`: `@import "tailwindcss";` + `@custom-variant dark (&:where(.dark, .dark
   *));` + shadcn tokens + `#root { isolation: isolate }` + `body { position: relative }`
   (Base UI quick-start requirements). System font stack; NO tailwind.config.js (v4 CSS-first).
5. shadcn (Base UI — §3.6 traps 5–6): `pnpm dlx shadcn@latest init -b base` (answers if prompted:
   baseColor `neutral`, cssVariables `yes`), then `pnpm dlx shadcn@latest add button card input
   label dialog dropdown-menu select slider switch tabs tooltip popover context-menu scroll-area
   sonner` and `pnpm dlx shadcn@latest add https://frimousse.liveblocks.io/r/emoji-picker`.
   Commit `components.json` + `src/components/ui/*` (generated — exempt from size caps).
   Then run `pnpm dlx shadcn@latest mcp init --client claude` at repo root to register the shadcn
   MCP server project-wide (writes `.mcp.json`; standard registry needs no token — never hardcode
   one if a custom registry is added later, use `${VAR}` env placeholders). Commit `.mcp.json`.
   PLAN §0.2 R10 requires every later step touching `components/ui/*` to consult this MCP server
   (or the generated source) instead of writing Base UI markup from training-data memory.
6. i18n (FR-07, Paraglide — PLAN §9.6): run `npx @inlang/paraglide-js init` then pin
   `project.inlang/settings.json` to `{ "baseLocale": "en", "locales": ["en", "uk"] }` with the
   message-format plugin pointing at `messages/{locale}.json`. Seed `messages/en.json` +
   `messages/uk.json` with EXACTLY the keys in the table below: `boot_loading` plus one
   `error_<code>` key per `shared/src/errors.ts` code (all 31, en + uk). Feature steps add their
   own namespaced keys later and MUST NOT re-add any `error_<code>` key (they already exist here).
   Keys are FLAT snake_case (`m.boot_loading`), never nested, never bracket-accessed. Usage:
   `import { m } from '@/paraglide/messages.js'`. Locale switching:
   `setLocale(locale, { reload: false })` from `@/paraglide/runtime.js` + the settings store bumps
   a `localeVersion` counter consumed by the root component (`key` prop) to force re-render.
   Gitignore `src/paraglide/`; commit `project.inlang/` + `messages/`. Language default `en`
   (baseLocale fallback).

   | key | en | uk |
   |---|---|---|
   | boot_loading | Loading… | Завантаження… |
   | error_bad_message | That message couldn't be sent | Не вдалося надіслати повідомлення |
   | error_bad_request | Something went wrong with that request | Щось пішло не так із запитом |
   | error_invalid_ticket | Your session expired — reconnecting | Сесія завершилася — перепідключення |
   | error_unauthorized | Please sign in again | Будь ласка, увійдіть знову |
   | error_forbidden | You don't have permission to do that | У вас немає дозволу на цю дію |
   | error_not_found | No server with that nickname | Сервера з таким нікнеймом не існує |
   | error_not_member | You're not a member of this server | Ви не є учасником цього сервера |
   | error_not_admin | Only the server admin can do that | Це може зробити лише адміністратор сервера |
   | error_not_in_voice | You need to join voice first | Спершу приєднайтеся до голосового каналу |
   | error_not_implemented | That isn't available yet | Це поки недоступно |
   | error_voice_elsewhere | You're already in voice on another server | Ви вже в голосовому каналі на іншому сервері |
   | error_share_cap | Too many screens are being shared | Забагато демонстрацій екрана одночасно |
   | error_cost_cap | Voice and video are temporarily unavailable | Голос і відео тимчасово недоступні |
   | error_pull_denied | Couldn't start that stream | Не вдалося запустити трансляцію |
   | error_already_recording | A recording is already in progress | Запис уже триває |
   | error_rate_limited | Too many attempts — try again shortly | Забагато спроб — спробуйте трохи згодом |
   | error_rtc_rate_limited | Connecting too often — slow down | Занадто часте підключення — зачекайте |
   | error_invalid_credentials | Wrong username or password | Неправильний нікнейм або пароль |
   | error_username_taken | That username is taken | Цей нікнейм уже зайнятий |
   | error_nickname_taken | That server nickname is taken | Такий нікнейм сервера вже зайнятий |
   | error_wrong_password | Wrong server password | Неправильний пароль сервера |
   | error_password_mismatch | Passwords don't match | Паролі не збігаються |
   | error_password_too_short | At least 8 characters | Щонайменше 8 символів |
   | error_server_cap | You've reached the server limit | Ви досягли ліміту серверів |
   | error_payload_too_large | That file is too large | Файл завеликий |
   | error_unsupported_media | That file type isn't supported | Цей тип файлу не підтримується |
   | error_sound_too_long | That sound is too long | Звук задовгий |
   | error_bad_trim | Invalid trim range | Некоректний діапазон обрізки |
   | error_bad_part_size | Upload failed — try again | Помилка завантаження — спробуйте ще раз |
   | error_recording_too_long | The recording is too long | Запис задовгий |
   | error_server_full | This server is full | Цей сервер заповнений |

   (31 `error_*` keys = the 31 codes in `shared/src/errors.ts`. If S0.2's ERROR_CODES count and
   this table disagree, that is an R1 STOP — fix in lockstep, do not guess copy.)
7. Theme (FR-06): `src/stores/settings.ts` created here with ONLY `{ theme, locale }` slice
   (S4.3 extends this file); `applyTheme(theme)` toggles the `.dark` class + persists
   `localStorage['tavern.theme']`; `system` subscribes to
   `matchMedia('(prefers-color-scheme: dark)')` changes live.
8. `src/router.tsx`: react-router 8.2.0 in **data mode** — `createHashRouter` when `window.tavern`
   exists (desktop) else `createBrowserRouter` + `<RouterProvider>` (this is the pinned API; it
   supersedes PLAN §3.3's looser "declarative mode" wording — data mode is required for the lazy
   named-export routes below). Routes `/login`, `/register`, `/join`, `/s/:serverId`, index →
   redirect `/login`; placeholder pages with pinned test ids: `page-login`, `page-register`,
   `page-join`, `page-server`, plus `boot-loader` used by S4.3. Lazy routes use named exports
   (§9.3). `src/main.tsx` mounts RouterProvider + QueryClientProvider + `<Toaster/>` (sonner).
9. CI gates: `scripts/check-i18n-literals.mjs` (node script; imports the root devDep
   `oxc-parser@0.139.0` already installed by S0.1 — do NOT install it here): parses
   `app/src/**/*.tsx` (excluding `components/ui/`), fails on JSXText with letters and on string
   literals passed to props `title|label|placeholder|alt|aria-*`, minus lines listed in
   `scripts/i18n-allowlist.txt`. Add a root package.json script
   `"check:i18n": "node scripts/check-i18n-literals.mjs"` (every later step's `pnpm check:i18n`
   DoD resolves to this; en/uk key parity is enforced separately by `i18n-parity.test.ts`, not
   this script). Wire it as a step after `pnpm lint` in the `ci` job (S0.3's single `ci` job) + the
   two grep gates (DoD).

## Pinned interfaces & artifacts

- `Theme = 'light' | 'dark' | 'system'` and `Locale = 'en' | 'uk'` come from
  `shared/src/domain.ts` — do not redeclare.
- localStorage key (frozen): `tavern.theme`. Locale persistence is owned by paraglide's
  `strategy: ['localStorage','baseLocale']` (its own key) — this step defines no `tavern.locale`.
- Test ids (frozen, used by S4.4/S5+ e2e): `boot-loader`, `page-login`, `page-register`,
  `page-join`, `page-server`, `app-shell`.
- `app/vitest.config.ts` (pinned): jsdom environment, `include ['test/**/*.test.{ts,tsx}']`,
  `coverage: { provider: 'istanbul', include: ['src/**'], exclude: ['src/paraglide/**',
  'src/components/ui/**'], thresholds: { lines: 70 } }`.
- Files created: `app/` package per §4 skeleton (this step: `index.html`, `vite.config.ts`,
  `vitest.config.ts`, `tsconfig.json`, `tsconfig.node.json`,
  `src/{main.tsx,router.tsx,theme-boot.ts}`, `src/styles/app.css`, `project.inlang/settings.json`,
  `messages/{en,uk}.json`, `src/stores/settings.ts`, `src/components/ui/*` generated,
  `components.json`, `.mcp.json` (shadcn MCP server registration), `test/**` — the four test files below + fixtures
  `test/fixtures/literal-violation.tsx` and `test/fixtures/literal-clean.tsx`),
  `scripts/check-i18n-literals.mjs`, `scripts/i18n-allowlist.txt`; modified: root `package.json`
  (add `check:i18n` script), `.github/workflows/ci.yml` (add gates). `src/paraglide/` is
  GENERATED — gitignored.

## Tests

`app/test/` (vitest + jsdom + RTL):

- `theme.test.ts` — `describe('FR-06 theme')`: light↔dark class toggle; persistence;
  `system` follows a mocked `matchMedia` change event; boot module applies stored theme.
- `i18n-parity.test.ts` — `describe('FR-07 locale parity')`: read `messages/en.json` +
  `messages/uk.json`, assert identical key sets (both directions), every key matches
  `/^[a-z][a-z0-9_]*$/` (flat snake_case, §9.6), and each key exists as a function on the
  compiled `m` object.
- `check-literals.test.ts` — `describe('§9.6 literal gate self-test')`: runs the script against
  `app/test/fixtures/literal-violation.tsx` → exit 1; against `app/test/fixtures/literal-clean.tsx`
  → exit 0.
- `router.test.tsx` — `describe('§7.6 routes')`: renders at `/login` → `page-login` visible;
  unknown path redirects.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --coverage` → exit 0, line coverage ≥70%
- [ ] `pnpm -F @tavern/app build` → exit 0
- [ ] `! grep -rn "@radix-ui" app/src app/package.json` → exit 0 (zero Radix)
- [ ] `! grep -rn "@base-ui-components" app` → exit 0 (dead package name absent)
- [ ] `test -f .mcp.json && grep -q '"shadcn"' .mcp.json` → exit 0 (MCP server registered, R10)
- [ ] `node scripts/check-i18n-literals.mjs` → exit 0
- [ ] `pnpm typecheck && pnpm lint` → exit 0

## STOP conditions (beyond global R1)

- `shadcn init -b base` produces Radix imports or `@base-ui-components/react` anywhere → STOP
  (CLI regression — do not hand-patch imports).
- frimousse's peer range rejects react 19.2.7 at install → STOP (PLAN pins frimousse; the
  fallback swap is a human call).

## Docs (consult only these)

- https://ui.shadcn.com/docs/installation/vite (Base UI tab ONLY — §3.6 trap 6)
- https://ui.shadcn.com/docs/mcp (MCP server install/usage — PLAN §0.2 R10)
- https://base-ui.com/react/overview/quick-start (isolation/body requirements)
- https://tailwindcss.com/docs/dark-mode (v4 `@custom-variant`)
- https://paraglidejs.com/vite (setup) · https://paraglidejs.com/message-keys · https://paraglidejs.com/runtime
- https://reactrouter.com (v8 docs, declarative/data mode)
- https://frimousse.liveblocks.io/
