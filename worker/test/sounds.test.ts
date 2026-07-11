import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS, Sound } from "@tavern/shared";

const BASE = "https://tavern.test";

// beep.mp3 (e2e/fixtures/beep.mp3, 1s 440Hz sine) inlined as base64 — a valid tiny mp3 whose
// music-metadata duration is ~1s. The "too long" case patches its Xing frame count (below).
const BEEP_B64 =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMgAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAAoAAASsgAlJSwsMjIyNzc9PT1CQkhISE1NU1NTWVleXl5kZGlpaW9vdHR0enqAgICFhYuLi5CQlpaWm5uhoaGmpqysrLKyt7e3vb3CwsLIyM3NzdPT2dnZ3t7k5OTp6e/v7/T0+vr6//8AAAAATGF2YzYyLjI4AAAAAAAAAAAAAAAAJAV8AAAAAAAAErJAbiU/AAAAAAD/+6DEAAADYBNd9DAAKL+Irf8wcgAAAAETVo4AAAAAwNzQAAAAQnDx4/UAAANdDw8CQCCrqACABgDgAAAAAAACJEqvW1xwle5NQ98vAXiy09/fBaA3wGjw2/HhKd6gaErKA5igAAAAAFKnS2pDhnh0spLUOVyufbYHl6AADgC8QNDkI6COZrCuv6pMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqq/AX88AAAAAAyJJ0OODwDKoaQoiES7tgeXoAAIBoATwOgguIhgvKiz0xBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvwF/PAAAAAAMSUch1orBjYMokJEJsygK6wAAJoEYIXAqEdArM1hXX9VTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/Ab98AAAAAAyJJ0HOCgm1QshJgqJd2gO60AAIC1gl4ExSXOhWP1IwbVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8BfvgAAAAACSORVBaQXAy4KkzKITZlAd1oAAe4vJlwlKeh1q9AIyPFUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/AXs4AAAAAAyJJ0HOCgPqnTrxie/lANTgAD/+yDE1QDC3Btn3PAAIEmDrfg2MAwYjQAnQJhh4YIFyiDVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8BvzgAAAAADEcjkVaKwM2EJpkmNZcgNToAAe4+YXCUZ8TzswWDwpMQU1FMy4xMDCqqqqq//sQxOoAwrQdc8YlJiBJg634NLAEqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvwG/OAAAAAAMhxOhTAsA1UhKXj1T+QATGAAAoLcM6ADDDyYcHiAS0xBTUUzLjEwMKqqqqr/+xDE6oDCsB1zxjEiYEqDrXiWMEyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr8BuzgAAAAADEckoqkXg5cMvZJjWbIDU6AADxI+TLgiGfCOdqDYjhVTEFNRTMuMTAwVVVVVf/7EMTqgMK4HXPGPSQgSwOtuGY8DFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8BvzgAAAAADIcUwpgWBVUTkTx6p/ZAanQAARHuH9AbDDyYcHiAS1MQU1FMy4xMDBVVVVV//sQxOqAwrwdccYtImBJg624x6SMVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfwG7OAAAAAACoDF0HtC8KbENGpPjbtkBubAABIYmEeIoz4KzNhO2kxBTUUzLjEwMKqqqqr/+xDE6YDCnB1zxjGCIEaDrXiWJEyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq+wj94AAAAAAyHlMQcGgXKCkFg0JTO7IDc2AADI+wT8Iww8KDBtIxTEFNRTMuMTAwVVVVVf/7EMTpgMKkHXPGMSJgRQOteMYYjFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfsI/eAAAAAAMR6SkLRrABSFZupLSrtoBybAABocNiTx1GfAPJbCdtVMQU1FMy4xMDBVVVVV//sQxOmAwqQdc8YtgiBHg6z4ZhgcVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/Aj74AAAAAAyHlMNMCwAZEUFiN1T+SIXFgAAyLuCPoP4beAwkNpEikxBTUUzLjEwMKqqqqr/+xDE6gDClB1zxi0iYEoDrTiWJByqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr7B/vgAAAAAAqCyUatC8EYAXH9xoezbIMqwAAeQFYscN0o8BslpCHDTEFNRTMuMTAwVVVVVf/7EMTpgMKgHXPGLYIgRwOteGYYHFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfwI7eAAAAAAIgVKhbAqAtCPB4jNUX7JBk2AADIu4fYLIoeBgkNlKBVMQU1FMy4xMDBVVVVV//sQxOmAwrgdccSxgCBDg214ZjBMVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/Qj94AAAAABhRS5KqRWCsAdltEbI+2iC5sAAEQ67SmylDuAWRqB9NUxBTUUzLjEwMFVVVVX/+xDE6YDCvB1zxj0kYEQDbXiWMExVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/Qjr0AAAAABiRK6LOBUCyoCEj3Ht2SC5sAACUecLsKQc0CCBcPJKTEFNRTMuMTAwqqqqqv/7EMTqAMK4HXPGLYQgRgNteJYwTKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr8COvQAAAAADkhIYmSKwfUAcnc8/myQXNgAATDrxZxQDuAWRpB9OpMQU1FMy4xMDCqqqqq//sQxOoAwqwdc8YtgmBIA2z4l7AMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvwI69AAAAAAOiChCbAqBRMBCR7j25RBk2AACI48EtFOmtlgTkq9JUxBTUUzLjEwMFVVVVX/+xDE6gDCuB1xxLEg4EiDbXjGsERVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8CO3gAAAAACEHjEWSKwXYEMtqDdH20QXNgAATCU0Edk0TekLY5F+VTEFNRTMuMTAwVVVVVf/7EMTqAMK0HXPErYBgRoNteJawRFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfwI6+AAAAAAIgdMBfAqAQ2IBYfcRf1EGTYAABkGjISYN8oeDAqQlJpMQU1FMy4xMDBVVVVV//sQxOoAwrgdc8etgiBHA214l6QMVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8CO3gAAAAACEHjEWSLQB2BDJ6g3V9kiFxQAAEwlckbYfg34GZXgQ2VUxBTUUzLjEwMFVVVVX/+xDE6YDCoB1zx60iYEWDbXiWpERVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX8CN3gAAAAACIPmAvgXAANkg8VlhR+0A5NgAASiYyJuHcbeHhUhTNKTEFNRTMuMTAwqqqqqv/7EMTpgMKcHXPGLSJgRYNteJakRKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr8CNzwAAAAACQwYiyRaAdgln7is37ZAdmwAAPiy8e+Ig34k5/lCTZMQU1FMy4xMDCqqqqq//sQxOmAwpwdc8YtImBHA214ZLwEqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/Qjt8AAAAABoplwH4FwBGxAMFZ4afsgOzYAAHpadPuEcY+TREFijqkxBTUUzLjEwMKqqqqr/+xDE6gDCtB1zxK2AYEiDbXiUvASqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqquwH3OAAAAAAZKRfBzQtHHAOdXmCcfzJAcnQAAJBLx7YGgy4XlcoSC1VTEFNRTMuMTAwVVVVVf/7EMTqAMKsHXPErYBgSoNteJawRFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/Qf+8AAAAABpDSCvCEFFwQJh+TFH7IDk6AABiTnSdUEwjYQFRkvFaqpMQU1FMy4xMDCqqqqq//sQxOqAwrwdc8StgGBJg2z4l7AMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/Qft8AAAAAA0QnFGkEK6CGZqD9X2wAXGAAAJQivHtgBBlwvL5wkFqkxBTUUzLjEwMKqqqqr/+xDE6gDCtB1zxK2AYEcDbXiWMEyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/Qfs8AAAAAA4WkFeEIDFxAMH1ij+kBydAAASRGdMqhOMfFiQ0UDTTEFNRTMuMTAwVVVVVf/7EMTpgMKgHXXELYBgRwNteMeYxFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfwF3eAAAAAAVGE4o0Uh/QQzM8J6vuoBycAAAShFXCTYJBlQTLrFUOpMQU1FMy4xMDCqqqqq//sQxOoAwrQddcYtgiBGg214x5jEqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr8Bt3gAAAAAFhtIHeCoklzQVjOoGTfUB7WgAATRKWk7QnKXaAXCo0RZUxBTUUzLjEwMFVVVVX/+xDE6oDCwB1xxj0kYEiDrXhmGBxVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVfwG3eAAAAAAVGE4caKST0NNXsifZ9bQHtaAABkYribgSB6YZl9oqnPqTEFNRTMuMTAwqqqqqv/7EMTqgMKkHXfGMYJgTAOtOMWwhKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/gXb8AAAAABIRn4J/gqBhcGhg+sLH7QFdYAABiTlolVAuEbFklREiypMQU1FMy4xMDCqqqqq//sQxOoAwpQdd8MxgCBLg6z4xhiMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/QXb8AAAAABMQFcCmikGdAbmbi8t91geXoAAGQkrhJwOAaoXTWEKHUxBTUUzLjEwMKqqqqr/+xDE6YDCkB13wzGAIEmDrXjGGIyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrbBdzwAAAAAIHUEeD0DC4NDBeYFj+sD69AAAxEpaJWh2DNjEpMlZd1TEFNRTMuMTAwVVVVVf/7EMTqAMKgHXPEsYAgSoOteMWkhFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV+wTc8AAAAAAsEXEGjyL6A3M1h2W+6wTr0AADISToQcDgpqjJKuKp76pMQU1Fqqqq3ASp8AAA//sQxOqAwrQdc8Sx4GBMA624x6SMAACNgQBPkOgMLA8KixYJBBwBuToTQRQNYwAAAAAAAHxN3CQJn8Dlvl6MNhejSrHpCoD11RPAdDabwvBaFhvzyx8KFdJwbUxBTUUzLjEwMFVVVVX/+xDE6oDCtB1zxLHgYEsDrbjGsIRVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMTqgMK8HXPEvYAgSYOteMWkhFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxOoAwrQdc8SxgCBJg634xaSEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE6gDCmB1zwaWAIEuDrfjFsIRVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTqgMKgHXPDJYAgTIOt+MewhFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxPwAAqwbcdTAACDZCe3/MKBAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAH+HAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==";

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function nth<T>(arr: readonly T[], i: number): T {
  return must(arr[i], `index ${i} out of range`);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function indexOfSeq(bytes: Uint8Array, seq: number[]): number {
  outer: for (let i = 0; i + seq.length <= bytes.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) if (bytes[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

// A valid tiny mp3 whose Xing frame count is overwritten so music-metadata reports > soundMaxDurationMs
// (40000 MPEG1-L3 frames ≈ 1045s). Lets the FR-34 duration test avoid a multi-MB long fixture.
function longMp3(): Uint8Array {
  const bytes = b64ToBytes(BEEP_B64);
  const xing = indexOfSeq(bytes, [0x58, 0x69, 0x6e, 0x67]); // "Xing"
  if (xing < 0) throw new Error("Xing header not found in fixture");
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(xing + 8, 40000, false);
  return bytes;
}

function uname(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function register(username: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
}

async function session(username: string): Promise<string> {
  const res = await register(username);
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

function json(token: string, method: string, path: string, body: unknown): Promise<Response> {
  return authed(token, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createServer(token: string, nickname: string): Promise<string> {
  // Creation now requires a password + a one-time operator-seeded code (migration 0003); seed a fresh
  // code per create and use a fixed password (joinServer below matches it).
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const res = await json(token, "POST", "/api/servers", { nickname, password: "hunter2", code });
  if (res.status !== 201) throw new Error(`create server: ${res.status} ${await res.text()}`);
  const body: { id: string } = await res.json();
  return body.id;
}

async function joinServer(token: string, nickname: string): Promise<void> {
  // Servers created via the helper carry the fixed "hunter2" password, so join with it.
  const res = await json(token, "POST", "/api/servers/join", { nickname, password: "hunter2" });
  if (!res.ok) throw new Error(`join server: ${res.status} ${await res.text()}`);
}

// A fresh server with `memberCount` members; tokens[0] is the creator (admin).
async function freshServer(
  memberCount = 1,
): Promise<{ serverId: string; tokens: string[]; nickname: string }> {
  const nickname = `s-${crypto.randomUUID().slice(0, 8)}`;
  const admin = await session(uname());
  const serverId = await createServer(admin, nickname);
  const extra = await Promise.all(
    Array.from({ length: Math.max(0, memberCount - 1) }, async () => {
      const t = await session(uname());
      await joinServer(t, nickname);
      return t;
    }),
  );
  return { serverId, tokens: [admin, ...extra], nickname };
}

function uploadSound(
  token: string,
  serverId: string,
  bytes: Uint8Array,
  name: string,
  durationMs: number,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], "sound.mp3", { type: "audio/mpeg" }));
  form.append("name", name);
  form.append("durationMs", String(durationMs));
  return authed(token, `/api/servers/${serverId}/sounds`, { method: "POST", body: form });
}

async function uploadOk(
  token: string,
  serverId: string,
  bytes: Uint8Array,
  name: string,
  durationMs: number,
): Promise<Sound> {
  const res = await uploadSound(token, serverId, bytes, name, durationMs);
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`);
  const body: { sound: unknown } = await res.json();
  return Sound.parse(body.sound);
}

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;
function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

async function errorCode(res: Response): Promise<string> {
  const body: { error?: string } = await res.json();
  return must(body.error, "expected an error body");
}

describe("FR-34 soundboard upload", () => {
  it("rejects file over soundMaxBytes with 413 payload_too_large", async () => {
    const { serverId, tokens } = await freshServer();
    const big = new Uint8Array(LIMITS.soundMaxBytes + 1);
    const res = await uploadSound(nth(tokens, 0), serverId, big, "toobig", 1000);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("payload_too_large");
  });

  it("rejects bad magic bytes with 415 unsupported_media", async () => {
    const { serverId, tokens } = await freshServer();
    const res = await uploadSound(
      nth(tokens, 0),
      serverId,
      new Uint8Array([1, 2, 3, 4, 5, 6]),
      "bad",
      1000,
    );
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("unsupported_media");
  });

  it("rejects duration over soundMaxDurationMs with 422 sound_too_long", async () => {
    const { serverId, tokens } = await freshServer();
    const res = await uploadSound(nth(tokens, 0), serverId, longMp3(), "long", 1000);
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("sound_too_long");
  });

  it("accepts valid mp3: 201, R2 object exists, row has trimEnd=durationMs", async () => {
    const { serverId, tokens } = await freshServer();
    const sound = await uploadOk(nth(tokens, 0), serverId, b64ToBytes(BEEP_B64), "boop", 1000);

    expect(sound.trimStartMs).toBe(0);
    expect(sound.trimEndMs).toBe(sound.durationMs);
    expect(sound.durationMs).toBeGreaterThan(0);
    expect(sound.durationMs).toBeLessThanOrEqual(LIMITS.soundMaxDurationMs);
    expect(sound.playCount).toBe(0);

    const object = await env.MEDIA.get(`sounds/${serverId}/${sound.id}.mp3`);
    expect(object).not.toBeNull();

    await runInDurableObject(roomStub(serverId), (_instance, state) => {
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT trim_start_ms, trim_end_ms, duration_ms FROM sounds WHERE id = ?`,
          sound.id,
        )
        .one();
      expect(Number(row["trim_start_ms"])).toBe(0);
      expect(Number(row["trim_end_ms"])).toBe(Number(row["duration_ms"]));
    });
  });
});

