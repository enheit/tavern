import { Hono } from "hono";
import {
  CloudflareUsageResponse,
  LIMITS,
  Locale,
  PatchProfileRequest,
  Theme,
  UserSettings,
} from "@tavern/shared";
import type { ErrorCode, MeResponse, ServerSummary, UserProfile } from "@tavern/shared";
import { requireAuth, zodJson } from "../middleware";
import type { AuthVars } from "../middleware";
import { notifyJoinedServers } from "../lib/fanout";
import { recordMediaObject, trackMediaInventory } from "../lib/mediaUsageInventory";
import { readCloudflareUsage } from "../lib/cloudflareUsage";
import { voiceAvatarFromStorage, voiceAvatarToStorage } from "../lib/voiceAvatar";

// Non-null narrow without `!` (§9.1): a value the callers structurally guarantee (an authenticated
// session's user row, requireAuth's userId) but TypeScript still widens to nullable.
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

type UserRow = {
  id: string;
  username: string | null;
  display_name: string;
  color: string;
  avatar_key: string | null;
  voice_avatar: string | null;
};

type SettingsRow = {
  notify_all: number;
  notify_mentions: number;
  locale: string;
  theme: string;
};

// A joined-server row for the boot call — password_hash drives `hasPassword` but is NEVER returned.
type ServerSummaryRow = {
  id: string;
  nickname: string;
  admin_user_id: string;
  password_hash: string | null;
  created_at: number;
  joined_at: number;
};

