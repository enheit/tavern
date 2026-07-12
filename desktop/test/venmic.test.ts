import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareVenmic,
  releaseVenmic,
  resetVenmicForTest,
  resolveAudioServicePid,
} from "../src/main/venmic";
import type { ProcessMetricLike } from "../src/main/venmic";

vi.mock("electron", () => import("./electron-mock"));

// A fake venmic PatchBay: records link payloads, configurable hasPipeWire/link results.
function fakeVenmic(over: { hasPipeWire?: boolean; linkResult?: boolean; linkThrows?: boolean }) {
  const links: unknown[] = [];
  let unlinks = 0;
  class PatchBay {
    link(data: unknown): boolean {
      if (over.linkThrows === true) throw new Error("pw_core_connect failed");
      links.push(data);
      return over.linkResult ?? true;
    }
    unlink(): boolean {
      unlinks += 1;
      return true;
    }
    static hasPipeWire(): boolean {
      return over.hasPipeWire ?? true;
    }
  }
  return { PatchBay, links, unlinkCount: () => unlinks };
}

const AUDIO_SERVICE: ProcessMetricLike = {
  pid: 4242,
  type: "Utility",
  name: "Audio Service",
  serviceName: "audio.mojom.AudioService",
};

beforeEach(() => {
  resetVenmicForTest();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Task-3 resolveAudioServicePid", () => {
  it("finds the Utility audio-service process by name or serviceName", () => {
    expect(resolveAudioServicePid([AUDIO_SERVICE])).toBe(4242);
    expect(
      resolveAudioServicePid([
        { pid: 1, type: "Browser" },
        { pid: 7, type: "Utility", serviceName: "audio.mojom.AudioService" },
      ]),
    ).toBe(7);
    expect(resolveAudioServicePid([{ pid: 9, type: "Utility", name: "Audio Service" }])).toBe(9);
  });

  it("never matches non-Utility or unrelated utility processes", () => {
    expect(
      resolveAudioServicePid([
        { pid: 1, type: "Browser", name: "Audio Service" },
        { pid: 2, type: "Utility", serviceName: "network.mojom.NetworkService" },
        { pid: 3, type: "GPU" },
      ]),
    ).toBeNull();
    expect(resolveAudioServicePid([])).toBeNull();
  });
});

describe("Task-3 prepareVenmic", () => {
  it("links with the audio-service PID excluded and app streams only", async () => {
    const venmic = fakeVenmic({});
    const ok = await prepareVenmic({
      platform: "linux",
      loadCtor: () => venmic.PatchBay,
      metrics: () => [AUDIO_SERVICE],
    });
    expect(ok).toBe(true);
    expect(venmic.links).toEqual([
      {
        exclude: [{ "application.process.id": "4242" }],
        ignore_devices: true,
      },
    ]);
  });

  it("non-linux is false without touching the module", async () => {
    const load = vi.fn();
    expect(await prepareVenmic({ platform: "darwin", loadCtor: load })).toBe(false);
    expect(await prepareVenmic({ platform: "win32", loadCtor: load })).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("no PipeWire → false, and link is never attempted", async () => {
    const venmic = fakeVenmic({ hasPipeWire: false });
    const ok = await prepareVenmic({
      platform: "linux",
      loadCtor: () => venmic.PatchBay,
      metrics: () => [AUDIO_SERVICE],
    });
    expect(ok).toBe(false);
    expect(venmic.links).toEqual([]);
  });

  it("missing module (optional dep absent / prebuild load error) → false, silently", async () => {
    const ok = await prepareVenmic({
      platform: "linux",
      loadCtor: () => {
        throw new Error("Cannot find module '@vencord/venmic'");
      },
      metrics: () => [AUDIO_SERVICE],
    });
    expect(ok).toBe(false);
  });

  it("no audio-service process yet → false (voices would leak without the exclusion)", async () => {
    const venmic = fakeVenmic({});
    const ok = await prepareVenmic({
      platform: "linux",
      loadCtor: () => venmic.PatchBay,
      metrics: () => [{ pid: 1, type: "Browser" }],
    });
    expect(ok).toBe(false);
    expect(venmic.links).toEqual([]);
  });

  it("a throwing or refusing link() → false", async () => {
    const throwing = fakeVenmic({ linkThrows: true });
    expect(
      await prepareVenmic({
        platform: "linux",
        loadCtor: () => throwing.PatchBay,
        metrics: () => [AUDIO_SERVICE],
      }),
    ).toBe(false);

    resetVenmicForTest();
    const refusing = fakeVenmic({ linkResult: false });
    expect(
      await prepareVenmic({
        platform: "linux",
        loadCtor: () => refusing.PatchBay,
        metrics: () => [AUDIO_SERVICE],
      }),
    ).toBe(false);
  });
});

describe("Task-3 releaseVenmic", () => {
  it("unlinks once after a successful link; a re-link re-arms it", async () => {
    const venmic = fakeVenmic({});
    const deps = {
      platform: "linux" as const,
      loadCtor: () => venmic.PatchBay,
      metrics: () => [AUDIO_SERVICE],
    };
    await prepareVenmic(deps);
    releaseVenmic();
    releaseVenmic(); // idempotent — venmic throws on double-unlink, so the guard matters
    expect(venmic.unlinkCount()).toBe(1);

    await prepareVenmic(deps);
    releaseVenmic();
    expect(venmic.unlinkCount()).toBe(2);
  });

  it("is a no-op when nothing ever linked", () => {
    expect(() => releaseVenmic()).not.toThrow();
  });
});
