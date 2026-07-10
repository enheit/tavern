import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioGraph } from "@/media/audioGraph";
import { fakeStream, fakeTrack } from "../fakes/media";
import { FakeAudioPort } from "../fakes/audio";

// jsdom has no MediaStream; the engine builds one from a track for the local-mic + recording taps.
class FakeMediaStream {
  readonly tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }
}

let port: FakeAudioPort;
let graph: AudioGraph;

// init() creates master (gains[0]), deafen (gains[1]), sb (gains[2]) in that fixed order.
const MASTER = 0;
const DEAFEN = 1;
const SB = 2;
const FIRST_USER = 3;

beforeEach(async () => {
  vi.stubGlobal("MediaStream", FakeMediaStream);
  port = new FakeAudioPort();
  graph = new AudioGraph(port);
  await graph.init();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FR-20 gain routing", () => {
  it("wires deafenGain → masterGain → destination and soundboard → deafenGain", () => {
    const ctx = port.last();
    expect(ctx.gains[DEAFEN]?.outputs).toContain(ctx.gains[MASTER]);
    expect(ctx.gains[MASTER]?.outputs).toContain(ctx.destination);
    expect(ctx.gains[SB]?.outputs).toContain(ctx.gains[DEAFEN]);
  });

  it("setUserGain(1.5) → per-user gain node 1.5, routed through deafenGain", () => {
    const stream = fakeStream();
    graph.attachRemoteMic("u1", stream);
    graph.setUserGain("u1", 1.5);
    const ctx = port.last();
    const userGain = ctx.gains[FIRST_USER];
    expect(userGain?.gain.value).toBe(1.5);
    expect(userGain?.outputs).toContain(ctx.gains[DEAFEN]);
    // the source feeds the gain AND an analyser tap (never straight to output)
    const source = ctx.sources[0];
    expect(source?.outputs).toContain(userGain);
    expect(source?.outputs).toContain(ctx.analysers[0]);
  });

  it("a remote stream is also attached to a muted, playing audio element (crbug 40094084)", () => {
    const stream = fakeStream();
    graph.attachRemoteMic("u1", stream);
    const el = port.elements[0];
    expect(el?.muted).toBe(true);
    expect(el?.srcObject).toBe(stream);
    expect(el?.played).toBe(true);
  });

  it("remembers a gain set before the user is attached", () => {
    graph.setUserGain("u9", 0.25);
    graph.attachRemoteMic("u9", fakeStream());
    expect(port.last().gains[FIRST_USER]?.gain.value).toBe(0.25);
  });

  it("stream audio gets its own gain node and detaches cleanly", () => {
    graph.attachStreamAudio("screen:u1:1", fakeStream());
    graph.setStreamGain("screen:u1:1", 0.5);
    const ctx = port.last();
    const streamGain = ctx.gains[FIRST_USER];
    expect(streamGain?.gain.value).toBe(0.5);
    expect(streamGain?.outputs).toContain(ctx.gains[DEAFEN]);

    graph.detachStreamAudio("screen:u1:1");
    expect(streamGain?.disconnected).toBe(true);
    expect(port.elements[0]?.paused).toBe(true);
  });
});

describe("FR-26 deafen", () => {
  it("deafen zeroes deafenGain, leaves user/stream gains untouched, recording unaffected", () => {
    graph.attachRemoteMic("u1", fakeStream());
    graph.setUserGain("u1", 1.5);
    const ctx = port.last();

    graph.setDeafened(true);
    expect(ctx.gains[DEAFEN]?.gain.value).toBe(0);
    expect(ctx.gains[FIRST_USER]?.gain.value).toBe(1.5); // per-user gain untouched

    // mixForRecording taps the PRE-deafen user gain + own mic + the soundboard tap
    const recStream = graph.mixForRecording(fakeTrack("audio"));
    const dest = ctx.destinations[0];
    expect(recStream).toBe(dest?.stream);
    expect(ctx.gains[FIRST_USER]?.outputs).toContain(dest);
    expect(ctx.gains[SB]?.outputs).toContain(dest);
    const micSource = ctx.sources.at(-1);
    expect(micSource?.outputs).toContain(dest);

    graph.setDeafened(false);
    expect(ctx.gains[DEAFEN]?.gain.value).toBe(1);
  });

  it("soundboard gain is independent of deafen and per-user gains", () => {
    graph.attachRemoteMic("u1", fakeStream());
    graph.setUserGain("u1", 1.5);
    graph.setSoundboardGain(1.2);
    const ctx = port.last();
    expect(ctx.gains[SB]?.gain.value).toBe(1.2);
    expect(ctx.gains[DEAFEN]?.gain.value).toBe(1);
    expect(ctx.gains[FIRST_USER]?.gain.value).toBe(1.5);
  });
});

