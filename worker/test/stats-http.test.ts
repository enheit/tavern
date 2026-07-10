import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MeResponse, StatsResponse } from "@tavern/shared";

const BASE = "https://tavern.test";

// Typed stub so runInDurableObject infers the ServerRoom instance (its O must extend DurableObject).
type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Register a fresh account (register replies with set-auth-token, so no rate-limited sign-in is
// needed) and return its bearer token.
async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function meUserId(token: string): Promise<string> {
  const body = MeResponse.parse(await (await authed(token, "/api/me")).json());
  return body.user.userId;
}

async function createServer(token: string, nickname: string): Promise<string> {
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

describe("FR-40 stats endpoint", () => {
  it("returns the server-authoritative snapshot: message counts + stream/watch seconds", async () => {
    const token = await register("statsowner");
    const ownerId = await meUserId(token);
    const serverId = await createServer(token, "statsroom");
    const streamerId = crypto.randomUUID();

    // Seed the DO's own tables directly: 3 chat rows by the owner + accumulated stat rows.
    const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < 3; i += 1) {
        sql.exec(
          `INSERT INTO messages (channel_id, user_id, body, mentions, created_at)
           VALUES ('main', ?, ?, '[]', ?)`,
          ownerId,
          `msg ${i}`,
          Date.now() + i,
        );
      }
      sql.exec(`INSERT INTO stat_stream_seconds (user_id, seconds) VALUES (?, ?)`, ownerId, 120);
      sql.exec(
        `INSERT INTO stat_watch_seconds (viewer_id, streamer_id, seconds) VALUES (?, ?, ?)`,
        ownerId,
        streamerId,
        300,
      );
    });

    const res = await authed(token, `/api/servers/${serverId}/stats`);
    expect(res.status).toBe(200);
    const stats = StatsResponse.parse(await res.json());

    const owner = must(
      stats.perUser.find((p) => p.userId === ownerId),
      "owner should appear in perUser (member cache ∪ stat rows)",
    );
    expect(owner.messages).toBe(3);
    expect(owner.streamSeconds).toBe(120);

    expect(stats.watchPairs).toContainEqual({
      viewerId: ownerId,
      streamerId,
      seconds: 300,
    });
  });

  it("denies a non-member with 403", async () => {
    const owner = await register("statsowner2");
    const serverId = await createServer(owner, "statsroom2");

    const outsider = await register("statsoutsider");
    const res = await authed(outsider, `/api/servers/${serverId}/stats`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});
