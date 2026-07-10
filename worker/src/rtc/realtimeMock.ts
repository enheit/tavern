import sessionNewTemplate from "../../test/fixtures/sfu/session-new.json";
import tracksNewLocalTemplate from "../../test/fixtures/sfu/tracks-new-local.json";
import tracksNewRemoteTemplate from "../../test/fixtures/sfu/tracks-new-remote.json";
import tracksCloseTemplate from "../../test/fixtures/sfu/tracks-close.json";
import type { LocalTrackReq, RealtimeClient, RemoteTrackReq, TracksNewResponse } from "./realtime";

// Deterministic in-process stand-in for the Realtime SFU (TAVERN_SFU_MOCK==='1', PLAN §10). The
// fixture JSON holds ONLY the static template bodies; every DYNAMIC field (the per-run sessionId
// counter, echoing request mids / trackNames back) lives here, filling the template. There is NO
// media plane — the returned SDP is a static valid offer/answer so the browser can still
// setRemoteDescription in a mocked e2e (state/signaling assertions only, §10 hermeticity split).

// Every SFU op is appended here so a worker test can assert the proxy forwarded the right call with
// the right verb/payload (the "mock called with PUT payloads" assertion). `method` records the pinned
// §7.1 verb of each op (POST for sessions/new + tracks/new, PUT for renegotiate/update/close).
export type SfuMockCall = {
  op:
    | "newSession"
    | "newLocalTracks"
    | "newRemoteTracks"
    | "renegotiate"
    | "updateTrack"
    | "closeTracks";
  method: "POST" | "PUT";
  sessionId?: string;
  payload: unknown;
};

export const sfuMockCalls: SfuMockCall[] = [];

// Tests call this in a beforeEach so the shared module-level log + counter start clean each test.
export function resetSfuMock(): void {
  sfuMockCalls.length = 0;
  sessionCounter = 0;
}

let sessionCounter = 0;

// Substitutes the incrementing <n> into the template's trailing digits ("mock-sess-0" → "mock-sess-3").
function nextSessionId(): string {
  const id = sessionNewTemplate.sessionId.replace(/\d+$/, String(sessionCounter));
  sessionCounter += 1;
  return id;
}

export function createRealtimeMock(): RealtimeClient {
  return {
    newSession: async () => {
      const sessionId = nextSessionId();
      sfuMockCalls.push({ op: "newSession", method: "POST", sessionId, payload: {} });
      return { sessionId };
    },

    newLocalTracks: async (
      sessionId: string,
      offer,
      tracks: LocalTrackReq[],
    ): Promise<TracksNewResponse> => {
      sfuMockCalls.push({
        op: "newLocalTracks",
        method: "POST",
        sessionId,
        payload: { sessionDescription: offer, tracks },
      });
      return {
        requiresImmediateRenegotiation: tracksNewLocalTemplate.requiresImmediateRenegotiation,
        // Echo the request mids so the client can map trackName → mid (matches the live SFU).
        tracks: tracks.map((t) => ({ trackName: t.trackName, mid: t.mid })),
        sessionDescription: {
          type: "answer",
          sdp: tracksNewLocalTemplate.sessionDescription.sdp,
        },
      };
    },

    newRemoteTracks: async (
      sessionId: string,
      tracks: RemoteTrackReq[],
    ): Promise<TracksNewResponse> => {
      sfuMockCalls.push({
        op: "newRemoteTracks",
        method: "POST",
        sessionId,
        payload: { tracks },
      });
      return {
        requiresImmediateRenegotiation: tracksNewRemoteTemplate.requiresImmediateRenegotiation,
        // Echo the requested trackNames (pull typically requires an immediate renegotiation).
        tracks: tracks.map((t) => ({ trackName: t.trackName })),
        sessionDescription: {
          type: "offer",
          sdp: tracksNewRemoteTemplate.sessionDescription.sdp,
        },
      };
    },

    renegotiate: async (sessionId: string, answer): Promise<void> => {
      sfuMockCalls.push({
        op: "renegotiate",
        method: "PUT",
        sessionId,
        payload: { sessionDescription: answer },
      });
    },

    updateTrack: async (sessionId: string, mid: string, simulcast): Promise<void> => {
      sfuMockCalls.push({
        op: "updateTrack",
        method: "PUT",
        sessionId,
        payload: { mid, simulcast },
      });
    },

    closeTracks: async (
      sessionId: string,
      mids: string[],
      offer,
      force,
    ): Promise<TracksNewResponse> => {
      sfuMockCalls.push({
        op: "closeTracks",
        method: "PUT",
        sessionId,
        payload: { mids, offer, force },
      });
      // tracks-close.json is the static empty ack; fill the type-required fields around it.
      return { requiresImmediateRenegotiation: false, tracks: [], ...tracksCloseTemplate };
    },
  };
}
