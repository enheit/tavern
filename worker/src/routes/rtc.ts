import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  IceServersResponse,
  LIMITS,
  RtcClosePayload,
  RtcRenegotiateRequest,
  RtcTracksLocalRequest,
  RtcTracksResponse,
  errorCodeSchema,
} from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";
import { RealtimeError, createRealtimeClient } from "../rtc/realtime";
import type { RemoteTrackReq, TracksNewResponse } from "../rtc/realtime";
import type { RtcAuthorizeReq, RtcKind } from "../do/roomState";

// Flow (pinned §6.1 task 4):
//   client → Worker (session + D1 membership + rate limit) → DO /internal/rtc/authorize → SFU HTTP → client
//
// The Worker is the ONLY path to the Realtime SFU (A3): it enforces membership (D1) + the rtc rate
// limit, delegates the media policy (voice membership G1, share cap G4, pull grants + kill G5) to the
// per-server DO, then proxies the SFU HTTP call. The proxy is STATELESS — SDP-op serialization per
// session is the client engine's job (S7.2 promise chain).

// Env vars this route reads that are not deployed bindings (so not in the generated Env): the SFU mock
// switch (§10). KILL_SWITCH_DISABLED is read only by CostMeter (via its narrow env param).
declare global {
  interface Env {
    TAVERN_SFU_MOCK?: string;
  }
}

// Non-null narrow without `!` (§9.1).
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Maps an authorize/route ErrorCode to its HTTP status.
function statusFor(code: ErrorCode): 400 | 401 | 403 | 429 {
  if (code === "unauthorized") return 401;
  if (code === "bad_request") return 400;
  if (code === "rtc_rate_limited") return 429;
  return 403; // forbidden · not_in_voice · share_cap · pull_denied · cost_cap
}

// The DO authorize response (validated at the DO→Worker boundary, §9.8).
const rtcAuthorizeResSchema = z.union([
  z.object({ ok: z.literal(true), publisherSessions: z.record(z.string(), z.string()).optional() }),
  z.object({ ok: z.literal(false), error: errorCodeSchema }),
]);
type AuthorizeResult = z.infer<typeof rtcAuthorizeResSchema>;

// Client → Worker PULL body: only the trackName (+ optional layer) — the Worker resolves the publisher
// session (G1: the client never learns another user's sessionId). The puller's own sessionId is the
// `?session=` query param. (Distinct from the shared RtcTracksRemoteRequest, which is the resolved
// SFU-facing shape carrying the publisher sessionId; the client body omits it — S7.2 sfuSignal.)
const rtcPullBody = z.object({
  tracks: z.array(
    z.object({
      location: z.literal("remote"),
      trackName: z.string(),
      simulcast: z.object({ preferredRid: z.enum(["h", "l"]) }).optional(),
    }),
  ),
});

// Client → Worker tracks/update (FR-33 layer switch): the puller's mid + target rid. `trackName` is
// sent by the S7.2 client so the DO can reprice the watcher's egress (op:'layer', G5); it is optional
// (a body without it stays a pure SFU passthrough — the meter simply is not notified for that track).
const rtcUpdateBody = z.object({
  tracks: z.array(
    z.object({
      mid: z.string(),
      trackName: z.string().optional(),
      simulcast: z.object({ preferredRid: z.enum(["h", "l"]) }),
    }),
  ),
});

// The per-share counter `n` in the track-name grammar is a positive integer with no leading zero.
function isShareCounter(v: string | undefined): boolean {
  return v !== undefined && /^[1-9][0-9]*$/.test(v);
}

// Track-name grammar (§7.1) → kind, AND ownership check (a client may only publish tracks named for
// ITSELF). Returns null on a malformed name or a foreign userId → the route answers 400.
function kindFromTrackName(trackName: string, userId: string): RtcKind | null {
  const parts = trackName.split(":");
  if (parts[0] === "mic" && parts.length === 2 && parts[1] === userId) return "mic";
  if (parts[0] === "cam" && parts.length === 2 && parts[1] === userId) return "cam";
  if (
    parts[0] === "screen" &&
    parts.length === 3 &&
    parts[1] === userId &&
    isShareCounter(parts[2])
  ) {
    return "screen";
  }
  if (
    parts[0] === "screenAudio" &&
    parts.length === 3 &&
    parts[1] === userId &&
    isShareCounter(parts[2])
  ) {
    return "screenAudio";
  }
  return null;
}

// POSTs an authorize op to the server's DO + validates the response (§9.8).
async function authorize(
  env: Env,
  serverId: string,
  req: RtcAuthorizeReq,
): Promise<AuthorizeResult> {
  const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
  const res = await stub.fetch("https://do.internal/internal/rtc/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify(req),
  });
  return rtcAuthorizeResSchema.parse(await res.json());
}

