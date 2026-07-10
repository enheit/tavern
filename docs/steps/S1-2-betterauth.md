# S1.2 — BetterAuth: register / login / bearer sessions

- after: S1.1
- unlocks: S1.3
- FRs: FR-01, FR-02
- references: PLAN §3.4 (all pinned BetterAuth facts), §3.6 items 4+7, §5.1, §6.1, App-B

## Goal

Username+password auth on Workers+D1 via better-auth 1.6.23: register (with server-side
repeatPassword check and the synthetic email), login, sessions usable via cookie (web) AND bearer
token (Electron), brute-force rate limiting persisted in D1. The `email` value never leaves the
server.

## Preconditions (run these; red = STOP)

- `grep -q "^## S1.1" docs/progress.md` → exit 0
- `pnpm --filter @tavern/worker test` → exit 0

## Tasks (numbered, imperative, zero alternatives)

1. Install: `pnpm --filter @tavern/worker add -E better-auth@1.6.23 drizzle-orm@0.45.2` and
   `pnpm --filter @tavern/worker add -DE drizzle-kit@0.31.10`.
2. Create `worker/src/auth.ts` — per-request factory (NEVER module scope; §3.4):

   ```ts
   export function createAuth(env: Env): ReturnType<typeof betterAuth>
   ```

   Pinned options inside: `database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite' })`;
   `secret: env.BETTER_AUTH_SECRET`; `emailAndPassword: { enabled: true, minPasswordLength: 8 }`;
   `user.additionalFields`: `displayName` (string, required, input allowed), `color` (string,
   default `'#e0e0e0'`, input NOT allowed at signup), `avatarKey` (string, optional, input NOT
   allowed);
   `plugins: [username({ minUsernameLength: 3, maxUsernameLength: 20, usernameValidator:
   (u) => /^[a-z0-9_]+$/.test(u) }), bearer()]`;
   `rateLimit: { enabled: true, storage: 'database', customRules: { '/sign-in/username':
   { window: 10, max: 3 }, '/sign-up/email': { window: 60, max: 5 } } }`;
   `trustedOrigins: ['app://tavern', 'http://localhost:5173']`;
   `session`: defaults (7d expiresIn / 1d updateAge) — do not override.
3. Create `worker/auth-cli.config.ts` — static config for the schema generator only (same
   plugins/additionalFields as task 2, dummy adapter, no `env` access; §3.4: the CLI cannot load
   the per-request factory). Generate the schema:
   - `cd worker && npx auth@latest generate --config ./auth-cli.config.ts --output ./src/db/auth-schema.ts`
     (`auth@latest` is the renamed CLI — NEVER `@better-auth/cli`, §3.6 item 4)
   - Create `worker/drizzle.config.ts`: `dialect: 'sqlite'`, `schema: './src/db/auth-schema.ts'`,
     `out: './migrations'`.
   - `cd worker && npx drizzle-kit generate` → produces migration `0000_*.sql` (auth tables incl.
     `rateLimit`; the `migrations/` dir holds only `.gitkeep` from S1.1, so drizzle-kit assigns the
     `0000_` prefix — the name suffix is a random adjective_noun, hence the `*`).
   - `pnpm --filter @tavern/worker run migrate:local` → applies locally.
   - `pnpm --filter @tavern/worker run migrate:remote` → applies to the real `tavern-db`.
4. Create `worker/src/middleware.ts`:

   ```ts
   type AuthVars = { auth: ReturnType<typeof createAuth>; userId: string | null }
   export const withAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }>
   export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }>
   export function zodJson<T extends z.ZodType>(schema: T): MiddlewareHandler // 400 {error:'bad_request'} on parse fail
   ```

   `withAuth` builds `createAuth(env)` once per request and resolves the session via
   `auth.api.getSession({ headers: c.req.raw.headers })` (works for cookie AND bearer).
   `requireAuth` → `401 { error: 'unauthorized' }` when `userId` is null.
5. Mount in `worker/src/index.ts`:
   `app.use('/api/*', withAuth)` then
   `app.on(['GET', 'POST'], '/api/auth/*', (c) => c.var.auth.handler(c.req.raw))`.
   Implement the email-stripper as a standalone function and apply it via middleware mounted on
   BOTH `app.use('/api/auth/*', …)` and `app.use('/api/auth-wrap/*', …)` (the register wrapper in
   task 6 lives under `/api/auth-wrap/*`, which the `/api/auth/*` glob does NOT match): for any
   response with `content-type: application/json`, deep-delete every `email` and `emailVerified`
   key from the body before returning (PLAN §5.1: the synthetic email never appears in any response).
