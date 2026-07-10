import { platform } from "@/platform/types";
import type { RtcPort } from "../ports";
import type { SfuSignal } from "../sfuSignal";

export type PullState = "idle" | "connecting" | "connected" | "renegotiating" | "closed" | "failed";

type TrackCb = (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void;

// One instance per watched stream (watchPC) + one shared 'voicePull' instance (PLAN §7.1). The SFU
// is the SDP offerer on pull — the client answers (do not invert). Every SDP-mutating op is chained
// on `queue` (one serialization point per session). A layer switch is tracks/update, never a re-pull.
export class PullSession {
  private readonly rtc: RtcPort;
  private readonly signal: SfuSignal;
  private readonly serverId: string;
  private pc: RTCPeerConnection | null = null;
  private sessionIdRef: string | null = null;
  private stateValue: PullState = "idle";
  private queue: Promise<unknown> = Promise.resolve();
  private readonly midToName = new Map<string, string>();
  private readonly nameToMid = new Map<string, string>();
  private readonly stateListeners = new Set<(s: PullState) => void>();
  private readonly trackListeners = new Set<TrackCb>();

  constructor(deps: { rtc: RtcPort; signal: SfuSignal; serverId: string }) {
    this.rtc = deps.rtc;
    this.signal = deps.signal;
    this.serverId = deps.serverId;
  }

  get state(): PullState {
    return this.stateValue;
  }

  onStateChange(cb: (s: PullState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  onTrack(cb: TrackCb): () => void {
    this.trackListeners.add(cb);
    return () => {
      this.trackListeners.delete(cb);
    };
  }

  private setState(s: PullState): void {
    this.stateValue = s;
    for (const cb of this.stateListeners) cb(s);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requirePc(): RTCPeerConnection {
    if (!this.pc) throw new Error("PullSession not connected");
    return this.pc;
  }

  private requireSession(): string {
    if (this.sessionIdRef === null) throw new Error("PullSession has no session");
    return this.sessionIdRef;
  }

  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      const iceServers = await this.signal.getIceServers();
      const pc = this.rtc.createPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") this.setState("failed");
      });
      pc.addEventListener("track", (ev) => {
        const mid = ev.transceiver.mid;
        const trackName = mid === null ? undefined : this.midToName.get(mid);
        const stream = ev.streams[0];
        if (trackName && stream)
          for (const cb of this.trackListeners) cb(trackName, ev.track, stream);
      });
      this.pc = pc;
      const { sessionId } = await this.signal.newSession(this.serverId);
      this.sessionIdRef = sessionId;
      this.setState("connected");
    } catch (err) {
      this.setState("failed");
      throw err;
    }
  }

  async addRemoteTracks(
    tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>,
  ): Promise<void> {
    await this.enqueue(async () => {
      const pc = this.requirePc();
      const sessionId = this.requireSession();
      this.setState("renegotiating");
      try {
        const response = await this.signal.pullTracks(this.serverId, sessionId, tracks);
        for (const t of response.tracks) {
          if (t.mid) {
            this.midToName.set(t.mid, t.trackName);
            this.nameToMid.set(t.trackName, t.mid);
          }
        }
        // Pulls typically require an immediate renegotiation: apply the SFU offer, answer, PUT it.
        if (response.requiresImmediateRenegotiation && response.sessionDescription) {
          await pc.setRemoteDescription(response.sessionDescription);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.signal.renegotiate(this.serverId, sessionId, answer);
        }
        this.setState("connected");
      } catch (err) {
        this.setState("failed");
        throw err;
      }
    });
  }

  async removeRemoteTracks(trackNames: string[]): Promise<void> {
    await this.enqueue(async () => {
      const sessionId = this.requireSession();
      const mids: string[] = [];
      for (const name of trackNames) {
        const mid = this.nameToMid.get(name);
        if (!mid) continue;
        mids.push(mid);
        this.midToName.delete(mid);
        this.nameToMid.delete(name);
      }
      if (mids.length > 0) await this.signal.closeTracks(this.serverId, sessionId, mids);
    });
  }

  // FR-33: quality follows tile size via simulcast — tracks/update on the existing pull, no SDP op.
  // The trackName rides along so the Worker/DO can reprice this watcher's egress (op:'layer', G5).
  async setLayer(trackName: string, rid: "h" | "l"): Promise<void> {
    const mid = this.nameToMid.get(trackName);
    if (!mid) throw new Error(`no pulled track ${trackName}`);
    // §10 e2e hook: record each switch so S8.5's FR-33 spec can assert the layer request happened
    // (mirrors soundboardPlayer's platform.isE2E window write). Installed only under the harness.
    if (platform.isE2E && typeof window !== "undefined") {
      // oxlint-disable-next-line no-underscore-dangle -- pinned §10 e2e hook global window.__tavernTestRtc
      window.__tavernTestRtc?.layerCalls.push({ trackName, rid });
    }
    await this.signal.updateLayer(this.serverId, this.requireSession(), mid, trackName, rid);
  }

  // Read-only inbound-rtp audio summary of this pull PC — the source for the pinned §10 e2e
  // voice-stats hook (see app/src/lib/testHooks.ts; FR-19's real-SFU getStats AC). Reads existing
  // WebRTC stats only;
  // adds no engine capability (mirrors S7.3's read-only `micSender()` on PublishSession). Fields are
  // narrowed with `in`/`typeof` because the RTCStats base type does not declare the audio members
  // (no `as`-casts, §9.1).
  async inboundAudioStats(): Promise<{ bytesReceived: number; audioLevel: number | null }> {
    const pc = this.pc;
    if (!pc) return { bytesReceived: 0, audioLevel: null };
    const report = await pc.getStats();
    let bytesReceived = 0;
    let audioLevel: number | null = null;
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "audio") return;
      if ("bytesReceived" in stat && typeof stat.bytesReceived === "number") {
        bytesReceived += stat.bytesReceived;
      }
      if ("audioLevel" in stat && typeof stat.audioLevel === "number") {
        audioLevel = stat.audioLevel;
      }
    });
    return { bytesReceived, audioLevel };
  }

  // Read-only inbound-rtp VIDEO summary of this watch pull PC — the source for the pinned §10 @realtime
  // streams hook (FR-27/32/33 real-media getStats: framesDecoded increases, frameHeight tracks the
  // simulcast layer / preset). Reads existing WebRTC stats only; narrowed with `in`/`typeof` because
  // RTCStats does not declare the video members (no `as`-casts, §9.1). Not exercised under the mock
  // (no media plane) — the PR streams spec asserts signaling/state instead.
  async inboundVideoStats(): Promise<{ framesDecoded: number; frameHeight: number | null }> {
    const pc = this.pc;
    if (!pc) return { framesDecoded: 0, frameHeight: null };
    const report = await pc.getStats();
    let framesDecoded = 0;
    let frameHeight: number | null = null;
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "video") return;
      if ("framesDecoded" in stat && typeof stat.framesDecoded === "number") {
        framesDecoded += stat.framesDecoded;
      }
      if ("frameHeight" in stat && typeof stat.frameHeight === "number") {
        frameHeight = stat.frameHeight;
      }
    });
    return { framesDecoded, frameHeight };
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.pc?.close();
      this.pc = null;
      this.midToName.clear();
      this.nameToMid.clear();
      this.setState("closed");
    });
  }
}
