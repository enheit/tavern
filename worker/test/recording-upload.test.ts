import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@tavern/shared";

const BASE = "https://tavern.test";

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

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
  const body: { user: { userId: string } } = await (await authed(token, "/api/me")).json();
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

async function joinServer(token: string, nickname: string): Promise<void> {
  const res = await authed(token, "/api/servers/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
}

function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

// The default (isolated-storage) project cannot drive DO WebSockets, so `rec.start` is unavailable
// here — seed the in-voice membership + the active-recording pointer straight into DO storage (the
// module re-reads both from KV, mirroring the rtc-authorize seeding in rtc-proxy.test.ts).
async function seedVoice(serverId: string, userIds: string[]): Promise<void> {
  await runInDurableObject(roomStub(serverId), async (_i, state) => {
    await state.storage.put("voice", {
      members: userIds.map((userId) => ({ userId, muted: false, deafened: false })),
      sessionStartedAt: Date.now(),
    });
  });
}

async function seedActiveRecording(serverId: string, startedBy: string): Promise<string> {
  const recordingId = crypto.randomUUID();
  const startedAt = Date.now();
  await runInDurableObject(roomStub(serverId), async (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO recordings (id, started_by, r2_key, upload_id, duration_ms, started_at, ended_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
      recordingId,
      startedBy,
      `recordings/${serverId}/${recordingId}.webm`,
      startedAt,
    );
    await state.storage.put("recording", { recordingId, startedBy, startedAt });
  });
  return recordingId;
}

interface Opened {
  recordingId: string;
  uploadId: string;
}

async function open(token: string, serverId: string): Promise<Opened> {
  const res = await authed(token, `/api/servers/${serverId}/recordings`, { method: "POST" });
  if (res.status !== 200) throw new Error(`open failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function partPath(
  serverId: string,
  recId: string,
  n: number,
  uploadId: string,
  final: boolean,
): string {
  return `/api/servers/${serverId}/recordings/${recId}/part?n=${n}&uploadId=${encodeURIComponent(uploadId)}&final=${final ? 1 : 0}`;
}

describe("FR-25 multipart upload", () => {
  it("non-final part with wrong Content-Length → 400 bad_part_size", async () => {
    const token = await register("rec_up_a");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-up-a");
    await seedVoice(serverId, [uid]);
    await seedActiveRecording(serverId, uid);
    const { recordingId, uploadId } = await open(token, serverId);

    const wrong = new Uint8Array(1024); // not equal to recordingPartBytes, final=0 → reject
    const res = await authed(token, partPath(serverId, recordingId, 1, uploadId, false), {
      method: "PUT",
      body: wrong,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_part_size" });
  });

  it("open→parts→complete produces an object readable via /api/media with correct byte length", async () => {
    const token = await register("rec_up_b");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-up-b");
    await seedVoice(serverId, [uid]);
    await seedActiveRecording(serverId, uid);
    const { recordingId, uploadId } = await open(token, serverId);

    // One exactly-recordingPartBytes non-final part (proves R2 accepts the equal-parts scheme) + a
    // smaller final part.
    const full = new Uint8Array(LIMITS.recordingPartBytes).fill(7);
    const tail = new Uint8Array(128).fill(9);
    const p1 = await authed(token, partPath(serverId, recordingId, 1, uploadId, false), {
      method: "PUT",
      body: full,
    });
    expect(p1.status).toBe(200);
    const { etag: etag1 }: { etag: string } = await p1.json();
    const p2 = await authed(token, partPath(serverId, recordingId, 2, uploadId, true), {
      method: "PUT",
      body: tail,
    });
    expect(p2.status).toBe(200);
    const { etag: etag2 }: { etag: string } = await p2.json();

    const complete = await authed(
      token,
      `/api/servers/${serverId}/recordings/${recordingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [
            { partNumber: 1, etag: etag1 },
            { partNumber: 2, etag: etag2 },
          ],
          durationMs: 6000,
        }),
      },
    );
    expect(complete.status).toBe(204);

    const media = await authed(token, `/api/media/recordings/${serverId}/${recordingId}.webm`);
    expect(media.status).toBe(200);
    const buf = await media.arrayBuffer();
    expect(buf.byteLength).toBe(LIMITS.recordingPartBytes + 128);

    // The finalized row now surfaces in the list with the capped duration.
    const list = await authed(token, `/api/servers/${serverId}/recordings`);
    const body: { recordings: Array<{ id: string; durationMs: number | null }> } =
      await list.json();
    expect(body.recordings.map((r) => r.id)).toContain(recordingId);
    expect(body.recordings.find((r) => r.id === recordingId)?.durationMs).toBe(6000);
  });

  it("abort removes the row and R2 shows no object", async () => {
    const token = await register("rec_up_c");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-up-c");
    await seedVoice(serverId, [uid]);
    await seedActiveRecording(serverId, uid);
    const { recordingId } = await open(token, serverId);

    const abort = await authed(token, `/api/servers/${serverId}/recordings/${recordingId}/abort`, {
      method: "POST",
    });
    expect(abort.status).toBe(204);

    const list = await authed(token, `/api/servers/${serverId}/recordings`);
    const body: { recordings: Array<{ id: string }> } = await list.json();
    expect(body.recordings.map((r) => r.id)).not.toContain(recordingId);

    const media = await authed(token, `/api/media/recordings/${serverId}/${recordingId}.webm`);
    expect(media.status).toBe(404);
  });

  // Uploads one final part + completes, returning the finalized recordingId.
  async function completeRecording(token: string, serverId: string): Promise<string> {
    const { recordingId, uploadId } = await open(token, serverId);
    const p = await authed(token, partPath(serverId, recordingId, 1, uploadId, true), {
      method: "PUT",
      body: new Uint8Array(200).fill(5),
    });
    const { etag }: { etag: string } = await p.json();
    const done = await authed(
      token,
      `/api/servers/${serverId}/recordings/${recordingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ partNumber: 1, etag }], durationMs: 5000 }),
      },
    );
    expect(done.status).toBe(204);
    return recordingId;
  }

  it("delete by the starter removes the row and the R2 object", async () => {
    const token = await register("rec_up_del");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-up-del");
    await seedVoice(serverId, [uid]);
    await seedActiveRecording(serverId, uid);
    const recordingId = await completeRecording(token, serverId);

    const del = await authed(token, `/api/servers/${serverId}/recordings/${recordingId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    const media = await authed(token, `/api/media/recordings/${serverId}/${recordingId}.webm`);
    expect(media.status).toBe(404);
    const list = await authed(token, `/api/servers/${serverId}/recordings`);
    const body: { recordings: Array<{ id: string }> } = await list.json();
    expect(body.recordings.map((r) => r.id)).not.toContain(recordingId);
  });

  it("delete by the server admin removes another member's recording", async () => {
    const admin = await register("rec_up_admin");
    const serverId = await createServer(admin, "rec-up-admin");
    const member = await register("rec_up_member");
    const memberId = await meUserId(member);
    await joinServer(member, "rec-up-admin");
    await seedVoice(serverId, [memberId]);
    await seedActiveRecording(serverId, memberId);
    const recordingId = await completeRecording(member, serverId);

    const del = await authed(admin, `/api/servers/${serverId}/recordings/${recordingId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
  });

  it("open by a member who is not the active starter → 403 forbidden", async () => {
    const owner = await register("rec_up_owner2");
    const ownerId = await meUserId(owner);
    const serverId = await createServer(owner, "rec-up-shared2");
    const other = await register("rec_up_other2");
    const otherId = await meUserId(other);
    await joinServer(other, "rec-up-shared2");
    await seedVoice(serverId, [ownerId, otherId]);
    await seedActiveRecording(serverId, ownerId);

    const res = await authed(other, `/api/servers/${serverId}/recordings`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("part upload by a non-starter member → 403", async () => {
    const owner = await register("rec_up_owner");
    const ownerId = await meUserId(owner);
    const serverId = await createServer(owner, "rec-up-shared");
    const bystander = await register("rec_up_bystander");
    const bystanderId = await meUserId(bystander);
    await joinServer(bystander, "rec-up-shared");
    await seedVoice(serverId, [ownerId, bystanderId]);
    await seedActiveRecording(serverId, ownerId);
    const { recordingId, uploadId } = await open(owner, serverId);

    const tail = new Uint8Array(64).fill(1);
    const res = await authed(bystander, partPath(serverId, recordingId, 1, uploadId, true), {
      method: "PUT",
      body: tail,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});