6. Create `worker/src/routes/register.ts` — `POST /api/auth-wrap/register`, zod body
   `RegisterForm` from `@tavern/shared` (S0.2's api.ts name; there is no `RegisterRequest`)
   (`username` per App-B regex, `password` min 8 max 128,
   `repeatPassword`; `.refine(password === repeatPassword)` → `400 { error: 'password_mismatch' }`
   — server-side, not client-only). Handler composes `email = username +
   '@users.tavern.invalid'`, calls `auth.api.signUpEmail({ body: { email, password,
   name: username, username, displayName: username }, asResponse: true })` and returns that
   Response verbatim (so `set-auth-token` / `set-cookie` headers flow), then passes through the
   task-5 email-stripper. Duplicate username → `409 { error: 'username_taken' }` (map
   better-auth's error), short password → `400 { error: 'password_too_short' }`.
7. Note in code where post-response work happens: better-auth background work must run through
   `ctx.waitUntil` — pass Hono's `c.executionCtx` where the better-auth handler accepts a context
   (§3.4). Login has NO wrapper: clients call better-auth's own
   `POST /api/auth/sign-in/username` directly.
8. Write tests, run DoD, append the §0.3 progress entry.

## Pinned interfaces & artifacts

- Files created: `worker/src/auth.ts`, `worker/auth-cli.config.ts`, `worker/drizzle.config.ts`,
  `worker/src/db/auth-schema.ts` (generated), `worker/migrations/0000_*.sql` (generated),
  `worker/src/middleware.ts`, `worker/src/routes/register.ts`, `worker/test/auth.test.ts`.
- Modified: `worker/src/index.ts`, `worker/package.json`.
- Dependents rely on: `withAuth`/`requireAuth`/`zodJson` exact exports; `c.var.userId`;
  register endpoint path `/api/auth-wrap/register`; login path `/api/auth/sign-in/username`;
  bearer token delivered in the `set-auth-token` response header (client captures it — S5.1);
  ErrorCodes used: `unauthorized`, `bad_request`, `password_mismatch`, `password_too_short`,
  `username_taken`, `invalid_credentials`, `rate_limited` (all must exist in shared `errors.ts`).
- Generated auth migrations are never hand-edited (PLAN §5.1).

## Tests

`worker/test/auth.test.ts` (pool-workers; migrations applied by `test/setup.ts`):

- `describe('FR-01 register')`:
  - `creates account and returns set-auth-token header`
  - `duplicate username → 409 username_taken`
  - `password shorter than 8 → 400 password_too_short`
  - `repeatPassword mismatch → 400 password_mismatch (server-side)`
  - `username failing /^[a-z0-9_]{3,20}$/ → 400 bad_request`
  - `no email field is accepted or returned; response JSON contains no "@users.tavern.invalid"`
- `describe('FR-02 login')`:
  - `valid credentials → 200 + set-auth-token header`
  - `wrong password → 401-class generic invalid credentials (no user enumeration: same body for unknown username)`
  - `bearer token authorizes a requireAuth route`
  - `cookie session authorizes a requireAuth route`
  - `getSession round-trip returns userId + username + displayName, never email`
- `describe('FR-02 brute force')`:
  - `4th sign-in attempt within 10s → 429 rate_limited` (rateLimit storage=database — assert the
    counter persists via a second isolate call)

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/worker test` → all green, coverage lines ≥80%, exit 0
- [ ] `grep -rn "users.tavern.invalid" app/ shared/ 2>/dev/null | wc -l` → `0` (the synthetic
      email is a worker-only concept)
- [ ] `pnpm -w lint && pnpm -w typecheck` → exit 0

## STOP conditions (beyond global R1)

- `npx auth@latest generate` output does not include a `rateLimit` table or the
  `username`/`displayUsername` columns (plugin/CLI drift).
- better-auth rejects any pinned option key at runtime under workerd.
- The email-stripping middleware would have to remove any OTHER field to pass tests.

## Docs (consult only these)

- https://www.better-auth.com/docs/installation
- https://www.better-auth.com/docs/authentication/email-password
- https://www.better-auth.com/docs/plugins/username
- https://www.better-auth.com/docs/plugins/bearer
- https://www.better-auth.com/docs/concepts/cli
- https://www.better-auth.com/docs/concepts/rate-limit
- https://www.better-auth.com/docs/concepts/session-management
- https://github.com/better-auth/better-auth/tree/main/e2e/smoke/test/fixtures/cloudflare
- https://orm.drizzle.team/docs/connect-cloudflare-d1
