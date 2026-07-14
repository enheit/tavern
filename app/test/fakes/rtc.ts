import { EventLog } from "./log";

// Records the constructor configs, transceivers, offers/answers and the ordered op log the RTC
// sessions drive. Handed to the engine as an RtcPort; tests read the recorded fakes directly.

export class FakeRtcSender {
  track: MediaStreamTrack | null;
  encodings: RTCRtpEncodingParameters[];
  readonly replaceTrackArgs: (MediaStreamTrack | null)[] = [];
  setParametersCount = 0;
  degradationPreference: RTCDegradationPreference | undefined;
  statsReport: Array<Record<string, unknown>> = [];

  constructor(track: MediaStreamTrack | null, encodings: RTCRtpEncodingParameters[]) {
    this.track = track;
    this.encodings = encodings;
  }

  getParameters(): {
    encodings: RTCRtpEncodingParameters[];
    degradationPreference?: RTCDegradationPreference;
  } {
    return {
      encodings: this.encodings,
      ...(this.degradationPreference === undefined
        ? {}
        : { degradationPreference: this.degradationPreference }),
    };
  }

  setParameters(params: {
    encodings: RTCRtpEncodingParameters[];
    degradationPreference?: RTCDegradationPreference;
  }): Promise<void> {
    this.encodings = params.encodings;
    this.degradationPreference = params.degradationPreference;
    this.setParametersCount += 1;
    return Promise.resolve();
  }

  replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackArgs.push(track);
    this.track = track;
    return Promise.resolve();
  }

  getStats(): Promise<{ forEach(cb: (stat: Record<string, unknown>) => void): void }> {
    const entries = this.statsReport;
    return Promise.resolve({
      forEach(cb: (stat: Record<string, unknown>) => void): void {
        for (const stat of entries) cb(stat);
      },
    });
  }
}

export class FakeRtcTransceiver {
  mid: string;
  readonly init: RTCRtpTransceiverInit;
  readonly sender: FakeRtcSender;
  codecPreferences: RTCRtpCodec[] = [];
  stopped = false;
  private readonly note: (op: string) => void;

  constructor(
    mid: string,
    track: MediaStreamTrack | null,
    init: RTCRtpTransceiverInit,
    note: (op: string) => void,
  ) {
    this.mid = mid;
    this.init = init;
    this.note = note;
    // No sendEncodings (audio) still yields ONE parameter encoding — mirrors Chromium, where an
    // audio sender's getParameters().encodings has a single entry (the mic bitrate cap rides it).
    this.sender = new FakeRtcSender(track, init.sendEncodings ?? [{}]);
  }

  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.note("setCodecPreferences");
    this.codecPreferences = codecs;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeRtcPeerConnection {
  readonly config: RTCConfiguration;
  connectionState: RTCPeerConnectionState = "new";
  readonly ops: string[] = [];
  readonly transceivers: FakeRtcTransceiver[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  private midCounter = 0;
  private readonly log: EventLog;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(config: RTCConfiguration, log: EventLog) {
    this.config = config;
    this.log = log;
  }

  private note(op: string): void {
    this.ops.push(op);
    this.log.record(op);
  }

  addTransceiver(track: MediaStreamTrack | null, init: RTCRtpTransceiverInit): FakeRtcTransceiver {
    this.note("addTransceiver");
    const transceiver = new FakeRtcTransceiver(String(this.midCounter++), track, init, (op) =>
      this.note(op),
    );
    this.transceivers.push(transceiver);
    return transceiver;
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    this.note("createOffer");
    return Promise.resolve({ type: "offer", sdp: "fake-offer" });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.note("createAnswer");
    return Promise.resolve({ type: "answer", sdp: "fake-answer" });
  }

  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.note("setLocalDescription");
    this.localDescription = desc;
    return Promise.resolve();
  }

  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.note("setRemoteDescription");
    this.remoteDescription = desc;
    return Promise.resolve();
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  // Minimal RTCStatsReport stand-in: tests push plain stat records; the sessions only use forEach.
  statsReport: Array<Record<string, unknown>> = [];
  getStats(): Promise<{ forEach(cb: (stat: Record<string, unknown>) => void): void }> {
    const entries = this.statsReport;
    return Promise.resolve({
      forEach(cb: (stat: Record<string, unknown>) => void): void {
        for (const stat of entries) cb(stat);
      },
    });
  }

  close(): void {
    this.note("close");
    this.closed = true;
  }

  // test helpers ---------------------------------------------------------------------------------
  emitTrack(mid: string, track: MediaStreamTrack, stream: MediaStream): void {
    const set = this.listeners.get("track");
    if (set) for (const cb of set) cb({ transceiver: { mid }, track, streams: [stream] });
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    const set = this.listeners.get("connectionstatechange");
    if (set) for (const cb of set) cb(undefined);
  }
}

export class FakeRtcPort {
  readonly pcs: FakeRtcPeerConnection[] = [];
  readonly log: EventLog;
  videoCapabilities: RTCRtpCapabilities | null = {
    codecs: [
      { mimeType: "video/VP8", clockRate: 90_000 },
      {
        mimeType: "video/H264",
        clockRate: 90_000,
        sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      },
      {
        mimeType: "video/H264",
        clockRate: 90_000,
        sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
      },
      { mimeType: "video/AV1", clockRate: 90_000 },
      { mimeType: "video/VP9", clockRate: 90_000 },
      { mimeType: "video/rtx", clockRate: 90_000 },
      { mimeType: "video/red", clockRate: 90_000 },
      { mimeType: "video/ulpfec", clockRate: 90_000 },
    ],
    headerExtensions: [],
  };

  constructor(log?: EventLog) {
    this.log = log ?? new EventLog();
  }

  createPeerConnection(config: RTCConfiguration): RTCPeerConnection {
    const pc = new FakeRtcPeerConnection(config, this.log);
    this.pcs.push(pc);
    return pc as unknown as RTCPeerConnection;
  }

  senderCapabilities(kind: "audio" | "video"): RTCRtpCapabilities | null {
    if (kind === "video") return this.videoCapabilities;
    return {
      codecs: [{ mimeType: "audio/opus", clockRate: 48_000, channels: 2 }],
      headerExtensions: [],
    };
  }

  last(): FakeRtcPeerConnection {
    const pc = this.pcs.at(-1);
    if (!pc) throw new Error("no peer connection created");
    return pc;
  }
}