describe("FR-35 trim rules", () => {
  it("rejects trimStart < 0 with 422 bad_trim", async () => {
    const { serverId, tokens } = await freshServer();
    const sound = await uploadOk(nth(tokens, 0), serverId, b64ToBytes(BEEP_B64), "s", 1000);
    const res = await json(nth(tokens, 0), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      trimStartMs: -1,
      trimEndMs: 500,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("bad_trim");
  });

  it("rejects trimEnd > duration with 422 bad_trim", async () => {
    const { serverId, tokens } = await freshServer();
    const sound = await uploadOk(nth(tokens, 0), serverId, b64ToBytes(BEEP_B64), "s", 1000);
    const res = await json(nth(tokens, 0), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      trimEndMs: sound.durationMs + 5000,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("bad_trim");
  });

  it("rejects window smaller than soundMinTrimMs with 422 bad_trim", async () => {
    const { serverId, tokens } = await freshServer();
    const sound = await uploadOk(nth(tokens, 0), serverId, b64ToBytes(BEEP_B64), "s", 1000);
    const res = await json(nth(tokens, 0), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      trimStartMs: 100,
      trimEndMs: 100 + LIMITS.soundMinTrimMs - 1,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("bad_trim");
  });
});

describe("FR-35 permissions", () => {
  it("uploader can PATCH", async () => {
    const { serverId, tokens } = await freshServer(2);
    const sound = await uploadOk(nth(tokens, 1), serverId, b64ToBytes(BEEP_B64), "mine", 1000);
    const res = await json(nth(tokens, 1), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      name: "renamed",
    });
    expect(res.status).toBe(200);
    const body: { sound: unknown } = await res.json();
    expect(Sound.parse(body.sound).name).toBe("renamed");
  });

  it("admin can PATCH another member's sound", async () => {
    const { serverId, tokens } = await freshServer(2);
    const sound = await uploadOk(nth(tokens, 1), serverId, b64ToBytes(BEEP_B64), "theirs", 1000);
    const res = await json(nth(tokens, 0), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      name: "byadmin",
    });
    expect(res.status).toBe(200);
    const body: { sound: unknown } = await res.json();
    expect(Sound.parse(body.sound).name).toBe("byadmin");
  });

  it("another non-admin member gets 403 forbidden", async () => {
    const { serverId, tokens } = await freshServer(3);
    const sound = await uploadOk(nth(tokens, 1), serverId, b64ToBytes(BEEP_B64), "b-sound", 1000);
    const res = await json(nth(tokens, 2), "PATCH", `/api/servers/${serverId}/sounds/${sound.id}`, {
      name: "nope",
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  it("DELETE removes the R2 object and the row", async () => {
    const { serverId, tokens } = await freshServer(2);
    const sound = await uploadOk(nth(tokens, 1), serverId, b64ToBytes(BEEP_B64), "gone", 1000);
    const key = `sounds/${serverId}/${sound.id}.mp3`;
    expect(await env.MEDIA.get(key)).not.toBeNull();

    const res = await authed(nth(tokens, 1), `/api/servers/${serverId}/sounds/${sound.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(await env.MEDIA.get(key)).toBeNull();

    await runInDurableObject(roomStub(serverId), (_instance, state) => {
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS c FROM sounds WHERE id = ?`,
          sound.id,
        )
        .one();
      expect(Number(row["c"])).toBe(0);
    });
  });
});

describe("FR-37 list ordering", () => {
  it("orders by playCount desc then createdAt desc", async () => {
    const { serverId, tokens } = await freshServer();
    const uploader = crypto.randomUUID();
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const popular = crypto.randomUUID();

    // Seed three sounds + play rows directly (no play endpoint until S9.2). older/newer both have 0
    // plays; popular has 2. Expected order: popular (2), newer (0, created later), older (0).
    await runInDurableObject(roomStub(serverId), (_instance, state) => {
      const seedSound = (id: string, createdAt: number): void => {
        state.storage.sql.exec(
          `INSERT INTO sounds (id, name, uploader_id, r2_key, duration_ms, trim_start_ms, trim_end_ms, created_at)
           VALUES (?, ?, ?, ?, 1000, 0, 1000, ?)`,
          id,
          id.slice(0, 8),
          uploader,
          `sounds/${serverId}/${id}.mp3`,
          createdAt,
        );
      };
      seedSound(older, 100);
      seedSound(newer, 200);
      seedSound(popular, 300);
      for (let i = 0; i < 2; i += 1) {
        state.storage.sql.exec(
          `INSERT INTO sound_plays (sound_id, user_id, created_at) VALUES (?, ?, ?)`,
          popular,
          uploader,
          400 + i,
        );
      }
    });

    const res = await authed(nth(tokens, 0), `/api/servers/${serverId}/sounds`);
    expect(res.status).toBe(200);
    const body: { sounds: Sound[] } = await res.json();
    const ids = body.sounds.map((s) => s.id);
    expect(ids).toEqual([popular, newer, older]);
    expect(nth(body.sounds, 0).playCount).toBe(2);
    expect(nth(body.sounds, 1).playCount).toBe(0);
  });
});
