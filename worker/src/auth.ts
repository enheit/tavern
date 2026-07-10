import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, username } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/auth-schema";

// Per-request factory — NEVER module scope (PLAN §3.4): the D1 binding lives on `env`, which only
// exists per request under workerd. Each request builds a fresh instance bound to that request's DB.
//
// The generated drizzle schema is passed to drizzle() so `db._.fullSchema` is populated: better-auth's
// drizzle adapter (v1.6.23) resolves tables via `config.schema || db._.fullSchema` and throws
// "Schema not found" otherwise — the pinned bare `drizzle(env.DB)` cannot work without it.
//
// Return type is inferred (not the pinned `ReturnType<typeof betterAuth>`): under
// exactOptionalPropertyTypes the concrete Auth<withPlugins> is not assignable to the widened
// Auth<BetterAuthOptions> (its signUpEmail body requires displayName — contravariant mismatch).
// Inference yields the precise instance type, which is what dependents want via ReturnType<typeof createAuth>.
export function createAuth(env: Env) {
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite" }),
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    user: {
      additionalFields: {
        displayName: { type: "string", required: true, input: true },
        color: { type: "string", input: false, defaultValue: "#e0e0e0" },
        avatarKey: { type: "string", required: false, input: false },
      },
    },
    // The shared contract (S0.2 `UserProfile.userId = z.uuid()`, and the UUID id-space every
    // downstream schema uses — MembersResponse, the member.update fan-out, the DO member cache)
    // requires better-auth's generated ids to be UUIDs. Without this, ids are a 32-char alphanumeric
    // and `MeResponse.parse` (and every UserProfile boundary) rejects them. Native support:
    // create-context resolves `advanced.database.generateId === "uuid"` to `crypto.randomUUID()`.
    advanced: { database: { generateId: "uuid" } },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 20,
        usernameValidator: (u) => /^[a-z0-9_]+$/.test(u),
      }),
      bearer(),
    ],
    // Default in-memory rate-limit storage is per-isolate = useless on Workers; persist in D1.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/username": { window: 10, max: 3 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    trustedOrigins: ["app://tavern", "http://localhost:5173"],
    // session left at defaults (7d expiresIn / 1d updateAge) — do not override (PLAN §3.4/step task 2).
  });
}
