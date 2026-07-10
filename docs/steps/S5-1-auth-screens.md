# S5.1 — Auth screens & session flow

- after: S1.3, S4.4
- unlocks: S5.2
- FRs: FR-01, FR-02 (login→boot wiring feeds FR-43)
- references: PLAN §1.1, §2 (A5), §3.3, §4, §6.1, §9, §10, §App-B

## Goal

Login and Register screens wired to the Worker's auth endpoints, with token/cookie session
handling through `authTransport`, so a user can register, log in, stay logged in across restarts,
and log out. No profile editing here (that is S6.2).

## Preconditions (run these; red = STOP)

- `grep -q "^## S1.3" docs/progress.md && grep -q "^## S4.4" docs/progress.md` → exit 0
- `pnpm -F @tavern/worker test -- --run` → exit 0
- `pnpm -F @tavern/e2e exec playwright test --project=web web/smoke.spec.ts` → exit 0

## Tasks

1. Import the shared form schemas `RegisterForm` (`{ username, password, repeatPassword }` with
   equality refine) and `LoginForm` (`{ username, password }`) from `@tavern/shared` (rules per
   §App-B). Do NOT redeclare schemas in the app. Client-side zod messages are machine codes
   (`username_invalid`, `password_too_short`, `password_mismatch`); the form maps each to a
   message with a STATIC `m.*()` call per field — no dynamic key construction (§9.6):
   `username_invalid → m.error_username_invalid()`, `password_too_short → m.error_password_too_short()`,
   `password_mismatch → m.error_password_mismatch()`. Server `ErrorCode`s render in the form-level
   slot via `errorMessage(code)` (the S4.3 resolver). Note `password_too_short`/`password_mismatch`
   are real `ErrorCode`s whose copy is already seeded by S4.2 (`error_password_*`); this step only
   adds the two non-`ErrorCode` client keys `error_username_invalid` and `error_network`.
2. Create `app/src/features/auth/useAuth.ts`:
   ```ts
   export function useAuth(): {
     register(input: RegisterForm): Promise<void>;    // POST /api/auth-wrap/register, then login()
     login(input: LoginForm): Promise<void>;          // POST /api/auth/sign-in/username
     logout(): Promise<void>;                          // POST /api/auth/sign-out
     pending: boolean;
     error: ErrorCode | null;
   }
   ```
   Pinned flows — `login`: on 2xx call `authTransport.storeFromResponse(res.headers)` (desktop
   reads the `set-auth-token` header; web is a no-op — cookie already set), then
   `bootStore.restart()` and navigate `/`. `logout`: POST sign-out → `authTransport.clear()` →
   `bootStore.reset()` → navigate `/login`. `register`: POST wrapper (success body ignored) →
   chain `login()` with the same credentials.
   NO better-auth client library in the renderer — plain `apiClient` calls only (pinned).
3. Create `app/src/features/auth/LoginPage.tsx` and `RegisterPage.tsx`: shadcn `Card`, `Input`,
   `Label`, `Button`; RHF `useForm` + `zodResolver`; inline field errors; a single form-level
   error slot for server `ErrorCode`s. Username inputs normalize `toLowerCase()` on change.
   Autocomplete pinned: login → `username` / `current-password`; register → `username` /
   `new-password` / `new-password`. Cross-links between the two pages.
4. Register routes `/login` and `/register` in `app/src/router.tsx` (public; the boot gate from
   S4.3 redirects authed users away from them to `/`).
