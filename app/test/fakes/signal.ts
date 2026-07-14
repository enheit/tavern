import type {
  PresetId,
  RtcTracksResponse,
  ScreenRid,
  ScreenSimulcastProfile,
} from "@tavern/shared";
import type { SfuSignal } from "@/media/sfuSignal";
import { EventLog } from "./log";

// Implements SfuSignal with recorded calls + configurable canned responses. No casts — it satisfies
// the pinned interface structurally, so the RTC sessions consume it exactly as the real signal.
export class FakeSignal implements SfuSignal {
  readonly log: EventLog;
  readonly published: {
    sessionId: string;
    offer: RTCSessionDescriptionInit;
    tracks: Array<{
      mid: string;
      trackName: string;
      preset?: PresetId;
      simulcastProfile?: ScreenSimulcastProfile;
    }>;
  }[] = [];
  readonly pulled: {
    sessionId: string;
    tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>;
  }[] = [];
  readonly renegotiated: RTCSessionDescriptionInit[] = [];
  readonly layerUpdates: { mid: string; rid: ScreenRid }[] = [];
  readonly closedTracks: { mids: string[]; offer?: RTCSessionDescriptionInit }[] = [];
  readonly confirmedPublications: string[] = [];
  readonly abortedPublications: string[] = [];
  private sessionCounter = 0;

  publishResponse: RtcTracksResponse = {
    requiresImmediateRenegotiation: false,
    tracks: [],
    sessionDescription: { type: "answer", sdp: "sfu-answer" },
  };

  pullResponse: RtcTracksResponse = {
    requiresImmediateRenegotiation: true,
    tracks: [],
    sessionDescription: { type: "offer", sdp: "sfu-offer" },
  };

  closeResponse: RtcTracksResponse = {
    requiresImmediateRenegotiation: false,
    tracks: [],
  };

  iceServers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

  constructor(log?: EventLog) {
    this.log = log ?? new EventLog();
  }

  newSession(serverId: string): Promise<{ sessionId: string }> {
    void serverId;
    this.log.record("newSession");
    this.sessionCounter += 1;
    return Promise.resolve({ sessionId: `sess-${this.sessionCounter}` });
  }

  publishTracks(
    _serverId: string,
    sessionId: string,
    offer: RTCSessionDescriptionInit,
    tracks: Array<{
      mid: string;
      trackName: string;
      preset?: PresetId;
      simulcastProfile?: ScreenSimulcastProfile;
    }>,
  ): Promise<RtcTracksResponse> {
    this.log.record("publishTracks");
    this.published.push({ sessionId, offer, tracks });
    return Promise.resolve(
      this.publishResponse.tracks.length === 0
        ? {
            ...this.publishResponse,
            tracks: tracks.map((track) => ({ trackName: track.trackName, mid: track.mid })),
          }
        : this.publishResponse,
    );
  }

  confirmPublishedTracks(
    _serverId: string,
    _sessionId: string,
    publicationId: string,
  ): Promise<void> {
    this.log.record("confirmPublishedTracks");
    this.confirmedPublications.push(publicationId);
    return Promise.resolve();
  }

  abortPublishedTracks(
    _serverId: string,
    _sessionId: string,
    publicationId: string,
  ): Promise<void> {
    this.log.record("abortPublishedTracks");
    this.abortedPublications.push(publicationId);
    return Promise.resolve();
  }

  pullTracks(
    _serverId: string,
    sessionId: string,
    tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>,
  ): Promise<RtcTracksResponse> {
    this.log.record("pullTracks");
    this.pulled.push({ sessionId, tracks });
    return Promise.resolve(this.pullResponse);
  }

  renegotiate(
    _serverId: string,
    _sessionId: string,
    answer: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.log.record("renegotiate");
    this.renegotiated.push(answer);
    return Promise.resolve();
  }

  updateLayer(
    _serverId: string,
    _sessionId: string,
    mid: string,
    _trackName: string,
    preferredRid: ScreenRid,
  ): Promise<void> {
    this.log.record("updateLayer");
    this.layerUpdates.push({ mid, rid: preferredRid });
    return Promise.resolve();
  }

  closeTracks(
    _serverId: string,
    _sessionId: string,
    mids: string[],
    offer?: RTCSessionDescriptionInit,
  ): Promise<RtcTracksResponse> {
    this.log.record("closeTracks");
    this.closedTracks.push(offer ? { mids, offer } : { mids });
    return Promise.resolve(this.closeResponse);
  }

  getIceServers(): Promise<RTCIceServer[]> {
    this.log.record("getIceServers");
    return Promise.resolve(this.iceServers);
  }
}
