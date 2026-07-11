import type { PresetId } from "@tavern/shared";
import { LOW_LAYER, SCREEN_PRESETS, WEBCAM_LOW, WEBCAM_PRESET, presetKbps } from "@tavern/shared";
import type { RtcPort } from "../ports";
import type { SfuSignal } from "../sfuSignal";
import { camTrackName, micTrackName, screenAudioTrackName, screenTrackName } from "../trackName";

export type PublishState =
  | "idle"
  | "connecting"
  | "connected"
  | "renegotiating"
  | "closed"
  | "failed";

const KBPS = 1000; // App-D tables are in kbps; RTCRtpEncodingParameters.maxBitrate is bits per second.

interface PublishSpec {
  track: MediaStreamTrack;
  trackName: string;
  encodings?: RTCRtpEncodingParameters[];
}

// The height the capture track actually delivers, read ONCE at acquisition (getSettings() is
// truthful before any constraint churn; test doubles may omit it → preset fallback). Stored per
// track: every later per-rid scale derives from it, never from live getSettings() — after an
// applyConstraints the settings can transiently report the constrained size while the frames keep
// the acquisition size (S12.4 nightly probe).
function trackHeightOf(track: MediaStreamTrack, fallback: number): number {
  const height = typeof track.getSettings === "function" ? track.getSettings().height : undefined;
  return typeof height === "number" && height > 0 ? height : fallback;
}

// Two simulcast layers per video track (App-D): h = the chosen preset, l = the pinned low layer.
// BOTH carry an explicit scaleResolutionDownBy derived from the ACQUISITION height (S12.4 nightly
// finding): Chromium's display-capture rescale via applyConstraints is a silent no-op on some
// platforms (linux headless observed — frames keep the acquisition size), so resolution is owned by
// the ENCODER, never the capturer. maxBitrate is mandatory on every encoding (G2) — unbounded
// layers break selection + the cost model.
function screenEncodings(preset: PresetId, captureHeight: number): RTCRtpEncodingParameters[] {
  const spec = SCREEN_PRESETS[preset];
  return [
    {
      rid: "h",
      maxBitrate: presetKbps(preset) * KBPS,
      maxFramerate: spec.fps,
      scaleResolutionDownBy: Math.max(1, captureHeight / spec.height),
    },
    {
      rid: "l",
      maxBitrate: LOW_LAYER.maxKbps * KBPS,
      maxFramerate: LOW_LAYER.fps,
      scaleResolutionDownBy: Math.max(1, captureHeight / LOW_LAYER.heightTarget),
    },
  ];
}

function camEncodings(): RTCRtpEncodingParameters[] {
  return [
    { rid: "h", maxBitrate: WEBCAM_PRESET.maxKbps * KBPS, maxFramerate: WEBCAM_PRESET.fps },
    {
      rid: "l",
      maxBitrate: WEBCAM_LOW.maxKbps * KBPS,
      maxFramerate: WEBCAM_LOW.fps,
      scaleResolutionDownBy: WEBCAM_PRESET.height / WEBCAM_LOW.heightTarget,
    },
  ];
}

// mids are assigned by setLocalDescription; the publish flow always reads this after SLD.
function midOf(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) throw new Error("transceiver has no mid after setLocalDescription");
  return transceiver.mid;
}

// publishPC (PLAN §7.1): the client is the SDP offerer. One session per client; mic + screen + cam
// share it. Every SDP-mutating op is chained on `queue` — the SFU allows no concurrent renegotiation
// per session and the Worker proxy is stateless, so this is the single serialization point.
export class PublishSession {
  private readonly rtc: RtcPort;
  private readonly signal: SfuSignal;
  private readonly serverId: string;
  private readonly userId: string;
  private pc: RTCPeerConnection | null = null;
  private sessionIdRef: string | null = null;
  private stateValue: PublishState = "idle";
  private queue: Promise<unknown> = Promise.resolve();
  private shareCounter = 0;
  private readonly senders = new Map<string, RTCRtpSender>();
  private readonly transceivers = new Map<string, RTCRtpTransceiver>();
  private readonly presets = new Map<string, PresetId>();
  // Acquisition height per published screen track — the fixed base every setPreset scale derives
  // from (capture geometry never changes after acquisition; see screenEncodings).
  private readonly captureHeights = new Map<string, number>();
  private readonly listeners = new Set<(s: PublishState) => void>();

  constructor(deps: { rtc: RtcPort; signal: SfuSignal; serverId: string; userId: string }) {
    this.rtc = deps.rtc;
    this.signal = deps.signal;
    this.serverId = deps.serverId;
    this.userId = deps.userId;
  }

