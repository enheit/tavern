import { defineConfig } from "drizzle-kit";

// drizzle-kit reads the generated better-auth schema and emits D1 SQL migrations into ./migrations
// (applied with `wrangler d1 migrations apply`, PLAN §3.4 — the auth CLI's own migrate cannot target D1).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/auth-schema.ts",
  out: "./migrations",
});