// TracksNewResponse (SFU shape) → the pinned client-facing RtcTracksResponse.
function toClientResponse(sfu: TracksNewResponse): unknown {
  return RtcTracksResponse.parse({
    requiresImmediateRenegotiation: sfu.requiresImmediateRenegotiation,
    tracks: sfu.tracks.map((t) => ({
      trackName: t.trackName ?? "",
      ...(t.mid === undefined ? {} : { mid: t.mid }),
      ...(t.errorCode === undefined
        ? {}
        : { error: { code: t.errorCode, message: t.errorDescription ?? "" } }),
    })),
    ...(sfu.sessionDescription === undefined ? {} : { sessionDescription: sfu.sessionDescription }),
  });
}

// ---- ICE (STUN + short-TTL Cloudflare TURN). Per-user isolate-local cache (misses just re-fetch).
type IceServer = z.infer<typeof iceServerSchema>;
const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
const turnResponseSchema = z.object({
  iceServers: z.union([iceServerSchema, z.array(iceServerSchema)]),
});

const STUN_SERVER: IceServer = { urls: ["stun:stun.cloudflare.com:3478"] };
const ICE_TTL_MS = 30 * 60 * 1000;
const iceCache = new Map<string, { servers: IceServer[]; expiresAt: number }>();

// Cloudflare TURN short-lived credentials (§7.1). Exported for a fetch-stubbed unit test — the real
// path is never hit under TAVERN_SFU_MOCK.
export async function fetchTurnIceServers(env: {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
}): Promise<IceServer[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: 3600 }),
    },
  );
  if (!res.ok) throw new Error(`TURN generate-ice-servers → ${res.status}`);
  const body = turnResponseSchema.parse(await res.json());
  return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
}

async function buildIceServers(env: Env, userId: string): Promise<IceServer[]> {
  // Mock: STUN entry only (no TURN plane, §10).
  if (env.TAVERN_SFU_MOCK === "1") return [STUN_SERVER];
  const cached = iceCache.get(userId);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.servers;
  const servers = [STUN_SERVER, ...(await fetchTurnIceServers(env))];
  iceCache.set(userId, { servers, expiresAt: Date.now() + ICE_TTL_MS });
  return servers;
}

// ---- Middleware. withAuth (app-level) has already resolved c.var.userId.

// rtc ops rate limit (LIMITS.rateRtcOpsPerMin, isolate-local fixed window keyed by userId).
const rtcWindows = new Map<string, { count: number; windowStart: number }>();
const rtcRateLimit: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  const userId = c.get("userId");
  if (userId !== null) {
    const now = Date.now();
    const win = rtcWindows.get(userId);
    if (win === undefined || now - win.windowStart >= 60_000) {
      rtcWindows.set(userId, { count: 1, windowStart: now });
    } else {
      win.count += 1;
      if (win.count > LIMITS.rateRtcOpsPerMin) {
        return c.json({ error: "rtc_rate_limited" satisfies ErrorCode }, 429);
      }
    }
  }
  await next();
};

// Member gate for the `/:serverId/*` rtc routes. Non-member → 403 `forbidden` (§6.1 member-in-voice;
// the in-voice check is the DO's job). Distinct from `requireMember` (which answers `not_member`).
const rtcMember: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  const userId = c.get("userId");
  if (userId === null) return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
  const serverId = c.req.param("serverId");
  if (serverId === undefined) return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
  )
    .bind(userId, serverId)
    .first();
  if (membership === null) return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
  await next();
};

export const rtcRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// An SFU call that still fails after the client's bounded transient retry (realtime.ts) surfaces
// here. Map it to the enveloped 502 the publish path already uses — never a bare Hono 500: the app's
// pull retries (voiceController mic pull) key off ApiError, which needs the typed envelope.
rtcRoute.onError((err, c) => {
  if (err instanceof RealtimeError) {
    console.error(`SFU call failed (upstream ${err.status})`, err);
    return c.json({ error: "bad_request" satisfies ErrorCode }, 502);
  }
  throw err;
});

rtcRoute.use("*", rtcRateLimit);

// GET /api/rtc/ice (session-gated, §6.1): STUN + short-TTL Cloudflare TURN. Mock → STUN only.
rtcRoute.get("/ice", async (c) => {
  const userId = c.get("userId");
  if (userId === null) return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
  const iceServers = await buildIceServers(c.env, userId);
  return c.json(IceServersResponse.parse({ iceServers }));
});

// POST /api/rtc/:serverId/session (member-in-voice): SFU sessions/new FIRST, then the DO registers the
// session iff the caller is in voice (a not-in-voice reject leaves an orphaned SFU session — harmless,
// the SFU GCs it, §7.1).
rtcRoute.post("/:serverId/session", rtcMember, async (c) => {
  const userId = invariant(c.get("userId"), "rtcMember guarantees userId");
  const serverId = invariant(c.req.param("serverId"), "route guarantees :serverId");
  const client = createRealtimeClient(c.env);
  const { sessionId } = await client.newSession();
  const auth = await authorize(c.env, serverId, { op: "session.new", userId, sessionId });
  if (!auth.ok) return c.json({ error: auth.error }, statusFor(auth.error));
  return c.json({ sessionId });
});

