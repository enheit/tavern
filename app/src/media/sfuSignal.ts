import { IceServersResponse, RtcSessionResponse, RtcTracksResponse } from "@tavern/shared";
import type { ApiClient } from "@/lib/apiClient";

// Thin apiClient wrapper over the §6.1 rtc routes. The client sends only its own (puller/publisher)
// sessionId as a query param + the track names; the Worker proxy (S7.1) resolves publisher sessions,
// enforces caps (§8), and passes SFU calls through. RtcTracksResponse is the pinned worker response.
export interface SfuSignal {
  newSession(serverId: string): Promise<{ sessionId: string }>;
  publishTracks(
    serverId: string,
    sessionId: string,
    offer: RTCSessionDescriptionInit,
    tracks: Array<{ mid: string; trackName: string }>,
  ): Promise<RtcTracksResponse>;
  pullTracks(
    serverId: string,
    sessionId: string,
    tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>,
  ): Promise<RtcTracksResponse>;
  renegotiate(
    serverId: string,
    sessionId: string,
    answer: RTCSessionDescriptionInit,
  ): Promise<void>;
  updateLayer(
    serverId: string,
    sessionId: string,
    mid: string,
    trackName: string,
    preferredRid: "h" | "l",
  ): Promise<void>;
  closeTracks(
    serverId: string,
    sessionId: string,
    mids: string[],
    offer?: RTCSessionDescriptionInit,
  ): Promise<void>;
  getIceServers(): Promise<RTCIceServer[]>;
}

// Accepts any ack body and yields void — the renegotiate / tracks-update / close routes resolve to
// void per the pinned SfuSignal interface (no shared response schema; the client applied the SDP).
const voidParser = { safeParse: () => ({ success: true as const, data: undefined }) };

export function createSfuSignal(api: ApiClient): SfuSignal {
  return {
    newSession: (serverId) => api.post(`/api/rtc/${serverId}/session`, RtcSessionResponse),
    publishTracks: (serverId, sessionId, offer, tracks) =>
      api.post(`/api/rtc/${serverId}/tracks?session=${sessionId}`, RtcTracksResponse, {
        sessionDescription: offer,
        tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })),
      }),
    pullTracks: (serverId, sessionId, tracks) =>
      api.post(`/api/rtc/${serverId}/tracks?session=${sessionId}`, RtcTracksResponse, {
        tracks: tracks.map((t) => ({
          location: "remote",
          trackName: t.trackName,
          ...(t.preferredRid ? { simulcast: { preferredRid: t.preferredRid } } : {}),
        })),
      }),
    renegotiate: async (serverId, sessionId, answer) => {
      await api.put(`/api/rtc/${serverId}/renegotiate?session=${sessionId}`, voidParser, {
        sessionDescription: answer,
      });
    },
    updateLayer: async (serverId, sessionId, mid, trackName, preferredRid) => {
      // trackName lets the Worker/DO reprice this watcher's egress (op:'layer', G5 / FR-33).
      await api.put(`/api/rtc/${serverId}/tracks/update?session=${sessionId}`, voidParser, {
        tracks: [{ mid, trackName, simulcast: { preferredRid } }],
      });
    },
    closeTracks: async (serverId, sessionId, mids, offer) => {
      await api.post(`/api/rtc/${serverId}/close?session=${sessionId}`, voidParser, {
        tracks: mids.map((mid) => ({ mid })),
        force: offer === undefined,
        ...(offer ? { sessionDescription: offer } : {}),
      });
    },
    getIceServers: async () => {
      const { iceServers } = await api.get("/api/rtc/ice", IceServersResponse);
      // Omit absent credentials rather than pass `undefined` (exactOptionalPropertyTypes vs zod optional).
      return iceServers.map((s) => ({
        urls: s.urls,
        ...(s.username === undefined ? {} : { username: s.username }),
        ...(s.credential === undefined ? {} : { credential: s.credential }),
      }));
    },
  };
}
