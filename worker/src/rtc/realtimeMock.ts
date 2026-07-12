import sessionNewTemplate from "../../test/fixtures/sfu/session-new.json";
import tracksNewLocalTemplate from "../../test/fixtures/sfu/tracks-new-local.json";
import tracksCloseTemplate from "../../test/fixtures/sfu/tracks-close.json";
import type { LocalTrackReq, RealtimeClient, RemoteTrackReq, TracksNewResponse } from "./realtime";

// Deterministic in-process stand-in for the Realtime SFU (TAVERN_SFU_MOCK==='1', PLAN §10). There
// is NO media plane (the SDP carries no ICE candidates, so connections never establish and no RTP
// flows) — but the SIGNALING mirrors the live SFU:
//   · a global published-track registry: pulling a trackName no publisher has registered answers
//     200 with a PER-TRACK errorCode (exactly how the live SFU rejects a pull racing the
//     publisher's own tracks/new) — the D1 audibility fix's client retry is exercised by this;
//   · per-session pull state: each pull APPENDS m-lines to that session's offer SDP (the live SFU
//     offers the full accumulated session), with a=mid matching the response mids — so a client
//     pulling several mics negotiates them all and its `track` events fire with the right names;
//   · tracks/close marks pulled m-lines inactive (m-line order is immutable per JSEP) and
//     unregisters published tracks by mid.
// The fixture JSON holds only static template bodies; all dynamic state lives here.

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

type PullLine = { mid: string; trackName: string; kind: "audio" | "video"; closed: boolean };
type SessionState = {
  pulls: PullLine[];
  publishedMids: Map<string, string>; // mid → trackName (this session's own publishes)
  sdpVersion: number;
};

// Global mock-SFU state: which trackNames are currently live (registered by a publisher session)
// and each session's accumulated pull/publish state. Module-level like the call log — worker tests
// reset it in beforeEach; each e2e wrangler run starts a fresh isolate.
const publishedTracks = new Map<string, { sessionId: string }>();
const sessions = new Map<string, SessionState>();

// Isolate identity (lazy — randomness is forbidden in workerd's global scope): module state is
// per-isolate, so the /api/__test/sfu-mock-state readout tags itself with this id. Two different
// ids across calls in one wrangler run = the registry is split across isolates.
let isolateIdValue = "";
function isolateId(): string {
  if (isolateIdValue === "") isolateIdValue = crypto.randomUUID().slice(0, 8);
  return isolateIdValue;
}

// Test/diagnostics readout for /api/__test/sfu-mock-state (never mounted in production).
export function sfuMockStateForTest(): {
  isolateId: string;
  published: string[];
  sessions: number;
} {
  return {
    isolateId: isolateId(),
    published: [...publishedTracks.keys()],
    sessions: sessions.size,
  };
}

// Tests call this in a beforeEach so the shared module-level log + state start clean each test.
export function resetSfuMock(): void {
  sfuMockCalls.length = 0;
  sessionCounter = 0;
  publishedTracks.clear();
  sessions.clear();
}

let sessionCounter = 0;

// Substitutes the incrementing <n> into the template's trailing digits ("mock-sess-0" → "mock-sess-3").
function nextSessionId(): string {
  const id = sessionNewTemplate.sessionId.replace(/\d+$/, String(sessionCounter));
  sessionCounter += 1;
  return id;
}

function sessionState(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (state === undefined) {
    state = { pulls: [], publishedMids: new Map(), sdpVersion: 1 };
    sessions.set(sessionId, state);
  }
  return state;
}

// Track kind from the pinned §7.1 name grammar — mic/screenAudio are audio, screen/cam video.
function kindOf(trackName: string): "audio" | "video" {
  return trackName.startsWith("mic:") || trackName.startsWith("screenAudio:") ? "audio" : "video";
}

