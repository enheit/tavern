import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ErrorCode } from "@tavern/shared";
import { createAuth } from "./auth";

export type AuthVars = {
  auth: ReturnType<typeof createAuth>;
  userId: string | null;
};

// Adds the resolved `serverId` that `requireMember` writes after a membership check passes; the
// member-scoped routes (GET /api/servers/:id/members, and every S3.x server sub-route) read it.
export type MemberVars = AuthVars & { serverId: string };

// Builds the per-request better-auth instance and resolves the session from the request headers.
// getSession reads BOTH a session cookie (web) and an `Authorization: Bearer <token>` header
// (Electron, via the bearer plugin) — one code path serves both transports (PLAN §3.4, A5).
export const withAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (
  c,
  next,
) => {
  const auth = createAuth(c.env);
  c.set("auth", auth);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("userId", session?.user.id ?? null);
  await next();
};

// Gate for authenticated routes: 401 when withAuth resolved no session.
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (
  c,
  next,
) => {
  if (c.get("userId") === null) {
    return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
  }
  await next();
};

// Member guard for `/api/servers/:id/*` (PLAN §6.1 "member" auth column). Runs standalone (it
// re-checks the session, so routes need only `requireMember`): 401 when unauthenticated, 404
// `not_found` when the server row is absent, 403 `not_member` when the caller has no membership
// row. On success it stashes the validated `serverId` for the handler (c.var.serverId).
export const requireMember: MiddlewareHandler<{ Bindings: Env; Variables: MemberVars }> = async (
  c,
  next,
) => {
  const userId = c.get("userId");
  if (userId === null) {
    return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
  }
  const serverId = c.req.param("id");
  if (serverId === undefined) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }
  const server = await c.env.DB.prepare("SELECT id FROM servers WHERE id = ?")
    .bind(serverId)
    .first();
  if (server === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }
  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
  )
    .bind(userId, serverId)
    .first();
  if (membership === null) {
    return c.json({ error: "not_member" satisfies ErrorCode }, 403);
  }
  c.set("serverId", serverId);
  await next();
};

// Admin guard for the `/api/servers/:id/*` admin ops (PLAN §6.1 "admin" auth column, S2.2 FR-10/11/12).
// Runs AFTER `requireMember` in the route chain — that middleware already 401/404/403-not_member'd and
// stashed `c.var.serverId`, so an outsider never reaches here (they get `not_member`). This adds the
// final rung: 403 `not_admin` unless the server's `admin_user_id` is the caller.
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: MemberVars }> = async (
  c,
  next,
) => {
  const userId = c.get("userId");
  const server = await c.env.DB.prepare("SELECT admin_user_id FROM servers WHERE id = ?")
    .bind(c.var.serverId)
    .first<{ admin_user_id: string }>();
  if (server === null || server.admin_user_id !== userId) {
    return c.json({ error: "not_admin" satisfies ErrorCode }, 403);
  }
  await next();
};

// zod body guard: 400 { error: 'bad_request' } on unparseable JSON or a schema mismatch; on success
// stashes the parsed value under `validatedBody` for the route (Hono memoizes c.req.json()).
export function zodJson<T extends z.ZodType>(schema: T): MiddlewareHandler {
  const guard: MiddlewareHandler<{ Variables: { validatedBody: z.infer<T> } }> = async (
    c,
    next,
  ) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
    }
    c.set("validatedBody", parsed.data);
    await next();
  };
  return guard;
}

// Recursively drop every `email` / `emailVerified` key from a decoded JSON body.
function stripEmailKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEmailKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "email" || key === "emailVerified") continue;
      out[key] = stripEmailKeys(v);
    }
    return out;
  }
  return value;
}

// The synthetic `${username}@users.tavern.invalid` email exists only to satisfy better-auth's schema
// and must never leave the server (PLAN §5.1). This post-response middleware deep-deletes email keys
// from any JSON body while preserving status + headers (set-auth-token / set-cookie must survive).
export const stripEmail: MiddlewareHandler = async (c, next) => {
  await next();
  const contentType = c.res.headers.get("content-type");
  if (contentType === null || !contentType.includes("application/json")) return;
  let parsed: unknown;
  try {
    parsed = await c.res.clone().json();
  } catch {
    return;
  }
  const headers = new Headers(c.res.headers);
  headers.delete("content-length"); // body length changes after stripping; let it recompute
  c.res = new Response(JSON.stringify(stripEmailKeys(parsed)), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};
