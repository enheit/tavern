import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActivityPage } from "@tavern/shared";
import { ActivityModule } from "../src/do/activity";

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

// Clears the server-create `member.join` entry and seeds exactly `count` fresh rows through the real
// ActivityModule (ids strictly increasing via AUTOINCREMENT; created_at strictly increasing).
async function seedActivity(serverId: string, count: number): Promise<void> {
  const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM activity`);
    const activity = new ActivityModule(state.storage.sql);
    const base = Date.now();
    for (let i = 0; i < count; i += 1) {
      activity.append("member.join", crypto.randomUUID(), {}, base + i);
    }
  });
}

describe("FR-39 activity read", () => {
  it("paginates newest-first: page 1 = 50 hasMore, page 2 via before = 5 no more", async () => {
    const token = await register("activityreader");
    const serverId = await createServer(token, "activityroom");
    await seedActivity(serverId, 55);

    const res1 = await authed(token, `/api/servers/${serverId}/activity?limit=50`);
    expect(res1.status).toBe(200);
    const page1 = ActivityPage.parse(await res1.json());
    expect(page1.entries).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    // Entries are oldest→newest within the page, so entries[0] is the oldest of the newest 50.
    const before = must(page1.entries[0], "first entry").id;

    const res2 = await authed(token, `/api/servers/${serverId}/activity?before=${before}&limit=50`);
    expect(res2.status).toBe(200);
    const page2 = ActivityPage.parse(await res2.json());
    expect(page2.entries).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
    // The two pages together are the full, non-overlapping 55-row log (ids strictly ascending).
    const ids = [...page2.entries, ...page1.entries].map((e) => e.id);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
    expect(ids.toSorted((x, y) => x - y)).toEqual(ids);
  });

  it("defaults the limit to the page size when omitted", async () => {
    const token = await register("activitydefault");
    const serverId = await createServer(token, "activitydefaultroom");
    await seedActivity(serverId, 55);

    const res = await authed(token, `/api/servers/${serverId}/activity`);
    expect(res.status).toBe(200);
    const page = ActivityPage.parse(await res.json());
    expect(page.entries).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  it("rejects a non-numeric pagination query with 400 bad_request", async () => {
    const token = await register("activitybadq");
    const serverId = await createServer(token, "activitybadqroom");

    const res = await authed(token, `/api/servers/${serverId}/activity?limit=abc`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("a non-member is denied with 403", async () => {
    const owner = await register("activityowner");
    const serverId = await createServer(owner, "activityownerroom");
    await seedActivity(serverId, 3);

    const outsider = await register("activityoutsider");
    const res = await authed(outsider, `/api/servers/${serverId}/activity`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});