// msid-id is a token (RFC 8830) — ':' from the track-name grammar is not a token char.
function msidOf(trackName: string): string {
  return trackName.replace(/[^0-9A-Za-z._-]/g, "_");
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

// The session's full pull offer: one m-line per pulled track EVER (JSEP m-line order is immutable —
// closed pulls stay, flipped to inactive), a=mid matching the mids echoed in the tracks response,
// a=msid so the browser surfaces a remote stream in the `track` event. No a=candidate lines: ICE
// never starts checking, so mock connections never reach 'failed' (the controller's transport
// auto-recover stays silent under the PR harness by design).
function buildPullOffer(state: SessionState): string {
  const mids = state.pulls.map((p) => p.mid).join(" ");
  const head = [
    "v=0",
    `o=- 4611731400430051336 ${state.sdpVersion} IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mids}`,
    "a=msid-semantic: WMS",
  ];
  const media = state.pulls.flatMap((p) => [
    p.kind === "audio" ? "m=audio 9 UDP/TLS/RTP/SAVPF 111" : "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:mock",
    `a=ice-pwd:${MOCK_ICE_PWD}`,
    `a=fingerprint:sha-256 ${MOCK_FINGERPRINT}`,
    "a=setup:actpass",
    `a=mid:${p.mid}`,
    p.closed ? "a=inactive" : "a=sendonly",
    // msid is UNIQUE PER M-LINE (suffixed with the mid): a re-pull of the same trackName after a
    // close otherwise repeats the previous (now inactive) m-line's msid and Chrome rejects the
    // whole offer — "Duplicate a=msid lines detected" (found by the Task-1 leave/rejoin e2e).
    `a=msid:${msidOf(p.trackName)}_${p.mid} ${msidOf(p.trackName)}_${p.mid}-t`,
    "a=rtcp-mux",
    p.kind === "audio" ? "a=rtpmap:111 opus/48000/2" : "a=rtpmap:96 VP8/90000",
  ]);
  return `${[...head, ...media].join("\r\n")}\r\n`;
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
      const state = sessionState(sessionId);
      // Register each published name as live (a re-publish under the same name replaces the owner
      // session — the previous session's track is dead, exactly like the live SFU after a rejoin).
      for (const t of tracks) {
        publishedTracks.set(t.trackName, { sessionId });
        state.publishedMids.set(t.mid, t.trackName);
      }
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
      const state = sessionState(sessionId);
      const results: TracksNewResponse["tracks"] = [];
      let added = false;
      for (const t of tracks) {
        // Mirror the live SFU: a pull for a track no publisher session has registered is a 200 with
        // a per-track error, not an HTTP failure. (DO-registry-authorized pulls can still race the
        // publisher's own tracks/new — the client's PullTracksError retry covers exactly this.)
        if (!publishedTracks.has(t.trackName)) {
          results.push({
            trackName: t.trackName,
            errorCode: "track_not_found",
            errorDescription: "mock: no live publisher for this trackName",
          });
          continue;
        }
        const mid = String(state.pulls.length);
        state.pulls.push({ mid, trackName: t.trackName, kind: kindOf(t.trackName), closed: false });
        results.push({ trackName: t.trackName, mid });
        added = true;
      }
      if (!added) return { requiresImmediateRenegotiation: false, tracks: results };
      state.sdpVersion += 1;
      return {
        requiresImmediateRenegotiation: true,
        tracks: results,
        sessionDescription: { type: "offer", sdp: buildPullOffer(state) },
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
      const state = sessionState(sessionId);
      for (const mid of mids) {
        // A publisher closing its own track takes the name off the live registry (peers' later
        // pulls per-track-error); a puller closing flips its m-line inactive.
        const published = state.publishedMids.get(mid);
        if (published !== undefined) {
          state.publishedMids.delete(mid);
          if (publishedTracks.get(published)?.sessionId === sessionId) {
            publishedTracks.delete(published);
          }
        }
        const pull = state.pulls.find((p) => p.mid === mid);
        if (pull !== undefined) pull.closed = true;
      }
      // tracks-close.json is the static empty ack; fill the type-required fields around it.
      return { requiresImmediateRenegotiation: false, tracks: [], ...tracksCloseTemplate };
    },
  };
}