5. Add i18n keys to `app/messages/en.json` AND `app/messages/uk.json` (both, same keys — parity
   test enforces). Keys are FLAT snake_case (§9.6). Add ONLY the rows below: the `auth_*` UI
   strings plus the two client-side codes `error_username_invalid` / `error_network` that are NOT
   in `ERROR_CODES`. Do NOT add `error_password_too_short`, `error_password_mismatch`,
   `error_username_taken`, or `error_invalid_credentials` — those are `error_<code>` keys already
   seeded by S4.2 (the parity/duplicate check will flag a re-add).

   | key | en | uk |
   |---|---|---|
   | auth_login_title | Sign in to Tavern | Вхід до Tavern |
   | auth_login_username | Username | Нікнейм |
   | auth_login_password | Password | Пароль |
   | auth_login_submit | Sign in | Увійти |
   | auth_login_no_account | No account? | Немає акаунта? |
   | auth_login_register_link | Create one | Створити |
   | auth_register_title | Create your account | Створення акаунта |
   | auth_register_repeat_password | Repeat password | Повторіть пароль |
   | auth_register_submit | Create account | Створити акаунт |
   | auth_register_have_account | Already have an account? | Вже маєте акаунт? |
   | auth_register_login_link | Sign in | Увійти |
   | error_username_invalid | 3–20 characters: a–z, 0–9, _ | 3–20 символів: a–z, 0–9, _ |
   | error_network | Connection failed — try again | Помилка з'єднання — спробуйте ще раз |

## Pinned interfaces & artifacts

Files created: `app/src/features/auth/{LoginPage.tsx,RegisterPage.tsx,useAuth.ts}` + colocated
tests, `e2e/web/auth.spec.ts` (new). Files modified: `app/src/router.tsx`,
`app/messages/{en,uk}.json`.

Contracts consumed verbatim (do not adapt them — mismatches are STOPs):
- `POST /api/auth-wrap/register` body `{ username, password, repeatPassword }` → 200 on success
  (S1.2 returns better-auth's signup JSON verbatim; this step IGNORES the body — `register` chains
  straight into `login()`) | 4xx `{ error: ErrorCode }` (S1.2).
- `POST /api/auth/sign-in/username` body `{ username, password }` → 200 with `set-auth-token`
  response header (bearer plugin) | 401 → render `errorMessage('invalid_credentials')` (generic —
  FR-02 forbids user enumeration).
- `authTransport.storeFromResponse(headers: Headers): Promise<void>` and `.clear()` from S4.3
  (call `storeFromResponse(res.headers)`).
- `bootStore.restart(): void`, `bootStore.reset(): void` from S4.3.

## Tests

- `app/src/features/auth/RegisterPage.test.tsx` — `describe('FR-01 register form')`:
  1. `shows m.error_username_invalid for "ab"`
  2. `shows m.error_password_too_short for 7-char password`
  3. `shows m.error_password_mismatch when repeat differs`
  4. `lowercases username input and submits full payload to useAuth.register`
  5. `renders m.error_username_taken when register rejects with that code`
- `app/src/features/auth/LoginPage.test.tsx` — `describe('FR-02 login form')`:
  1. `submits credentials to useAuth.login`
  2. `shows errorMessage('invalid_credentials') on 401 without naming the wrong field`
  3. `has pinned autocomplete attributes`
- `app/src/features/auth/useAuth.test.ts` — `describe('FR-02 session flow')` (apiClient +
  authTransport + bootStore mocked):
  1. `login stores token from response and restarts boot`
  2. `logout clears transport, resets boot, navigates /login`
  3. `register chains into login with same credentials`
- `e2e/web/auth.spec.ts` — `describe('FR-01 FR-02 auth')`:
  1. `register lands on /join (first run, no servers)`
  2. `reload restores session without re-login`
  3. `logout returns to /login`
  4. `wrong password shows generic error and stays on /login`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --run --coverage` → exit 0 (thresholds from config: app ≥70%)
- [ ] `pnpm -F @tavern/e2e exec playwright test --project=web web/auth.spec.ts` → all passed
- [ ] `pnpm typecheck` → exit 0
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm check:i18n` → exit 0 (no JSX literals — script defined in S4.2; en/uk key parity is
      covered by the app coverage gate's `i18n-parity.test.ts`)

## STOP conditions (beyond global R1)

- `set-auth-token` header missing on a successful sign-in response → S1.2 bearer config broke;
  do NOT fall back to scraping cookies on desktop.
- `POST /api/auth-wrap/register` returns 404 → S1.2/S1.3 contract drift.
- Shared schema field shapes differ from the ones listed in Task 1.

## Docs (consult only these)

- https://www.better-auth.com/docs/plugins/bearer (header name semantics)
- https://react-hook-form.com/docs/useform + https://github.com/react-hook-form/resolvers (zodResolver)
- https://reactrouter.com/ (v8 declarative routes)
