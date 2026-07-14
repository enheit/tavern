import type { PresetId } from "@tavern/shared";
import { platform } from "@/platform/types";
import { watchConnectionRecovery } from "./connectionRecovery";
import {
  SCREEN_PRESETS,
  WEBCAM_INTERMEDIATE,
  WEBCAM_LOW,
  WEBCAM_PRESET,
  contentHintForPreset,
  degradationPreferenceForPreset,
} from "@tavern/shared";
import type { RtcPort } from "../ports";
import type { SfuSignal } from "../sfuSignal";
import { camTrackName, micTrackName, screenAudioTrackName, screenTrackName } from "../trackName";
import { screenCodecPreferences } from "./codecs";
import type { ScreenCodec } from "./codecs";

export type PublishState =
  | "idle"
  | "connecting"
  | "connected"
  | "renegotiating"
  | "closed"
  | "failed";

export interface OutboundVideoLayerStats {
  rid: string | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesEncoded: number;
  framesSent: number;
  packetsSent: number;
  bytesSent: number;
  framesPerSecond: number | null;
  sourceFramesPerSecond: number | null;
  targetBitrate: number | null;
  qualityLimitationReason: string | null;
  totalEncodeTime: number | null;
  codec: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  scalabilityMode: string | null;
  roundTripTime: number | null;
}

const KBPS = 1000; // App-D tables are in kbps; RTCRtpEncodingParameters.maxBitrate is bits per second.

// Task-2 voice quality: target Opus rate for the published mic. Chromium's default voice encode
// (~32 kbps mono) is the audible fidelity gap to Discord's 64 kbps default. Applied twice — fmtp
// maxaveragebitrate in the APPLIED answer raises the encoder's target, sender maxBitrate caps it —
// because either lever alone is engine-dependent.
export const VOICE_OPUS_BITRATE_BPS = 64_000;
const MEDIA_READY_TIMEOUT_MS = 15_000;

function waitForPeerConnectionConnected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  if (pc.connectionState === "failed" || pc.connectionState === "closed") {
    return Promise.reject(new Error(`publish peer connection is ${pc.connectionState}`));
  }
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timeout);
      pc.removeEventListener("connectionstatechange", onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const onStateChange = () => {
      if (pc.connectionState === "connected") done();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        done(new Error(`publish peer connection is ${pc.connectionState}`));
      }
    };
    const timeout = setTimeout(
      () => done(new Error("publish peer connection did not reach connected in time")),
      MEDIA_READY_TIMEOUT_MS,
    );
    pc.addEventListener("connectionstatechange", onStateChange);
  });
}

interface PublishSpec {
  track: MediaStreamTrack;
  trackName: string;
  encodings?: RTCRtpEncodingParameters[];
  // When set, the SFU's answer is rewritten before setRemoteDescription so this m-line's Opus fmtp
  // carries maxaveragebitrate=<bps> (the mic path — content/screen audio keeps browser defaults).
  opusMaxAverageBitrate?: number;
  preset?: PresetId;
  codec?: ScreenCodec;
}

