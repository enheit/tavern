import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioGraph } from "@/media/audioGraph";
import { createSoundFetcher, SoundboardPlayer } from "@/media/soundboardPlayer";

// A fake AudioGraph: the player reaches the graph only through decode / playSoundboard / stopSoundboard.
// Cast to AudioGraph is a test double (§9.1 exception).
class FakeGraph {
  readonly decoded: ArrayBuffer[] = [];
  readonly played: Array<[AudioBuffer, number, number]> = [];
  stopCount = 0;
  readonly buffer = { duration: 1, sampleRate: 48000 } as unknown as AudioBuffer;
  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(bytes);
    return this.buffer;
  }
  async playSoundboard(buffer: AudioBuffer, startMs: number, endMs: number): Promise<void> {
    this.played.push([buffer, startMs, endMs]);
  }
  stopSoundboard(): void {
    this.stopCount += 1;
  }
}

function makePlayer(fetchSound: (soundId: string) => Promise<ArrayBuffer>): {
  graph: FakeGraph;
  player: SoundboardPlayer;
} {
  const graph = new FakeGraph();
  const player = new SoundboardPlayer({ graph: graph as unknown as AudioGraph, fetchSound });
  return { graph, player };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("FR-36 soundboard player", () => {
  it("play decodes then calls graph.playSoundboard(buffer, 1200, 3500) for trim 1200..3500", async () => {
    const bytes = new ArrayBuffer(8);
    const fetchSound = vi.fn(async () => bytes);
    const { graph, player } = makePlayer(fetchSound);

    await player.play({ id: "s1", trimStartMs: 1200, trimEndMs: 3500 });

    expect(fetchSound).toHaveBeenCalledWith("s1");
    expect(graph.decoded).toEqual([bytes]);
    expect(graph.played).toEqual([[graph.buffer, 1200, 3500]]);
  });

  it("allows two overlapping plays; stopAll calls graph.stopSoundboard", async () => {
    const fetchSound = vi.fn(async () => new ArrayBuffer(4));
    const { graph, player } = makePlayer(fetchSound);

    await Promise.all([
      player.play({ id: "a", trimStartMs: 0, trimEndMs: 500 }),
      player.play({ id: "b", trimStartMs: 100, trimEndMs: 600 }),
    ]);
    // Both plays reached the graph — overlapping/concurrent playback is allowed (Discord-style).
    expect(graph.played).toHaveLength(2);

    player.stopAll();
    expect(graph.stopCount).toBe(1);
  });

  it("fetches bytes once for repeated plays (Cache API hit), decodes each time", async () => {
    const store = new Map<string, Response>();
    const fakeCache = {
      match: vi.fn(async (url: string) => store.get(url)),
      put: vi.fn(async (url: string, res: Response) => {
        store.set(url, res);
      }),
    };
    vi.stubGlobal("caches", { open: vi.fn(async () => fakeCache) });
    const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(16), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graph, player } = makePlayer(createSoundFetcher("srv-1"));
    await player.play({ id: "s1", trimStartMs: 0, trimEndMs: 1000 });
    await player.play({ id: "s1", trimStartMs: 0, trimEndMs: 1000 });

    // The mp3 bytes are fetched from the network only ONCE — the 2nd play is served from the cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // NO decoded-buffer cache (§7.4) — the player decodes on every play.
    expect(graph.decoded).toHaveLength(2);
    // The R2 key is derived inside the fetcher from serverId + soundId.
    expect(fakeCache.match).toHaveBeenCalledWith("/api/media/sounds/srv-1/s1.mp3");
    expect(fetchMock).toHaveBeenCalledWith("/api/media/sounds/srv-1/s1.mp3", expect.anything());
  });

  it("deafen stopAll leaves no live sources (graph.stopSoundboard called)", async () => {
    const fetchSound = vi.fn(async () => new ArrayBuffer(4));
    const { graph, player } = makePlayer(fetchSound);

    await player.play({ id: "a", trimStartMs: 0, trimEndMs: 500 });
    // Deafen-on cuts in-flight soundboard audio via the player's stopAll → graph.stopSoundboard.
    player.stopAll();
    expect(graph.stopCount).toBe(1);
  });
});