// POST /api/rtc/:serverId/tracks (member-in-voice): publish (location:'local') or pull (location:
// 'remote'). Worker enforces §8 caps via the DO; DO registers publishes / resolves + grant-checks pulls.
rtcRoute.post("/:serverId/tracks", rtcMember, async (c) => {
  const userId = invariant(c.get("userId"), "rtcMember guarantees userId");
  const serverId = invariant(c.req.param("serverId"), "route guarantees :serverId");
  const sessionId = c.req.query("session");
  if (sessionId === undefined) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  const client = createRealtimeClient(c.env);

  const publish = RtcTracksLocalRequest.safeParse(raw);
  if (publish.success) {
    const tracks: Array<{ trackName: string; kind: RtcKind }> = [];
    for (const t of publish.data.tracks) {
      const kind = kindFromTrackName(t.trackName, userId);
      if (kind === null) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
      tracks.push({ trackName: t.trackName, kind });
    }
    // DO authorize + register FIRST (in-voice, G4, grammar) — then the SFU. On SFU failure, a
    // compensating close op unregisters (§6.1 task 5).
    const auth = await authorize(c.env, serverId, { op: "publish", userId, sessionId, tracks });
    if (!auth.ok) return c.json({ error: auth.error }, statusFor(auth.error));
    try {
      const sfu = await client.newLocalTracks(
        sessionId,
        publish.data.sessionDescription,
        publish.data.tracks,
      );
      return c.json(toClientResponse(sfu));
    } catch (err: unknown) {
      console.error("SFU publish failed; compensating close", err);
      await authorize(c.env, serverId, {
        op: "close",
        userId,
        trackNames: tracks.map((t) => t.trackName),
      });
      return c.json({ error: "bad_request" satisfies ErrorCode }, 502);
    }
  }

  const pull = rtcPullBody.safeParse(raw);
  if (pull.success) {
    const auth = await authorize(c.env, serverId, {
      op: "pull",
      userId,
      tracks: pull.data.tracks.map((t) => ({
        trackName: t.trackName,
        ...(t.simulcast === undefined ? {} : { preferredRid: t.simulcast.preferredRid }),
      })),
    });
    if (!auth.ok) return c.json({ error: auth.error }, statusFor(auth.error));
    const publisherSessions = auth.publisherSessions ?? {};
    const remoteReqs: RemoteTrackReq[] = pull.data.tracks.map((t) => ({
      location: "remote",
      sessionId: invariant(
        publisherSessions[t.trackName],
        "an authorized pull resolves every trackName to a publisher session",
      ),
      trackName: t.trackName,
      ...(t.simulcast === undefined ? {} : { simulcast: t.simulcast }),
    }));
    const sfu = await client.newRemoteTracks(sessionId, remoteReqs);
    return c.json(toClientResponse(sfu));
  }

  return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
});

// PUT /api/rtc/:serverId/renegotiate (member): membership only, straight SFU passthrough (no DO call).
rtcRoute.put("/:serverId/renegotiate", rtcMember, async (c) => {
  const sessionId = c.req.query("session");
  if (sessionId === undefined) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const body = RtcRenegotiateRequest.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const client = createRealtimeClient(c.env);
  await client.renegotiate(sessionId, body.data.sessionDescription);
  return c.json({});
});

// PUT /api/rtc/:serverId/tracks/update (member): simulcast layer switch (FR-33). Notify the DO of each
// watcher's new layer (op:'layer', G5 reprice — the DO no-ops a track with no active grant), then SFU
// passthrough. The reprice must use the trackName the client sends alongside the mid.
rtcRoute.put("/:serverId/tracks/update", rtcMember, async (c) => {
  const userId = invariant(c.get("userId"), "rtcMember guarantees userId");
  const serverId = invariant(c.req.param("serverId"), "route guarantees :serverId");
  const sessionId = c.req.query("session");
  if (sessionId === undefined) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const body = rtcUpdateBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  // Meter reprice (G5): price this watcher at the l-rate (250 kbps) vs the h-rate (preset kbps · dt).
  // Collect the per-track op:'layer' notifies and await them together (the DO serializes internally).
  const repriceOps: Promise<AuthorizeResult>[] = [];
  for (const t of body.data.tracks) {
    if (t.trackName !== undefined) {
      repriceOps.push(
        authorize(c.env, serverId, {
          op: "layer",
          userId,
          trackName: t.trackName,
          preferredRid: t.simulcast.preferredRid,
        }),
      );
    }
  }
  await Promise.all(repriceOps);
  const client = createRealtimeClient(c.env);
  // Distinct mids on one session — the SFU layer switch is idempotent per mid, so no serialization.
  await Promise.all(body.data.tracks.map((t) => client.updateTrack(sessionId, t.mid, t.simulcast)));
  return c.json({});
});

// POST /api/rtc/:serverId/close (member): SFU tracks/close passthrough (force:true when the client is
// gone). The DO registry cleanup is driven by WS stream.stop/watch.stop + the disconnect sweep.
rtcRoute.post("/:serverId/close", rtcMember, async (c) => {
  const sessionId = c.req.query("session");
  if (sessionId === undefined) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const body = RtcClosePayload.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const client = createRealtimeClient(c.env);
  await client.closeTracks(
    sessionId,
    body.data.tracks.map((t) => t.mid),
    body.data.sessionDescription,
    body.data.force,
  );
  return c.json({});
});