  get state(): PublishState {
    return this.stateValue;
  }

  get sessionId(): string | null {
    return this.sessionIdRef;
  }

  onStateChange(cb: (s: PublishState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private setState(s: PublishState): void {
    this.stateValue = s;
    for (const cb of this.listeners) cb(s);
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
    if (!this.pc) throw new Error("PublishSession not connected");
    return this.pc;
  }

  private requireSession(): string {
    if (this.sessionIdRef === null) throw new Error("PublishSession has no session");
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
      this.pc = pc;
      const { sessionId } = await this.signal.newSession(this.serverId);
      this.sessionIdRef = sessionId;
      this.setState("connected");
    } catch (err) {
      this.setState("failed");
      throw err;
    }
  }

  // One queued renegotiation: add sendonly transceivers → offer → SLD → POST tracks → apply answer.
  private publish(specs: PublishSpec[]): Promise<void> {
    return this.enqueue(async () => {
      const pc = this.requirePc();
      const sessionId = this.requireSession();
      this.setState("renegotiating");
      try {
        const added = specs.map((spec) => {
          const init: RTCRtpTransceiverInit = spec.encodings
            ? { direction: "sendonly", sendEncodings: spec.encodings }
            : { direction: "sendonly" };
          return { spec, transceiver: pc.addTransceiver(spec.track, init) };
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const tracks = added.map(({ spec, transceiver }) => ({
          mid: midOf(transceiver),
          trackName: spec.trackName,
        }));
        for (const { spec, transceiver } of added) {
          this.senders.set(spec.trackName, transceiver.sender);
          this.transceivers.set(spec.trackName, transceiver);
        }
        const answer = await this.signal.publishTracks(this.serverId, sessionId, offer, tracks);
        if (answer.sessionDescription) await pc.setRemoteDescription(answer.sessionDescription);
        this.setState("connected");
      } catch (err) {
        this.setState("failed");
        throw err;
      }
    });
  }

  async publishMic(track: MediaStreamTrack): Promise<{ trackName: string }> {
    const trackName = micTrackName(this.userId); // audio carries no simulcast encodings
    await this.publish([{ track, trackName }]);
    return { trackName };
  }

  async publishStream(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    preset: PresetId,
  ): Promise<{ videoTrackName: string; audioTrackName?: string }> {
    const n = ++this.shareCounter;
    const videoTrackName = screenTrackName(this.userId, n);
    const captureHeight = trackHeightOf(video, SCREEN_PRESETS[preset].height);
    const specs: PublishSpec[] = [
      {
        track: video,
        trackName: videoTrackName,
        encodings: screenEncodings(preset, captureHeight),
      },
    ];
    let audioTrackName: string | undefined;
    if (audio) {
      audioTrackName = screenAudioTrackName(this.userId, n);
      specs.push({ track: audio, trackName: audioTrackName });
    }
    await this.publish(specs);
    this.presets.set(videoTrackName, preset);
    this.captureHeights.set(videoTrackName, captureHeight);
    return audioTrackName ? { videoTrackName, audioTrackName } : { videoTrackName };
  }

  async publishCam(track: MediaStreamTrack): Promise<{ trackName: string }> {
    const trackName = camTrackName(this.userId);
    await this.publish([{ track, trackName, encodings: camEncodings() }]);
    return { trackName };
  }

  // FR-27 on-the-fly: applyConstraints (frame-rate ceiling only) + sender.setParameters — NEVER a
  // renegotiation. Resolution changes ride setParameters' scaleResolutionDownBy on the FIXED
  // acquisition geometry, not the capturer: a width/height applyConstraints on a display-capture
  // track resolves but silently keeps delivering acquisition-size frames on some platforms (S12.4
  // nightly probe: linux headless h stayed 720 for 30s while getSettings() flapped 480→720), which
  // left the h layer at the old resolution whenever the capturer ignored the resize. The encoder
  // scale is honored everywhere (the l layer re-encoded live mid-share in the same probe).
  async setPreset(trackName: string, preset: PresetId): Promise<void> {
    const sender = this.senders.get(trackName);
    if (!sender) throw new Error(`no sender for ${trackName}`);
    const spec = SCREEN_PRESETS[preset];
    if (sender.track) {
      await sender.track.applyConstraints({
        frameRate: { ideal: spec.fps, max: spec.fps },
      });
    }
    const captureHeight = this.captureHeights.get(trackName) ?? spec.height;
    const params = sender.getParameters();
    for (const enc of params.encodings) {
      if (enc.rid === "h") {
        enc.maxBitrate = presetKbps(preset) * KBPS;
        enc.maxFramerate = spec.fps;
        enc.scaleResolutionDownBy = Math.max(1, captureHeight / spec.height);
      } else if (enc.rid === "l") {
        enc.scaleResolutionDownBy = Math.max(1, captureHeight / LOW_LAYER.heightTarget);
      }
    }
    await sender.setParameters(params);
    this.presets.set(trackName, preset);
  }

  // Read-only outbound-rtp VIDEO summary for ONE published track, per simulcast rid — the §10
  // @realtime hook's publisher-side counterpart of the watch pull's inboundVideoStats. It splits an
  // FR-27 preset-drop red into fault domains: is the local encoder producing the new height (h-layer
  // frameHeight here) or is the SFU→viewer path stale (inbound stats on the watcher)? Sender-scoped
  // getStats keeps the report to this one track. Narrowed with `in`/`typeof` (no `as`, §9.1).
  async outboundVideoStats(trackName: string): Promise<
    Array<{
      rid: string | null;
      frameHeight: number | null;
      framesSent: number;
      bytesSent: number;
      framesPerSecond: number | null;
      targetBitrate: number | null;
      qualityLimitationReason: string | null;
    }>
  > {
    const sender = this.senders.get(trackName);
    if (!sender) return [];
    const report = await sender.getStats();
    const layers: Array<{
      rid: string | null;
      frameHeight: number | null;
      framesSent: number;
      bytesSent: number;
      framesPerSecond: number | null;
      targetBitrate: number | null;
      qualityLimitationReason: string | null;
    }> = [];
    report.forEach((stat) => {
      if (stat.type !== "outbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "video") return;
      layers.push({
        rid: "rid" in stat && typeof stat.rid === "string" ? stat.rid : null,
        frameHeight:
          "frameHeight" in stat && typeof stat.frameHeight === "number" ? stat.frameHeight : null,
        framesSent:
          "framesSent" in stat && typeof stat.framesSent === "number" ? stat.framesSent : 0,
        bytesSent: "bytesSent" in stat && typeof stat.bytesSent === "number" ? stat.bytesSent : 0,
        framesPerSecond:
          "framesPerSecond" in stat && typeof stat.framesPerSecond === "number"
            ? stat.framesPerSecond
            : null,
        targetBitrate:
          "targetBitrate" in stat && typeof stat.targetBitrate === "number"
            ? stat.targetBitrate
            : null,
        qualityLimitationReason:
          "qualityLimitationReason" in stat && typeof stat.qualityLimitationReason === "string"
            ? stat.qualityLimitationReason
            : null,
      });
    });
    return layers;
  }

  // Mute = track.enabled=false; silence frames keep the SFU track alive (30s GC). NEVER replaceTrack(null).
  setTrackEnabled(trackName: string, enabled: boolean): void {
    const track = this.senders.get(trackName)?.track;
    if (track) track.enabled = enabled;
  }

  // Read-only accessor for the mic's sender so the pinned FR-21/22 `capture.retoggleMic(current,
  // sender, opts)` helper can `replaceTrack` mid-call without a renegotiation. The sender is created
  // in `publishMic` (§7.1 publishPC); returns null before the mic is published.
  micSender(): RTCRtpSender | null {
    return this.senders.get(micTrackName(this.userId)) ?? null;
  }

  // Read-only accessor for the webcam's sender so the pinned FR-29 device switch (`current.stop()` →
  // getCam(newDeviceId) → `sender.replaceTrack(newTrack)`) can swap the camera mid-publish without a
  // renegotiation. Created in `publishCam`; returns null before the webcam is published.
  camSender(): RTCRtpSender | null {
    return this.senders.get(camTrackName(this.userId)) ?? null;
  }

  async unpublish(trackNames: string[]): Promise<void> {
    await this.enqueue(async () => {
      const sessionId = this.requireSession();
      const mids: string[] = [];
      for (const name of trackNames) {
        const transceiver = this.transceivers.get(name);
        if (!transceiver) continue;
        mids.push(midOf(transceiver));
        transceiver.stop();
        this.senders.delete(name);
        this.transceivers.delete(name);
        this.presets.delete(name);
        this.captureHeights.delete(name);
      }
      if (mids.length > 0) await this.signal.closeTracks(this.serverId, sessionId, mids);
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.pc?.close();
      this.pc = null;
      this.senders.clear();
      this.transceivers.clear();
      this.presets.clear();
      this.captureHeights.clear();
      this.setState("closed");
    });
  }
}
