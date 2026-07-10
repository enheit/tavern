import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ErrorCode } from "@tavern/shared";
import { createAuth } from "./auth";

export type AuthVars = {
  auth: ReturnType<typeof createAuth>;
  userId: string | null;
};

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