describe("FR-21 sink", () => {
  it("init(sinkId) and setSink call ctx.setSinkId", async () => {
    const withSink = new AudioGraph(port);
    await withSink.init("speaker-1");
    expect(port.last().sinkId).toBe("speaker-1");

    await graph.setSink("speaker-2");
    expect(port.contexts[0]?.sinkId).toBe("speaker-2");
  });
});

describe("FR-23 local analyser", () => {
  it("attaches a local-mic analyser that is never routed to output", () => {
    graph.attachLocalMic(fakeTrack("audio"));
    const ctx = port.last();
    const analyser = ctx.analysers[0];
    expect(graph.getLocalAnalyser()).toBe(analyser);
    // the source feeds ONLY the analyser (no gain, no deafen, no destination)
    expect(ctx.sources[0]?.outputs).toEqual([analyser]);
    expect(graph.getUserAnalyser("nobody")).toBeNull();
  });

  it("exposes a per-user analyser after attach", () => {
    graph.attachRemoteMic("u1", fakeStream());
    expect(graph.getUserAnalyser("u1")).toBe(port.last().analysers[0]);
    graph.detachRemoteMic("u1");
    expect(graph.getUserAnalyser("u1")).toBeNull();
  });
});

describe("AudioGraph lifecycle", () => {
  it("resume() resumes the context", async () => {
    await graph.resume();
    expect(port.last().resumed).toBe(true);
  });

  it("playSoundboard slices [trimStart,trimEnd] through the soundboard gain and resolves on end", async () => {
    const buffer = {} as unknown as AudioBuffer;
    await graph.playSoundboard(buffer, 500, 2500);
    const ctx = port.last();
    const src = ctx.bufferSources[0];
    expect(src?.buffer).toBe(buffer);
    expect(src?.outputs).toContain(ctx.gains[SB]);
    expect(src?.startArgs[0]).toEqual([0, 0.5, 2]); // offset 0.5s, duration 2s
  });

  it("decode() decodes fetched bytes through the single app context", async () => {
    const bytes = new ArrayBuffer(8);
    const buffer = await graph.decode(bytes);
    expect(port.last().decoded).toContain(bytes);
    expect(buffer.sampleRate).toBe(48000);
  });

  it("stopSoundboard() cuts every live soundboard source", async () => {
    const buffer = {} as unknown as AudioBuffer;
    // Do NOT await — the source is live (its `ended` is scheduled on a microtask).
    const playing = graph.playSoundboard(buffer, 0, 1000);
    const src = port.last().bufferSources[0];
    graph.stopSoundboard();
    expect(src?.stopped).toBe(1);
    await playing; // stop() dispatched `ended`, resolving the play
    // A second call with no live sources is a harmless no-op (covers the empty path).
    graph.stopSoundboard();
  });

  it("releaseRecordingMix (FR-25) detaches the tap but leaves the live path to deafenGain intact", () => {
    graph.attachRemoteMic("u1", fakeStream());
    const recStream = graph.mixForRecording(fakeTrack("audio"));
    const ctx = port.last();
    const dest = ctx.destinations[0];
    const userGain = ctx.gains[FIRST_USER];
    const micSource = ctx.sources.at(-1);
    expect(recStream).toBe(dest?.stream);
    expect(userGain?.outputs).toContain(dest);
    expect(userGain?.outputs).toContain(ctx.gains[DEAFEN]);
    expect(ctx.gains[SB]?.outputs).toContain(dest);

    graph.releaseRecordingMix();
    // the recording tap is gone from every source, but the live path (→ deafenGain) is untouched
    expect(userGain?.outputs).not.toContain(dest);
    expect(userGain?.outputs).toContain(ctx.gains[DEAFEN]);
    expect(ctx.gains[SB]?.outputs).not.toContain(dest);
    expect(micSource?.disconnected).toBe(true);
    // idempotent — a second release is a no-op
    expect(() => graph.releaseRecordingMix()).not.toThrow();
  });

  it("close() closes the context and clears the graph", async () => {
    graph.attachRemoteMic("u1", fakeStream());
    await graph.close();
    expect(port.last().closed).toBe(true);
    expect(graph.getUserAnalyser("u1")).toBeNull();
  });

  it("methods throw before init()", () => {
    const fresh = new AudioGraph(new FakeAudioPort());
    expect(() => fresh.setDeafened(true)).toThrow("not initialized");
  });
});