// Rewrites ONE audio m-line's Opus fmtp in an SDP: the section owning `a=mid:<mid>` gets
// maxaveragebitrate=<bps> (patched into an existing fmtp line, else inserted after the rtpmap).
// Unknown mid / no audio section / no opus codec → the SDP is returned untouched (unit-test fakes
// use non-SDP strings; never throw over a bitrate hint). Exported for its unit tests.
export function withOpusMaxAverageBitrate(sdp: string, mid: string, bps: number): string {
  const lines = sdp.split("\r\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (!(lines[i] ?? "").startsWith("m=audio")) continue;
    let j = i + 1;
    let hasMid = false;
    while (j < lines.length && !(lines[j] ?? "").startsWith("m=")) {
      if (lines[j] === `a=mid:${mid}`) hasMid = true;
      j += 1;
    }
    if (hasMid) {
      start = i;
      end = j;
      break;
    }
    i = j - 1;
  }
  if (start === -1) return sdp;
  let pt: string | null = null;
  let rtpmapAt = -1;
  for (let i = start; i < end; i += 1) {
    const match = (lines[i] ?? "").match(/^a=rtpmap:(\d+) opus\//i);
    if (match?.[1] !== undefined) {
      pt = match[1];
      rtpmapAt = i;
      break;
    }
  }
  if (pt === null) return sdp;
  for (let i = start; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (!line.startsWith(`a=fmtp:${pt} `)) continue;
    lines[i] = /maxaveragebitrate=\d+/.test(line)
      ? line.replace(/maxaveragebitrate=\d+/, `maxaveragebitrate=${bps}`)
      : `${line};maxaveragebitrate=${bps}`;
    return lines.join("\r\n");
  }
  lines.splice(rtpmapAt + 1, 0, `a=fmtp:${pt} maxaveragebitrate=${bps}`);
  return lines.join("\r\n");
}

// The height the capture track actually delivers, read ONCE at acquisition (getSettings() is
// truthful before any constraint churn; test doubles may omit it → preset fallback). Stored per
// track: every later encoder scale derives from it, never from live getSettings() — after an
// applyConstraints the settings can transiently report the constrained size while the frames keep
// the acquisition size (S12.4 nightly probe).
function trackHeightOf(track: MediaStreamTrack, fallback: number): number {
  const height = typeof track.getSettings === "function" ? track.getSettings().height : undefined;
  return typeof height === "number" && height > 0 ? height : fallback;
}

// Screen share intentionally has one encoding: the exact preset selected by the user. Publishing
// h/i/l simultaneously made the browser encode three copies and allowed the SFU to replace a 2K/60
// selection with a much smaller layer. The encoder scale derives from the acquired track and is
// clamped to 1 so a browser never upscales a source that is smaller than the selected preset.
function screenEncodings(preset: PresetId, captureHeight: number): RTCRtpEncodingParameters[] {
  const selected = SCREEN_PRESETS[preset];
  return [
    {
      maxBitrate: selected.maxKbps * KBPS,
      maxFramerate: selected.fps,
      scaleResolutionDownBy: Math.max(1, captureHeight / selected.height),
    },
  ];
}

function camEncodings(): RTCRtpEncodingParameters[] {
  return [
    { rid: "h", maxBitrate: WEBCAM_PRESET.maxKbps * KBPS, maxFramerate: WEBCAM_PRESET.fps },
    {
      rid: "i",
      maxBitrate: WEBCAM_INTERMEDIATE.maxKbps * KBPS,
      maxFramerate: WEBCAM_INTERMEDIATE.fps,
      scaleResolutionDownBy: WEBCAM_PRESET.height / WEBCAM_INTERMEDIATE.heightTarget,
    },
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
  private readonly recoveryListeners = new Set<() => void>();

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

  // Rebuild after a terminal failure OR after connectivity returns from `disconnected`. Browsers can
  // skip `failed` entirely; keeping that recovered-but-stale SFU session made the user's mic silent.
  onConnectionRecoveryNeeded(cb: () => void): () => void {
    this.recoveryListeners.add(cb);
    return () => {
      this.recoveryListeners.delete(cb);
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
      watchConnectionRecovery(pc, (reason) => {
        if (reason === "failed") this.setState("failed");
        for (const cb of this.recoveryListeners) cb();
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
  private publish(specs: PublishSpec[]): Promise<string | undefined> {
    return this.enqueue(async () => {
      const pc = this.requirePc();
      const sessionId = this.requireSession();
      this.setState("renegotiating");
      try {
        // Resolve every explicit preference before mutating the PeerConnection. A missing selected
        // codec is a hard error: Tavern never falls back to another encoder behind the user's back.
        const prepared = specs.map((spec) => ({
          spec,
          codecPreferences:
            spec.codec === undefined
              ? null
              : screenCodecPreferences(this.rtc.senderCapabilities("video"), spec.codec),
        }));
        const added = prepared.map(({ spec, codecPreferences }) => {
          const init: RTCRtpTransceiverInit = spec.encodings
            ? { direction: "sendonly", sendEncodings: spec.encodings }
            : { direction: "sendonly" };
          const transceiver = pc.addTransceiver(spec.track, init);
          // This standards-based preference is applied before createOffer. It changes codec order
          // without rewriting SDP and leaves resolution/FPS/bitrate policy entirely untouched.
          if (codecPreferences !== null) transceiver.setCodecPreferences(codecPreferences);
          return { spec, transceiver };
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const tracks = added.map(({ spec, transceiver }) => ({
          mid: midOf(transceiver),
          trackName: spec.trackName,
          ...(spec.preset === undefined ? {} : { preset: spec.preset }),
        }));
        for (const { spec, transceiver } of added) {
          this.senders.set(spec.trackName, transceiver.sender);
          this.transceivers.set(spec.trackName, transceiver);
        }
        const answer = await this.signal.publishTracks(this.serverId, sessionId, offer, tracks);
        const expected = new Set(tracks.map((track) => track.trackName));
        if (
          answer.tracks.length !== expected.size ||
          answer.tracks.some((track) => !expected.has(track.trackName) || track.error !== undefined)
        ) {
          throw new Error("SFU did not accept every requested local track");
        }
        if (answer.sessionDescription) {
          let desc = answer.sessionDescription;
          for (const { spec, transceiver } of added) {
            if (spec.opusMaxAverageBitrate !== undefined) {
              desc = {
                ...desc,
                sdp: withOpusMaxAverageBitrate(
                  desc.sdp,
                  midOf(transceiver),
                  spec.opusMaxAverageBitrate,
                ),
              };
            }
          }
          await pc.setRemoteDescription(desc);
        }
        const configureScreenSenders = async (): Promise<void> => {
          // `sendEncodings` owns initial geometry/cadence/bitrate. degradationPreference belongs to
          // RTCRtpSendParameters and must be applied to the live sender before publication readiness.
          await Promise.all(
            added.flatMap(({ spec, transceiver }) => {
              if (spec.preset === undefined) return [];
              const params = transceiver.sender.getParameters();
              params.degradationPreference = degradationPreferenceForPreset(spec.preset);
              return [transceiver.sender.setParameters(params)];
            }),
          );
        };
        if (answer.publicationId !== undefined) {
          try {
            await configureScreenSenders();
            // The hermetic E2E SFU intentionally has no media plane or ICE candidates; its
            // structurally-valid SDP handshake is the readiness proof. Production must still prove
            // a connected PeerConnection before making the reserved publication pullable.
            if (!platform.isE2E) await waitForPeerConnectionConnected(pc);
            await this.signal.confirmPublishedTracks(
              this.serverId,
              sessionId,
              answer.publicationId,
            );
          } catch (err) {
            try {
              await this.signal.abortPublishedTracks(
                this.serverId,
                sessionId,
                answer.publicationId,
              );
            } catch (abortError) {
              console.error("failed to abort unready media publication", abortError);
            }
            throw err;
          }
        } else {
          await configureScreenSenders();
        }
        this.setState("connected");
        return answer.publicationId;
      } catch (err) {
        this.setState("failed");
        throw err;
      }
    });
  }

  async publishMic(track: MediaStreamTrack): Promise<{ trackName: string }> {
    const trackName = micTrackName(this.userId); // audio carries no simulcast encodings
    await this.publish([{ track, trackName, opusMaxAverageBitrate: VOICE_OPUS_BITRATE_BPS }]);
    // Cap the sender to the same figure (the fmtp raised the target; this keeps BWE from ever
    // allocating past it). Audio senders expose one encoding; a test double may expose none.
    const sender = this.senders.get(trackName);
    if (sender) {
      const params = sender.getParameters();
      if (params.encodings.length > 0) {
        for (const enc of params.encodings) enc.maxBitrate = VOICE_OPUS_BITRATE_BPS;
        await sender.setParameters(params);
      }
    }
    return { trackName };
  }

  async publishStream(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    preset: PresetId,
    codec: ScreenCodec,
  ): Promise<{ videoTrackName: string; audioTrackName?: string; previewId?: string }> {
    const n = ++this.shareCounter;
    const videoTrackName = screenTrackName(this.userId, n);
    const captureHeight = trackHeightOf(video, SCREEN_PRESETS[preset].height);
    video.contentHint = contentHintForPreset(preset);
    const specs: PublishSpec[] = [
      {
        track: video,
        trackName: videoTrackName,
        encodings: screenEncodings(preset, captureHeight),
        preset,
        codec,
      },
    ];
    let audioTrackName: string | undefined;
    if (audio) {
      audioTrackName = screenAudioTrackName(this.userId, n);
      specs.push({ track: audio, trackName: audioTrackName });
    }
    const previewId = await this.publish(specs);
    this.presets.set(videoTrackName, preset);
    this.captureHeights.set(videoTrackName, captureHeight);
    return {
      videoTrackName,
      ...(audioTrackName === undefined ? {} : { audioTrackName }),
      ...(previewId === undefined ? {} : { previewId }),
    };
  }

  async publishCam(track: MediaStreamTrack): Promise<{ trackName: string; previewId?: string }> {
    const trackName = camTrackName(this.userId);
    const previewId = await this.publish([{ track, trackName, encodings: camEncodings() }]);
    return { trackName, ...(previewId === undefined ? {} : { previewId }) };
  }

  private async applyScreenParameters(
    sender: RTCRtpSender,
    preset: PresetId,
    captureHeight: number,
  ): Promise<void> {
    const selected = SCREEN_PRESETS[preset];
    const params = sender.getParameters();
    if (params.encodings.length !== 1) {
      throw new Error(
        `screen sender must expose exactly one encoding, got ${params.encodings.length}`,
      );
    }
    params.degradationPreference = degradationPreferenceForPreset(preset);
    const encoding = params.encodings[0];
    if (encoding === undefined) throw new Error("screen sender encoding disappeared");
    encoding.maxBitrate = selected.maxKbps * KBPS;
    encoding.maxFramerate = selected.fps;
    encoding.scaleResolutionDownBy = Math.max(1, captureHeight / selected.height);
    await sender.setParameters(params);
  }

  // Live switches inside the capture ceiling change encoder policy only. Display-capture constraint
  // churn is intentionally absent: browsers may resolve it while continuing to emit the old cadence.
  async setPreset(trackName: string, preset: PresetId): Promise<void> {
    const sender = this.senders.get(trackName);
    if (!sender) throw new Error(`no sender for ${trackName}`);
    const spec = SCREEN_PRESETS[preset];
    if (sender.track) sender.track.contentHint = contentHintForPreset(preset);
    const captureHeight = this.captureHeights.get(trackName) ?? spec.height;
    await this.applyScreenParameters(sender, preset, captureHeight);
    this.presets.set(trackName, preset);
  }

  // Replaces only the screen video track, preserving the SFU session, transceiver, track name, audio
  // companion, and every viewer subscription. If encoder configuration fails, the old live track is
  // restored before the error escapes; the caller owns stopping either track after the outcome.
  async replaceScreenTrack(
    trackName: string,
    nextTrack: MediaStreamTrack,
    preset: PresetId,
  ): Promise<void> {
    await this.enqueue(async () => {
      const sender = this.senders.get(trackName);
      if (!sender) throw new Error(`no sender for ${trackName}`);
      const previousTrack = sender.track;
      const previousPreset = this.presets.get(trackName);
      const previousHeight = this.captureHeights.get(trackName);
      const nextHeight = trackHeightOf(nextTrack, SCREEN_PRESETS[preset].height);
      nextTrack.contentHint = contentHintForPreset(preset);
      await sender.replaceTrack(nextTrack);
      try {
        await this.applyScreenParameters(sender, preset, nextHeight);
      } catch (err) {
        await sender.replaceTrack(previousTrack);
        if (previousTrack && previousPreset !== undefined) {
          previousTrack.contentHint = contentHintForPreset(previousPreset);
          await this.applyScreenParameters(
            sender,
            previousPreset,
            previousHeight ?? SCREEN_PRESETS[previousPreset].height,
          );
        }
        throw err;
      }
      this.presets.set(trackName, preset);
      this.captureHeights.set(trackName, nextHeight);
    });
  }

  // Read-only outbound-rtp VIDEO summary for ONE published track — the §10
  // @realtime hook's publisher-side counterpart of the watch pull's inboundVideoStats. It splits an
  // FR-27 preset-drop red into fault domains: is the local encoder producing the new height (h-layer
  // frameHeight here) or is the SFU→viewer path stale (inbound stats on the watcher)? Sender-scoped
  // getStats keeps the report to this one track. Narrowed with `in`/`typeof` (no `as`, §9.1).
  async outboundVideoStats(trackName: string): Promise<OutboundVideoLayerStats[]> {
    const sender = this.senders.get(trackName);
    if (!sender) return [];
    const report = await sender.getStats();
    const layers: OutboundVideoLayerStats[] = [];
    const codecs = new Map<string, string>();
    let roundTripTime: number | null = null;
    let sourceFramesPerSecond: number | null = null;
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
      if (stat.type !== "media-source") return;
      if ("kind" in stat && stat.kind !== "video") return;
      if ("framesPerSecond" in stat && typeof stat.framesPerSecond === "number") {
        sourceFramesPerSecond = stat.framesPerSecond;
      }
    });
    report.forEach((stat) => {
      if (stat.type !== "outbound-rtp") return;
      if (!("kind" in stat) || stat.kind !== "video") return;
      layers.push({
        rid: "rid" in stat && typeof stat.rid === "string" ? stat.rid : null,
        frameWidth:
          "frameWidth" in stat && typeof stat.frameWidth === "number" ? stat.frameWidth : null,
        frameHeight:
          "frameHeight" in stat && typeof stat.frameHeight === "number" ? stat.frameHeight : null,
        framesEncoded:
          "framesEncoded" in stat && typeof stat.framesEncoded === "number"
            ? stat.framesEncoded
            : 0,
        framesSent:
          "framesSent" in stat && typeof stat.framesSent === "number" ? stat.framesSent : 0,
        packetsSent:
          "packetsSent" in stat && typeof stat.packetsSent === "number" ? stat.packetsSent : 0,
        bytesSent: "bytesSent" in stat && typeof stat.bytesSent === "number" ? stat.bytesSent : 0,
        framesPerSecond:
          "framesPerSecond" in stat && typeof stat.framesPerSecond === "number"
            ? stat.framesPerSecond
            : null,
        sourceFramesPerSecond,
        targetBitrate:
          "targetBitrate" in stat && typeof stat.targetBitrate === "number"
            ? stat.targetBitrate
            : null,
        qualityLimitationReason:
          "qualityLimitationReason" in stat && typeof stat.qualityLimitationReason === "string"
            ? stat.qualityLimitationReason
            : null,
        totalEncodeTime:
          "totalEncodeTime" in stat && typeof stat.totalEncodeTime === "number"
            ? stat.totalEncodeTime
            : null,
        codec:
          "codecId" in stat && typeof stat.codecId === "string"
            ? (codecs.get(stat.codecId) ?? null)
            : null,
        // These standard fields are deliberately diagnostic rather than a codec-selection oracle:
        // browsers may omit them for privacy, and codec availability alone does not prove hardware.
        encoderImplementation:
          "encoderImplementation" in stat && typeof stat.encoderImplementation === "string"
            ? stat.encoderImplementation
            : null,
        powerEfficientEncoder:
          "powerEfficientEncoder" in stat && typeof stat.powerEfficientEncoder === "boolean"
            ? stat.powerEfficientEncoder
            : null,
        scalabilityMode:
          "scalabilityMode" in stat && typeof stat.scalabilityMode === "string"
            ? stat.scalabilityMode
            : null,
        roundTripTime,
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
