import { z } from "zod";
import type { ScreenRid } from "@tavern/shared";
import { requiredEnv } from "../env";
import { createRealtimeMock } from "./realtimeMock";

// Typed client for the Cloudflare Realtime SFU HTTP API (PLAN §7.1). This is the ONLY path from the
// app to the SFU — the app secret never reaches a client. Base URL + Bearer are Worker-side only.
//
// CONSTRAINT (pinned §7.1): `renegotiate`, `tracks/update`, `tracks/close` are **PUT**; `sessions/new`
// and `tracks/new` are POST. The proxy is STATELESS: SDP-op serialization per session is the client
// engine's job (S7.2 PublishSession/PullSession promise chain), so this client holds no per-session
// mutex.
//
// RETRY (amends the S7.1 "no retries in v1" pin — S12.4 nightly soak finding): the SFU API answers
// the occasional transient 5xx under burst load (observed: 503 on tracks/new during a 10-client
// soak's mass mic pull), which surfaced to the browser as a failed /api/rtc call. A 5xx (or a thrown
// fetch) means the SFU did NOT serve the request, so replaying the identical request is safe; 4xx is
// a semantic rejection and is NEVER retried. Bounded: 2 retries with short backoff, then the typed
// RealtimeError propagates exactly as before.
const BASE_URL = "https://rtc.live.cloudflare.com/v1";
const RETRY_DELAYS_MS = [150, 400];

export type SessionDescription = { sdp: string; type: "offer" | "answer" };
export type LocalTrackReq = { location: "local"; mid: string; trackName: string };
// Simulcast selection passed to the SFU. v2 screen publishers use h/i/l and Cloudflare's ordered
// fallback; legacy publishers remain pinned because they have no useful intermediate rung.
export type SimulcastPrefs = {
  preferredRid: ScreenRid;
  priorityOrdering?: "none" | "asciibetical";
  ridNotAvailable?: "none" | "asciibetical";
};
export type RemoteTrackReq = {
  location: "remote";
  sessionId: string;
  trackName: string;
  simulcast?: SimulcastPrefs;
};
export type TrackResult = {
  trackName?: string;
  mid?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};
export type TracksNewResponse = {
  requiresImmediateRenegotiation: boolean;
  tracks: TrackResult[];
  sessionDescription?: SessionDescription;
};

export interface RealtimeClient {
  newSession(): Promise<{ sessionId: string }>;
  newLocalTracks(
    sessionId: string,
    offer: SessionDescription,
    tracks: LocalTrackReq[],
  ): Promise<TracksNewResponse>;
  newRemoteTracks(sessionId: string, tracks: RemoteTrackReq[]): Promise<TracksNewResponse>;
  renegotiate(sessionId: string, answer: SessionDescription): Promise<void>; // PUT
  updateTrack(sessionId: string, mid: string, simulcast: SimulcastPrefs): Promise<void>; // PUT tracks/update
  closeTracks(
    sessionId: string,
    mids: string[],
    offer?: SessionDescription,
    force?: boolean,
  ): Promise<TracksNewResponse>; // PUT tracks/close
}

type RealtimeEnv = {
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TAVERN_SFU_MOCK?: string;
};

// SFU→Worker boundary validators (§9.8 / A9). Unknown extra fields are stripped; a genuinely divergent
// shape (missing sessionId, non-array tracks) throws — surfacing the §7.1 STOP (fixtures document the
// contract) instead of silently mis-typing.
const sessionNewSchema = z.object({ sessionId: z.string() });
const tracksNewSchema = z.object({
  requiresImmediateRenegotiation: z.boolean().default(false),
  tracks: z
    .array(
      z.object({
        trackName: z.string().optional(),
        mid: z.string().optional(),
        sessionId: z.string().optional(),
        errorCode: z.string().optional(),
        errorDescription: z.string().optional(),
      }),
    )
    .default([]),
  sessionDescription: z.object({ sdp: z.string(), type: z.enum(["offer", "answer"]) }).optional(),
});

// A failed SFU HTTP call (non-2xx). Surfaced to the route, which maps it to an enveloped error — no
// retries in v1 (§7.1). Carries the upstream status so the route can log/telemeter the failure.
export class RealtimeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeError";
  }
}

