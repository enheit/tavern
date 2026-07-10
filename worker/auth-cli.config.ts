// STATIC config consumed ONLY by `npx auth@latest generate` (the schema pipeline, PLAN §3.4).
// The real per-request instance lives in src/auth.ts and reads env.DB — but the CLI runs in Node
// with no Worker env, so it cannot load that factory. This file mirrors task 2's plugins +
// additionalFields exactly and wires a throwaway D1 stub: the generator only reads the adapter
// `provider` plus the plugin/field schema, never issuing a query, so the stub is never called.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, username } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";

// Never invoked during schema generation; present only so drizzle()/drizzleAdapter() construct.
const stubD1 = {
  prepare() {
    throw new Error("auth-cli.config stub: schema generation must not query the database");
  },
};

export const auth = betterAuth({
  database: drizzleAdapter(drizzle(stubD1), { provider: "sqlite" }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  user: {
    additionalFields: {
      displayName: { type: "string", required: true, input: true },
      color: { type: "string", input: false, defaultValue: "#e0e0e0" },
      avatarKey: { type: "string", required: false, input: false },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      usernameValidator: (u) => /^[a-z0-9_]+$/.test(u),
    }),
    bearer(),
  ],
  // storage:"database" is what makes the generator emit the `rateLimit` table (get-tables.mjs:
  // shouldAddRateLimitTable = rateLimit?.storage === "database"); required by this step's schema.
  rateLimit: {
    enabled: true,
    storage: "database",
    customRules: {
      "/sign-in/username": { window: 10, max: 3 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
});
