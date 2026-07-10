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
  midCounter = 0;
}

let sessionCounter = 0;

// Globally-unique mid per pulled track. The live SFU returns a mid for every pulled track (the m-line
// index in the accumulated SDP); the client keys its trackName→mid map (and therefore the FR-33
// `tracks/update` layer switch, S8.5) off it. Monotonic + unique so a session that pulls several tracks
// never collides — matching the live SFU contract without a real media plane.
let midCounter = 0;
function nextMid(): string {
  const mid = String(midCounter);
  midCounter += 1;
  return mid;
}

// Substitutes the incrementing <n> into the template's trailing digits ("mock-sess-0" → "mock-sess-3").
function nextSessionId(): string {
  const id = sessionNewTemplate.sessionId.replace(/\d+$/, String(sessionCounter));
  sessionCounter += 1;
  return id;
}

// Turns the client's publish OFFER into a structurally-valid ANSWER. The browser's
// setRemoteDescription requires the answer to have exactly one m-line per offered m-line, so a fixed
// single-m-line template cannot answer a multi-track publish (a screen share adds video + screenAudio
// transceivers alongside the mic → a 3-m-line offer). There is no media plane: we echo the offer's
// m-lines/mids/BUNDLE, flip the DTLS role (answer must not be `actpass`) + the media direction
// (sendonly → recvonly), and swap in the mock ICE creds/fingerprint (ICE never connects, exactly like
// the prior static answer — publishState reaches `connected` at setRemoteDescription, before ICE).
const MOCK_ICE_PWD = "mockpwdmockpwdmockpwdmock";
const MOCK_FINGERPRINT =
  "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF";
function offerToAnswer(offerSdp: string): string {
  return offerSdp
    .replace(/a=setup:actpass/g, "a=setup:active")
    .replace(/a=ice-ufrag:\S+/g, "a=ice-ufrag:mock")
    .replace(/a=ice-pwd:\S+/g, `a=ice-pwd:${MOCK_ICE_PWD}`)
    .replace(/a=fingerprint:sha-256 \S+/g, `a=fingerprint:sha-256 ${MOCK_FINGERPRINT}`)
    .replace(/a=sendrecv/g, "a=recvonly")
    .replace(/a=sendonly/g, "a=recvonly");
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
        // Derive the answer from the client's offer so the m-line count matches (multi-track publishes).
        sessionDescription: { type: "answer", sdp: offerToAnswer(offer.sdp) },
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
        // Echo the requested trackNames + a synthetic mid each (the live SFU returns a mid per pulled
        // track; the client needs it for the trackName→mid map + the FR-33 layer switch — S8.5).
        tracks: tracks.map((t) => ({ trackName: t.trackName, mid: nextMid() })),
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