// Every server the user has joined, oldest-first, as ServerSummary[] (FR-43 boot payload).
async function readJoinedServers(env: Env, userId: string): Promise<ServerSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.nickname, s.admin_user_id, s.password_hash, s.created_at, m.joined_at
     FROM memberships m JOIN servers s ON s.id = m.server_id
     WHERE m.user_id = ?
     ORDER BY m.joined_at ASC`,
  )
    .bind(userId)
    .all<ServerSummaryRow>();
  return rows.results.map((row) => ({
    id: row.id,
    nickname: row.nickname,
    adminUserId: row.admin_user_id,
    hasPassword: row.password_hash !== null,
    createdAt: row.created_at,
    joinedAt: row.joined_at,
  }));
}

// Reads the profile columns from the auth `user` row. NO `email` is ever selected — the synthetic
// address must never enter an API response (PLAN §5.1). avatarKey is omitted when NULL so the value
// matches UserProfile's optional field under exactOptionalPropertyTypes.
async function readProfile(env: Env, userId: string): Promise<UserProfile> {
  const row = invariant(
    await env.DB.prepare(
      "SELECT id, username, display_name, color, avatar_key, voice_avatar FROM user WHERE id = ?",
    )
      .bind(userId)
      .first<UserRow>(),
    "authenticated user row missing",
  );
  const username = invariant(row.username, "authenticated user has null username");
  return {
    userId: row.id,
    username,
    displayName: row.display_name,
    color: row.color,
    ...(row.avatar_key !== null ? { avatarKey: row.avatar_key } : {}),
    ...(row.voice_avatar !== null ? { voiceAvatar: voiceAvatarFromStorage(row.voice_avatar) } : {}),
  };
}

// Returns the stored settings, or the §5.1 DDL defaults WITHOUT inserting a row (the first PUT
// creates it). SQLite booleans are 0/1; locale/theme are re-validated at the storage boundary (§9.8).
async function readSettings(env: Env, userId: string): Promise<UserSettings> {
  const row = await env.DB.prepare(
    "SELECT notify_all, notify_mentions, locale, theme FROM user_settings WHERE user_id = ?",
  )
    .bind(userId)
    .first<SettingsRow>();
  if (row === null) {
    return { notifyAll: true, notifyMentions: true, locale: "en", theme: "system" };
  }
  return {
    notifyAll: row.notify_all !== 0,
    notifyMentions: row.notify_mentions !== 0,
    locale: Locale.parse(row.locale),
    theme: Theme.parse(row.theme),
  };
}

// A UNIQUE-constraint failure on the username OR the synthetic email (both moved together) means the
// requested username is already taken. Any other error is re-thrown (never swallowed, §9.5).
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

// RIFF....WEBP container magic: bytes 0–3 = "RIFF" (0x52 0x49 0x46 0x46) AND bytes 8–11 = "WEBP"
// (0x57 0x45 0x42 0x50). The 4-byte little-endian file size sits between (bytes 4–7, unchecked).
function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

export const meRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Every /api/me/* surface is session-gated (FR-43 boot call is authenticated).
meRoute.use("*", requireAuth);

// GET /api/me — the single boot call (FR-43): profile + settings + joined servers (S2.1 replaced
// the S1.3 `[]` stub with the memberships JOIN).
meRoute.get("/", async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  const [user, settings, servers] = await Promise.all([
    readProfile(c.env, userId),
    readSettings(c.env, userId),
    readJoinedServers(c.env, userId),
  ]);
  const body: MeResponse = { user, settings, servers };
  return c.json(body);
});

// Tavern-wide, aggregate-only Cloudflare resource usage. This reads the D1 cache, never calls
// Cloudflare from a user request and never exposes resource identifiers or provider errors.
meRoute.get("/cloudflare-usage", async (c) =>
  c.json(CloudflareUsageResponse.parse(await readCloudflareUsage(c.env))),
);

// PATCH /api/me/profile (FR-03/FR-04). zodJson(PatchProfileRequest) already rejected an empty object
// and every malformed field with 400 bad_request before this handler runs.
meRoute.patch("/profile", zodJson(PatchProfileRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  // zodJson validated the body (400 on failure); re-derive the typed value — Hono memoizes
  // c.req.json(), so this re-parses the cached object, not the request stream.
  const patch = PatchProfileRequest.parse(await c.req.json());

  // Username change first, so a 409 short-circuits before any other column is touched. Usernames are
  // lowercase-only by regex, so `username` and `displayUsername` carry the same value; the synthetic
  // email moves in the SAME batch to preserve the login identity (login resolves by username → the
  // credential account by userId, so the password survives the rename; PLAN §5.1).
  if (patch.username !== undefined) {
    const email = `${patch.username}@users.tavern.invalid`;
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE user SET username = ?, display_username = ?, email = ? WHERE id = ?",
        ).bind(patch.username, patch.username, email, userId),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "username_taken" satisfies ErrorCode }, 409);
      }
      throw err;
    }
  }

  // displayName is an input:true additionalField → auth.api.updateUser accepts it (PLAN §5.1).
  if (patch.displayName !== undefined) {
    await c.var.auth.api.updateUser({
      body: { displayName: patch.displayName },
      headers: c.req.raw.headers,
    });
  }

  // DEVIATION (recorded in progress.md): `color` is an input:false additionalField in the pinned
  // S1.2 auth config (unmodifiable in this step), so auth.api.updateUser REJECTS it with
  // "color is not allowed to be set" (better-auth parseUserInput). Persist the column directly —
  // a mechanism-only change with an identical product outcome (FR-04).
  if (patch.color !== undefined) {
    await c.env.DB.prepare("UPDATE user SET color = ? WHERE id = ?")
      .bind(patch.color, userId)
      .run();
  }

  if (patch.voiceAvatar !== undefined) {
    await c.env.DB.prepare("UPDATE user SET voice_avatar = ? WHERE id = ?")
      .bind(voiceAvatarToStorage(patch.voiceAvatar), userId)
      .run();
  }

  // FR-03/FR-04 live propagation: push the updated profile to every joined server's DO. Background
  // (ctx.waitUntil) so the PATCH response is not blocked on fan-out; the DO handler lands in S3.1.
  const profile = await readProfile(c.env, userId);
  c.executionCtx.waitUntil(notifyJoinedServers(c.env, userId, { t: "member.update", profile }));
  return c.json(profile);
});

// POST /api/me/avatar (FR-05): raw webp bytes → R2 at the LAW key `avatars/{userId}.webp` (PLAN §5.3).
meRoute.post("/avatar", async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");

  const contentType = c.req.header("content-type");
  if (contentType === undefined || !contentType.includes("image/webp")) {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }

  const declaredLength = c.req.header("content-length");
  if (declaredLength !== undefined && Number(declaredLength) > LIMITS.avatarMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > LIMITS.avatarMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }
  if (!isWebp(bytes)) {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }

  const avatarKey = `avatars/${userId}.webp`;
  const object = await c.env.MEDIA.put(avatarKey, bytes, {
    httpMetadata: { contentType: "image/webp" },
  });
  c.executionCtx.waitUntil(
    trackMediaInventory(recordMediaObject(c.env.DB, object), "put", avatarKey),
  );
  // avatarKey is an input:false additionalField (see the color DEVIATION note above), so it is set on
  // the user row directly rather than via auth.api.updateUser.
  await c.env.DB.prepare("UPDATE user SET avatar_key = ? WHERE id = ?")
    .bind(avatarKey, userId)
    .run();
  // FR-05 live propagation: fan the new avatar out to joined servers' DOs (same seam as profile).
  const profile = await readProfile(c.env, userId);
  c.executionCtx.waitUntil(notifyJoinedServers(c.env, userId, { t: "member.update", profile }));
  return c.json({ avatarKey });
});

// GET /api/me/settings (FR-06/FR-07/FR-16): defaults when no row exists (no insert).
meRoute.get("/settings", async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  return c.json(await readSettings(c.env, userId));
});

// PUT /api/me/settings: full-row upsert — all four fields required (zodJson(UserSettings) rejects a
// partial body with 400 bad_request). The first PUT creates the row that GET's defaults stood in for.
meRoute.put("/settings", zodJson(UserSettings), async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  const settings = UserSettings.parse(await c.req.json());
  await c.env.DB.prepare(
    `INSERT INTO user_settings (user_id, notify_all, notify_mentions, locale, theme)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       notify_all = excluded.notify_all,
       notify_mentions = excluded.notify_mentions,
       locale = excluded.locale,
       theme = excluded.theme`,
  )
    .bind(
      userId,
      settings.notifyAll ? 1 : 0,
      settings.notifyMentions ? 1 : 0,
      settings.locale,
      settings.theme,
    )
    .run();
  return c.json(settings);
});
