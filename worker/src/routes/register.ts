import { Hono } from "hono";
import { z } from "zod";
import { RegisterForm } from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";

// Maps RegisterForm's zod issues to specific ErrorCodes (server-side, not client-only): the shared
// schema checks the username regex, the password min length, and password===repeatPassword.
function mapRegisterError(error: z.ZodError): ErrorCode {
  for (const issue of error.issues) {
    if (issue.message === "password_mismatch") return "password_mismatch";
  }
  for (const issue of error.issues) {
    if (issue.path[0] === "password") return "password_too_short";
  }
  return "bad_request";
}

// Reads the better-auth error code from a `{ code, message }` object — the shape of both a thrown
// APIError's `.body` and a non-ok signUpEmail Response body.
function extractCode(value: unknown): string | null {
  if (value !== null && typeof value === "object" && "code" in value) {
    const { code } = value;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function apiErrorCode(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "body" in err) {
    return extractCode(err.body);
  }
  return null;
}

async function responseErrorCode(res: Response): Promise<string | null> {
  try {
    return extractCode(await res.clone().json());
  } catch {
    return null;
  }
}

// Maps a better-auth error code to our typed response. Duplicate username surfaces as either
// USERNAME_IS_ALREADY_TAKEN (username plugin create hook) or USER_ALREADY_EXISTS (email uniqueness).
function mapAuthError(code: string | null): { error: ErrorCode; status: 400 | 409 } {
  if (code === "USERNAME_IS_ALREADY_TAKEN" || code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return { error: "username_taken", status: 409 };
  }
  if (code === "PASSWORD_TOO_SHORT") {
    return { error: "password_too_short", status: 400 };
  }
  return { error: "bad_request", status: 400 };
}

// FR-01 register wrapper. There is no email-free signup in better-auth (upstream #5896), so we
// synthesize `${username}@users.tavern.invalid` server-side and never surface it (the stripEmail
// middleware on /api/auth-wrap/* removes it from the response). Login has NO wrapper — clients call
// better-auth's own POST /api/auth/sign-in/username directly.
export const registerRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

registerRoute.post("/register", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  const parsed = RegisterForm.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: mapRegisterError(parsed.error) }, 400);
  }

  const { username, password } = parsed.data;
  const email = `${username}@users.tavern.invalid`;
  // Built as a separate object (not an inline literal) so the extra username/displayName fields the
  // username plugin + additionalFields accept type-check against the precise signUpEmail body.
  const body = { email, password, name: username, username, displayName: username };

  // asResponse:true returns the raw Response verbatim so better-auth's set-auth-token / set-cookie
  // headers flow through. A duplicate is THROWN as an APIError (username plugin create hook), while
  // other failures may be returned as a non-ok Response — handle both, and re-throw anything
  // uncoded (a real server fault) rather than swallowing it (§9.5).
  let res: Response;
  try {
    res = await c.var.auth.api.signUpEmail({ body, asResponse: true });
  } catch (err) {
    const code = apiErrorCode(err);
    if (code === null) throw err;
    const mapped = mapAuthError(code);
    return c.json({ error: mapped.error }, mapped.status);
  }

  if (res.ok) return res; // stripEmail middleware removes the synthetic email keys

  const mapped = mapAuthError(await responseErrorCode(res));
  return c.json({ error: mapped.error }, mapped.status);
});
