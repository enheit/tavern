import { IceServersResponse, RtcSessionResponse, RtcTracksResponse } from "@tavern/shared";
import type { PresetId, ScreenRid, ScreenSimulcastProfile } from "@tavern/shared";
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
    tracks: Array<{
      mid: string;
      trackName: string;
      preset?: PresetId;
      simulcastProfile?: ScreenSimulcastProfile;
    }>,
  ): Promise<RtcTracksResponse>;
  confirmPublishedTracks(serverId: string, sessionId: string, publicationId: string): Promise<void>;
  abortPublishedTracks(serverId: string, sessionId: string, publicationId: string): Promise<void>;
  pullTracks(
    serverId: string,
    sessionId: string,
    tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>,
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
    preferredRid: ScreenRid,
  ): Promise<void>;
  closeTracks(
    serverId: string,
    sessionId: string,
    mids: string[],
    offer?: RTCSessionDescriptionInit,
  ): Promise<RtcTracksResponse>;
  getIceServers(): Promise<RTCIceServer[]>;
}

// Accepts any ack body and yields void — publish acknowledgement, renegotiate, and tracks-update
// resolve to empty objects. Track close is different: Cloudflare may require an immediate SDP
// exchange, so that response is validated with RtcTracksResponse below.
const voidParser = { safeParse: () => ({ success: true as const, data: undefined }) };
const ICE_CACHE_MS = 20 * 60_000;
type IceCacheEntry = {
  servers: RTCIceServer[] | null;
  expiresAt: number;
  pending: Promise<RTCIceServer[]> | null;
};
const iceCache = new WeakMap<ApiClient, IceCacheEntry>();

async function cachedIceServers(api: ApiClient): Promise<RTCIceServer[]> {
  const now = Date.now();
  const cached = iceCache.get(api);
  if (cached !== undefined && cached.servers !== null && cached.expiresAt > now) {
    return cached.servers;
  }
  if (cached?.pending) return cached.pending;

  const pending = api.get("/api/rtc/ice", IceServersResponse).then(({ iceServers }) =>
    iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    })),
  );
  iceCache.set(api, {
    servers: cached?.servers ?? null,
    expiresAt: cached?.expiresAt ?? 0,
    pending,
  });
  try {
    const servers = await pending;
    iceCache.set(api, { servers, expiresAt: Date.now() + ICE_CACHE_MS, pending: null });
    return servers;
  } catch (error) {
    iceCache.delete(api);
    throw error;
  }
}

export function createSfuSignal(api: ApiClient): SfuSignal {
  return {
    newSession: (serverId) =>
      api.post(`/api/rtc/${serverId}/session`, RtcSessionResponse, { mediaReadyVersion: 2 }),
    publishTracks: (serverId, sessionId, offer, tracks) =>
      api.post(`/api/rtc/${serverId}/tracks?session=${sessionId}`, RtcTracksResponse, {
        sessionDescription: offer,
        tracks: tracks.map((t) => ({
          location: "local",
          mid: t.mid,
          trackName: t.trackName,
          ...(t.preset === undefined ? {} : { preset: t.preset }),
          ...(t.simulcastProfile === undefined ? {} : { simulcastProfile: t.simulcastProfile }),
        })),
      }),
    confirmPublishedTracks: async (serverId, sessionId, publicationId) => {
      await api.post(`/api/rtc/${serverId}/tracks/ready?session=${sessionId}`, voidParser, {
        publicationId,
      });
    },
    abortPublishedTracks: async (serverId, sessionId, publicationId) => {
      await api.post(`/api/rtc/${serverId}/tracks/abort?session=${sessionId}`, voidParser, {
        publicationId,
      });
    },
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
    closeTracks: (serverId, sessionId, mids, offer) =>
      api.post(`/api/rtc/${serverId}/close?session=${sessionId}`, RtcTracksResponse, {
        tracks: mids.map((mid) => ({ mid })),
        force: offer === undefined,
        ...(offer ? { sessionDescription: offer } : {}),
      }),
    getIceServers: () => cachedIceServers(api),
  };
}
