import type { RtcTracksResponse } from "@tavern/shared";
import type { SfuSignal } from "@/media/sfuSignal";
import { EventLog } from "./log";

// Implements SfuSignal with recorded calls + configurable canned responses. No casts — it satisfies
// the pinned interface structurally, so the RTC sessions consume it exactly as the real signal.
export class FakeSignal implements SfuSignal {
  readonly log: EventLog;
  readonly published: {
    sessionId: string;
    offer: RTCSessionDescriptionInit;
    tracks: Array<{ mid: string; trackName: string }>;
  }[] = [];
  readonly pulled: {
    sessionId: string;
    tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>;
  }[] = [];
  readonly renegotiated: RTCSessionDescriptionInit[] = [];
  readonly layerUpdates: { mid: string; rid: "h" | "l" }[] = [];
  readonly closedTracks: { mids: string[]; offer?: RTCSessionDescriptionInit }[] = [];
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
    tracks: Array<{ mid: string; trackName: string }>,
  ): Promise<RtcTracksResponse> {
    this.log.record("publishTracks");
    this.published.push({ sessionId, offer, tracks });
    return Promise.resolve(this.publishResponse);
  }

  pullTracks(
    _serverId: string,
    sessionId: string,
    tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>,
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
    preferredRid: "h" | "l",
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
  ): Promise<void> {
    this.log.record("closeTracks");
    this.closedTracks.push(offer ? { mids, offer } : { mids });
    return Promise.resolve();
  }

  getIceServers(): Promise<RTCIceServer[]> {
    this.log.record("getIceServers");
    return Promise.resolve(this.iceServers);
  }
}
