import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@tavern/shared";
import { RoomState, type RtcRegistry } from "../src/do/roomState";

const BASE = "https://tavern.test";

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function register(username: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return must(response.headers.get("set-auth-token"), "register did not return a token");
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function userId(token: string): Promise<string> {
  const body: { user: { userId: string } } = await (await authed(token, "/api/me")).json();
  return body.user.userId;
}

async function createServer(token: string, nickname: string): Promise<string> {
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const response = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, password: "hunter2", code }),
  });
  if (response.status !== 201) {
    throw new Error(`create server failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

async function seedActivePreview(
  serverId: string,
  ownerId: string,
  previewId: string,
): Promise<string> {
  const trackName = `screen:${ownerId}:1`;
  const rtcRegistry: RtcRegistry = {
    sessions: { "publisher-session": { userId: ownerId, mediaReadyVersion: 2 } },
    tracks: {
      [trackName]: {
        userId: ownerId,
        sessionId: "publisher-session",
        kind: "screen",
        preset: "1080p30",
        publicationId: previewId,
      },
    },
    pending: {},
    grants: {},
    deliveries: {},
  };
  await runInDurableObject(roomStub(serverId), async (_instance, state) => {
    await state.storage.put("rtc", rtcRegistry);
  });
  return trackName;
}

async function registry(serverId: string): Promise<RtcRegistry> {
  return runInDurableObject(roomStub(serverId), async (_instance, state) =>
    new RoomState(state, env).rtcSnapshot(),
  );
}

function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00,
  ]);
}

function upload(token: string, serverId: string, previewId: string): Promise<Response> {
  const bytes = webpBytes();
  return authed(token, `/api/servers/${serverId}/stream-previews/${previewId}`, {
    method: "PUT",
    headers: { "content-type": "image/webp", "content-length": String(bytes.byteLength) },
    body: bytes,
  });
}

describe("member stream previews", () => {
  it("lets the active owner upload and members fetch outside voice, then rate-limits early replacement", async () => {
    const token = await register("preview_owner_a");
    const ownerId = await userId(token);
    const serverId = await createServer(token, "preview-a");
    const previewId = crypto.randomUUID();
    const trackName = await seedActivePreview(serverId, ownerId, previewId);

    const put = await upload(token, serverId, previewId);
    expect(put.status).toBe(200);
    const body: { preview: { id: string; version: string } } = await put.json();
    expect(body.preview.id).toBe(previewId);
    expect(body.preview.version).not.toBe("");
    expect((await registry(serverId)).tracks[trackName]?.preview).toEqual(body.preview);

    // The caller was never put in voice: membership alone is the read boundary.
    const get = await authed(token, `/api/servers/${serverId}/stream-previews/${previewId}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/webp");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(webpBytes());

    const tooSoon = await upload(token, serverId, previewId);
    expect(tooSoon.status).toBe(429);
    expect(await tooSoon.json()).toEqual({ error: "rate_limited" });
  });

  it("rejects a different member, invalid media, and oversized bodies before R2 replacement", async () => {
    const ownerToken = await register("preview_owner_b");
    const ownerId = await userId(ownerToken);
    const serverId = await createServer(ownerToken, "preview-b");
    const previewId = crypto.randomUUID();
    await seedActivePreview(serverId, ownerId, previewId);
    const otherToken = await register("preview_member_b");
    const otherId = await userId(otherToken);
    await env.DB.prepare("INSERT INTO memberships (user_id, server_id, joined_at) VALUES (?, ?, ?)")
      .bind(otherId, serverId, Date.now())
      .run();

    expect((await upload(otherToken, serverId, previewId)).status).toBe(403);
    const wrongType = await authed(
      ownerToken,
      `/api/servers/${serverId}/stream-previews/${previewId}`,
      { method: "PUT", headers: { "content-type": "image/png" }, body: webpBytes() },
    );
    expect(wrongType.status).toBe(415);
    const oversized = await authed(
      ownerToken,
      `/api/servers/${serverId}/stream-previews/${previewId}`,
      {
        method: "PUT",
        headers: {
          "content-type": "image/webp",
          "content-length": String(LIMITS.streamPreviewMaxBytes + 1),
        },
        body: webpBytes(),
      },
    );
    expect(oversized.status).toBe(413);
    expect(await env.MEDIA.get(`${serverId}/stream-previews/${previewId}.webp`)).toBeNull();
  });

  it("persists stop cleanup and removes the stable R2 object on the room alarm", async () => {
    const token = await register("preview_owner_c");
    const ownerId = await userId(token);
    const serverId = await createServer(token, "preview-c");
    const previewId = crypto.randomUUID();
    const trackName = await seedActivePreview(serverId, ownerId, previewId);
    expect((await upload(token, serverId, previewId)).status).toBe(200);

    const closed = await roomStub(serverId).fetch("https://do.internal/internal/rtc/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ op: "close", userId: ownerId, trackNames: [trackName] }),
    });
    expect(await closed.json()).toEqual({ ok: true });
    expect((await registry(serverId)).previewCleanup).toContain(previewId);
    await runInDurableObject(roomStub(serverId), async (instance) => {
      if (instance.alarm === undefined) throw new Error("ServerRoom alarm handler is missing");
      await instance.alarm();
    });
    expect(await env.MEDIA.get(`${serverId}/stream-previews/${previewId}.webp`)).toBeNull();
    expect((await registry(serverId)).previewCleanup).toBeUndefined();
  });
});
