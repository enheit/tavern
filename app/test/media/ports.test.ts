import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioGraph } from "@/media/audioGraph";
import { browserAudioPort, browserRtcPort } from "@/media/ports";
import { VoiceRecorder } from "@/media/recorder";
import { SoundboardPlayer } from "@/media/soundboardPlayer";
import {
  camTrackName,
  micTrackName,
  screenAudioTrackName,
  screenTrackName,
} from "@/media/trackName";
import { fakeTrack } from "../fakes/media";
import { FakeAudioPort } from "../fakes/audio";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackName grammar (§7.1)", () => {
  it("builds each track name", () => {
    expect(micTrackName("u1")).toBe("mic:u1");
    expect(camTrackName("u1")).toBe("cam:u1");
    expect(screenTrackName("u1", 2)).toBe("screen:u1:2");
    expect(screenAudioTrackName("u1", 2)).toBe("screenAudio:u1:2");
  });
});

describe("browser ports (§7.2 constructor site)", () => {
  it("browserRtcPort constructs an RTCPeerConnection with the given config", () => {
    const ctor = vi.fn();
    vi.stubGlobal("RTCPeerConnection", ctor);
    browserRtcPort.createPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    expect(ctor).toHaveBeenCalledWith({ iceServers: [], bundlePolicy: "max-bundle" });
  });

  it("browserAudioPort constructs a 48 kHz AudioContext and a muted-flow audio element", () => {
    const ctxCtor = vi.fn();
    const audioCtor = vi.fn();
    vi.stubGlobal("AudioContext", ctxCtor);
    vi.stubGlobal("Audio", audioCtor);
    browserAudioPort.createContext({ sampleRate: 48000 });
    browserAudioPort.createAudioElement();
    expect(ctxCtor).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(audioCtor).toHaveBeenCalled();
  });
});

describe("S9 interface stubs", () => {
  // S9.3 filled VoiceRecorder (behaviour covered in test/media/recorder.test.ts); the S7.2 stub-guard
  // becomes the §9.3 STOP-condition guard: opus/webm must be supported before recording starts.
  it("VoiceRecorder is inactive before start and guards MediaRecorder support (S9.3)", () => {
    const rec = new VoiceRecorder({ graph: new AudioGraph(new FakeAudioPort()) });
    expect(rec.active).toBe(false);
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(() => rec.start(fakeTrack("audio"), { onPart: async () => undefined })).toThrow(
      "does not support",
    );
    expect(rec.active).toBe(false);
  });

  it("SoundboardPlayer is implemented in S9.2 (play runs the fetch→decode path via the graph)", async () => {
    const player = new SoundboardPlayer({
      graph: new AudioGraph(new FakeAudioPort()),
      fetchSound: async () => new ArrayBuffer(8),
    });
    // stopAll is safe with no live sources.
    expect(() => player.stopAll()).not.toThrow();
    // play now reaches the graph (full behavior covered in soundboardPlayer.test.ts); against an
    // un-init graph the decode step rejects — proving it no longer throws the old "S9 not implemented".
    await expect(player.play({ id: "s1", trimStartMs: 0, trimEndMs: 1000 })).rejects.toThrow(
      "not initialized",
    );
  });
});