class HttpRealtimeClient implements RealtimeClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /* oxlint-disable no-await-in-loop -- the retry loop is deliberately sequential: each attempt only
     exists because the previous one failed */
  private async request(method: "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    // No body → no content-type and no payload: the SFU rejects `{}` on body-less endpoints
    // (sessions/new answers 400 decoding_error when any JSON body is present).
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.appSecret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(`${BASE_URL}/apps/${this.appId}${path}`, init);
      } catch (err) {
        // fetch itself threw (connection reset / DNS blip) — transient by definition.
        if (attempt >= RETRY_DELAYS_MS.length) {
          throw new RealtimeError(0, `SFU ${method} ${path} → fetch failed: ${String(err)}`);
        }
      }
      if (res?.ok) return res.json();
      const status = res?.status ?? 0;
      // 4xx = semantic rejection, never retried; 5xx/thrown = transient, bounded retry (header note).
      const transient = res === null || status >= 500;
      if (!transient || attempt >= RETRY_DELAYS_MS.length) {
        throw new RealtimeError(status, `SFU ${method} ${path} → ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  /* oxlint-enable no-await-in-loop */

  async newSession(): Promise<{ sessionId: string }> {
    return sessionNewSchema.parse(await this.request("POST", `/sessions/new`));
  }

  async newLocalTracks(
    sessionId: string,
    offer: SessionDescription,
    tracks: LocalTrackReq[],
  ): Promise<TracksNewResponse> {
    return asResponse(
      tracksNewSchema.parse(
        await this.request("POST", `/sessions/${sessionId}/tracks/new`, {
          sessionDescription: offer,
          tracks,
        }),
      ),
    );
  }

  async newRemoteTracks(sessionId: string, tracks: RemoteTrackReq[]): Promise<TracksNewResponse> {
    return asResponse(
      tracksNewSchema.parse(
        await this.request("POST", `/sessions/${sessionId}/tracks/new`, { tracks }),
      ),
    );
  }

  async renegotiate(sessionId: string, answer: SessionDescription): Promise<void> {
    await this.request("PUT", `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: answer,
    });
  }

  async updateTrack(sessionId: string, mid: string, simulcast: SimulcastPrefs): Promise<void> {
    await this.request("PUT", `/sessions/${sessionId}/tracks/update`, {
      tracks: [{ mid, simulcast }],
    });
  }

  async closeTracks(
    sessionId: string,
    mids: string[],
    offer?: SessionDescription,
    force?: boolean,
  ): Promise<TracksNewResponse> {
    return asResponse(
      tracksNewSchema.parse(
        await this.request("PUT", `/sessions/${sessionId}/tracks/close`, {
          tracks: mids.map((mid) => ({ mid })),
          force: force ?? false,
          ...(offer === undefined ? {} : { sessionDescription: offer }),
        }),
      ),
    );
  }
}

// Rebuilds a clean TracksNewResponse from the parsed SFU body, OMITTING absent optionals (zod yields
// `field?: T | undefined`; TracksNewResponse's optionals are `field?: T` under exactOptionalPropertyTypes).
function asResponse(parsed: z.infer<typeof tracksNewSchema>): TracksNewResponse {
  return {
    requiresImmediateRenegotiation: parsed.requiresImmediateRenegotiation,
    tracks: parsed.tracks.map((t) => ({
      ...(t.trackName === undefined ? {} : { trackName: t.trackName }),
      ...(t.mid === undefined ? {} : { mid: t.mid }),
      ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }),
      ...(t.errorCode === undefined ? {} : { errorCode: t.errorCode }),
      ...(t.errorDescription === undefined ? {} : { errorDescription: t.errorDescription }),
    })),
    ...(parsed.sessionDescription === undefined
      ? {}
      : { sessionDescription: parsed.sessionDescription }),
  };
}

// The single factory (pinned signature). Mock when TAVERN_SFU_MOCK==='1' (local test / e2e with no
// media plane, PLAN §10); otherwise the real HTTP client bound to the app id + secret.
export function createRealtimeClient(env: RealtimeEnv): RealtimeClient {
  if (env.TAVERN_SFU_MOCK === "1") return createRealtimeMock();
  return new HttpRealtimeClient(
    requiredEnv(env.REALTIME_APP_ID, "REALTIME_APP_ID"),
    requiredEnv(env.REALTIME_APP_SECRET, "REALTIME_APP_SECRET"),
  );
}
