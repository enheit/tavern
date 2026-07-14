import { platform } from "@/platform/types";
import type { ScreenRid } from "@tavern/shared";
import type { RtcPort } from "../ports";
import type { SfuSignal } from "../sfuSignal";
import { watchConnectionRecovery } from "./connectionRecovery";

export type PullState = "idle" | "connecting" | "connected" | "renegotiating" | "closed" | "failed";

export interface InboundVideoStats {
  framesDecoded: number;
  framesReceived: number;
  framesDropped: number;
  frameWidth: number | null;
  frameHeight: number | null;
  packetsReceived: number;
  packetsLost: number;
  bytesReceived: number;
  framesPerSecond: number | null;
  jitter: number | null;
  freezeCount: number;
  totalFreezesDuration: number;
  totalDecodeTime: number | null;
  codec: string | null;
  roundTripTime: number | null;
}

type TrackCb = (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void;

// A pull the SFU answered 200 but rejected per-track (tracks[].error — e.g. the publisher's session
// registered in the DO but not yet/no longer live on the SFU). Distinct from an HTTP failure so
// callers can retry exactly the failed names; tracks that DID succeed in the same call were already
// renegotiated before this throws. Swallowing these (the pre-fix behavior) left a watcher silently
// deaf to that publisher forever — the voice-audibility asymmetry root cause (D1).
export class PullTracksError extends Error {
  readonly failed: string[];
  constructor(failed: string[], detail: string) {
    super(`pull rejected for ${failed.join(", ")}: ${detail}`);
    this.name = "PullTracksError";
    this.failed = failed;
  }
}

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
  private readonly recoveryListeners = new Set<() => void>();

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

  // Fires after a terminal failure OR once connectivity returns from `disconnected`. The latter is
  // important because browsers can reconnect the PeerConnection without ever reporting `failed`,
  // while the Cloudflare subscription still points at stale publisher sessions.
  onConnectionRecoveryNeeded(cb: () => void): () => void {
    this.recoveryListeners.add(cb);
    return () => {
      this.recoveryListeners.delete(cb);
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

  private async completeImmediateRenegotiation(
    pc: RTCPeerConnection,
    response: Awaited<ReturnType<SfuSignal["pullTracks"]>>,
  ): Promise<void> {
    if (!response.requiresImmediateRenegotiation) return;
    const offer = response.sessionDescription;
    if (offer === undefined || offer.type !== "offer") {
      throw new Error("SFU required immediate renegotiation without an offer");
    }
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signal.renegotiate(this.serverId, this.requireSession(), answer);
  }

  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      const iceServers = await this.signal.getIceServers();
      const pc = this.rtc.createPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
      watchConnectionRecovery(pc, (reason) => {
        if (reason === "failed") this.setState("failed");
        for (const cb of this.recoveryListeners) cb();
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
    tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>,
  ): Promise<void> {
    await this.enqueue(async () => {
      const pc = this.requirePc();
      const sessionId = this.requireSession();
      this.setState("renegotiating");
      // §10 e2e hook: record each initial pull's simulcast rid so the streams spec can assert the
      // always-high-layer policy (mirrors the setLayer record below). Installed only under the harness.
      if (platform.isE2E && typeof window !== "undefined") {
        for (const t of tracks) {
          // oxlint-disable-next-line no-underscore-dangle -- pinned §10 e2e hook global window.__tavernTestRtc
          window.__tavernTestRtc?.pullCalls.push({
            trackName: t.trackName,
            rid: t.preferredRid ?? null,
          });
        }
      }
      try {
        const response = await this.signal.pullTracks(this.serverId, sessionId, tracks);
        // The SFU can answer 200 with PER-TRACK errors (tracks[].error — e.g. a pull racing the
        // publisher's own SFU registration). A requested track with neither a mid nor an error is
        // equally un-wireable. Collect them, but FIRST complete the renegotiation for the tracks
        // that DID succeed — an unanswered requiresImmediateRenegotiation silently kills the whole
        // session (§7.1) — and only then throw so callers retry exactly the failed names.
        const failed: string[] = [];
        let detail = "no mid in SFU response";
        for (const t of response.tracks) {
          if (t.mid) {
            this.midToName.set(t.mid, t.trackName);
            this.nameToMid.set(t.trackName, t.mid);
          } else {
            failed.push(t.trackName);
            if (t.error) detail = `${t.error.code} ${t.error.message}`;
          }
        }
        // Pulls typically require an immediate renegotiation: apply the SFU offer, answer, PUT it.
        await this.completeImmediateRenegotiation(pc, response);
        if (failed.length > 0) throw new PullTracksError(failed, detail);
        this.setState("connected");
      } catch (err) {
        this.setState("failed");
        throw err;
      }
    });
  }

  async removeRemoteTracks(trackNames: string[]): Promise<void> {
    await this.enqueue(async () => {
      const pc = this.requirePc();
      const sessionId = this.requireSession();
      const mids: string[] = [];
      for (const name of trackNames) {
        const mid = this.nameToMid.get(name);
        if (!mid) continue;
        mids.push(mid);
      }
      if (mids.length === 0) return;
      this.setState("renegotiating");
      try {
        const response = await this.signal.closeTracks(this.serverId, sessionId, mids);
        await this.completeImmediateRenegotiation(pc, response);
        for (const name of trackNames) {
          const mid = this.nameToMid.get(name);
          if (mid === undefined) continue;
          this.midToName.delete(mid);
          this.nameToMid.delete(name);
        }
        this.setState("connected");
      } catch (error) {
        // A failed close leaves the previous mapping intact so a caller can keep using or retrying
        // the still-known track. Surface the failure; never pretend the video was removed.
        this.setState("connected");
        throw error;
      }
    });
  }

  // FR-33: quality follows tile size via simulcast — tracks/update on the existing pull, no SDP op.
  // The trackName rides along so the Worker/DO can reprice this watcher's egress (op:'layer', G5).
  async setLayer(trackName: string, rid: ScreenRid): Promise<void> {
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

  // Read-only PER-TRACK inbound-rtp audio bytes, keyed by pulled trackName (inbound-rtp `mid` →
  // the session's mid→trackName map). The aggregate `inboundAudioStats` cannot distinguish WHICH
  // remote mic is flowing — the 4-client @realtime pairwise regression (every pair hears every
  // pair) needs the split. Read-only getStats, no engine capability added (§10).
  async inboundAudioBytesByTrack(): Promise<Record<string, number>> {
    const pc = this.pc;
    if (!pc) return {};
    const report = await pc.getStats();
    const out: Record<string, number> = {};
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "audio") return;
      if (!("mid" in stat) || typeof stat.mid !== "string") return;
      const trackName = this.midToName.get(stat.mid);
      if (trackName === undefined) return;
      const bytes =
        "bytesReceived" in stat && typeof stat.bytesReceived === "number" ? stat.bytesReceived : 0;
      out[trackName] = (out[trackName] ?? 0) + bytes;
    });
    return out;
  }

  // Read-only inbound-rtp VIDEO summary of this watch pull PC — the source for the pinned §10 @realtime
  // streams hook (FR-27/32/33 real-media getStats: framesDecoded increases, frameHeight tracks the
  // simulcast layer / preset). Reads existing WebRTC stats only; narrowed with `in`/`typeof` because
  // RTCStats does not declare the video members (no `as`-casts, §9.1). Not exercised under the mock
  // (no media plane) — the PR streams spec asserts signaling/state instead.
  async inboundVideoStats(): Promise<InboundVideoStats> {
    const pc = this.pc;
    if (!pc)
      return {
        framesDecoded: 0,
        framesReceived: 0,
        framesDropped: 0,
        frameWidth: null,
        frameHeight: null,
        packetsReceived: 0,
        packetsLost: 0,
        bytesReceived: 0,
        framesPerSecond: null,
        jitter: null,
        freezeCount: 0,
        totalFreezesDuration: 0,
        totalDecodeTime: null,
        codec: null,
        roundTripTime: null,
      };
    const report = await pc.getStats();
    let framesDecoded = 0;
    let framesReceived = 0;
    let framesDropped = 0;
    let frameWidth: number | null = null;
    let frameHeight: number | null = null;
    let packetsReceived = 0;
    let packetsLost = 0;
    let bytesReceived = 0;
    let framesPerSecond: number | null = null;
    let jitter: number | null = null;
    let freezeCount = 0;
    let totalFreezesDuration = 0;
    let totalDecodeTime: number | null = null;
    let codec: string | null = null;
    let codecId: string | null = null;
    let roundTripTime: number | null = null;
    const codecs = new Map<string, string>();
    report.forEach((stat) => {
      if (stat.type === "codec" && "id" in stat && typeof stat.id === "string") {
        const mimeType =
          "mimeType" in stat && typeof stat.mimeType === "string" ? stat.mimeType : null;
        if (mimeType !== null) codecs.set(stat.id, mimeType.replace(/^video\//, ""));
      }
      if (stat.type !== "candidate-pair") return;
      const selected = "selected" in stat && stat.selected === true;
      const nominated = "nominated" in stat && stat.nominated === true;
      if (!selected && !nominated) return;
      if ("currentRoundTripTime" in stat && typeof stat.currentRoundTripTime === "number") {
        roundTripTime = stat.currentRoundTripTime;
      }
    });
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "video") return;
      if ("framesDecoded" in stat && typeof stat.framesDecoded === "number") {
        framesDecoded += stat.framesDecoded;
      }
      if ("framesReceived" in stat && typeof stat.framesReceived === "number") {
        framesReceived += stat.framesReceived;
      }
      if ("framesDropped" in stat && typeof stat.framesDropped === "number") {
        framesDropped += stat.framesDropped;
      }
      if ("frameWidth" in stat && typeof stat.frameWidth === "number") {
        frameWidth = stat.frameWidth;
      }
      if ("frameHeight" in stat && typeof stat.frameHeight === "number") {
        frameHeight = stat.frameHeight;
      }
      if ("bytesReceived" in stat && typeof stat.bytesReceived === "number") {
        bytesReceived += stat.bytesReceived;
      }
      if ("packetsReceived" in stat && typeof stat.packetsReceived === "number") {
        packetsReceived += stat.packetsReceived;
      }
      if ("packetsLost" in stat && typeof stat.packetsLost === "number") {
        packetsLost += stat.packetsLost;
      }
      if ("framesPerSecond" in stat && typeof stat.framesPerSecond === "number") {
        framesPerSecond = stat.framesPerSecond;
      }
      if ("jitter" in stat && typeof stat.jitter === "number") jitter = stat.jitter;
      if ("freezeCount" in stat && typeof stat.freezeCount === "number") {
        freezeCount += stat.freezeCount;
      }
      if ("totalFreezesDuration" in stat && typeof stat.totalFreezesDuration === "number") {
        totalFreezesDuration += stat.totalFreezesDuration;
      }
      if ("totalDecodeTime" in stat && typeof stat.totalDecodeTime === "number") {
        totalDecodeTime = (totalDecodeTime ?? 0) + stat.totalDecodeTime;
      }
      if ("codecId" in stat && typeof stat.codecId === "string") codecId = stat.codecId;
    });
    if (codecId !== null) codec = codecs.get(codecId) ?? null;
    return {
      framesDecoded,
      framesReceived,
      framesDropped,
      frameWidth,
      frameHeight,
      packetsReceived,
      packetsLost,
      bytesReceived,
      framesPerSecond,
      jitter,
      freezeCount,
      totalFreezesDuration,
      totalDecodeTime,
      codec,
      roundTripTime,
    };
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
