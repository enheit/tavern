import type { PresetId } from "@tavern/shared";
import {
  LOW_LAYER,
  SCREEN_PRESETS,
  WEBCAM_LOW,
  WEBCAM_PRESET,
  lowLayerScaleDown,
  presetKbps,
} from "@tavern/shared";
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

// Two simulcast layers per video track (App-D): h = the chosen preset, l = the pinned low layer.
// maxBitrate is mandatory on every encoding (G2) — unbounded layers break selection + the cost model.
function screenEncodings(preset: PresetId): RTCRtpEncodingParameters[] {
  return [
    { rid: "h", maxBitrate: presetKbps(preset) * KBPS, maxFramerate: SCREEN_PRESETS[preset].fps },
    {
      rid: "l",
      maxBitrate: LOW_LAYER.maxKbps * KBPS,
      maxFramerate: LOW_LAYER.fps,
      scaleResolutionDownBy: lowLayerScaleDown(preset),
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
    const specs: PublishSpec[] = [
      { track: video, trackName: videoTrackName, encodings: screenEncodings(preset) },
    ];
    let audioTrackName: string | undefined;
    if (audio) {
      audioTrackName = screenAudioTrackName(this.userId, n);
      specs.push({ track: audio, trackName: audioTrackName });
    }
    await this.publish(specs);
    this.presets.set(videoTrackName, preset);
    return audioTrackName ? { videoTrackName, audioTrackName } : { videoTrackName };
  }

  async publishCam(track: MediaStreamTrack): Promise<{ trackName: string }> {
    const trackName = camTrackName(this.userId);
    await this.publish([{ track, trackName, encodings: camEncodings() }]);
    return { trackName };
  }

  // FR-27 on-the-fly: applyConstraints (ideal/max) + sender.setParameters — NEVER a renegotiation.
  async setPreset(trackName: string, preset: PresetId): Promise<void> {
    const sender = this.senders.get(trackName);
    if (!sender) throw new Error(`no sender for ${trackName}`);
    const spec = SCREEN_PRESETS[preset];
    if (sender.track) {
      await sender.track.applyConstraints({
        width: { ideal: spec.width, max: spec.width },
        height: { ideal: spec.height, max: spec.height },
        frameRate: { ideal: spec.fps, max: spec.fps },
      });
    }
    const params = sender.getParameters();
    for (const enc of params.encodings) {
      if (enc.rid === "h") {
        enc.maxBitrate = presetKbps(preset) * KBPS;
        enc.maxFramerate = spec.fps;
      } else if (enc.rid === "l") {
        enc.scaleResolutionDownBy = lowLayerScaleDown(preset);
      }
    }
    await sender.setParameters(params);
    this.presets.set(trackName, preset);
  }

  // Mute = track.enabled=false; silence frames keep the SFU track alive (30s GC). NEVER replaceTrack(null).
  setTrackEnabled(trackName: string, enabled: boolean): void {
    const track = this.senders.get(trackName)?.track;
    if (track) track.enabled = enabled;
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
      this.setState("closed");
    });
  }
}
