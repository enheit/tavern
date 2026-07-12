import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareVenmic,
  releaseVenmic,
  resetVenmicForTest,
  resolveAudioServicePid,
  shutdownVenmic,
} from "../src/main/venmic";
import type { ProcessMetricLike, VenmicHostLike } from "../src/main/venmic";

vi.mock("electron", () => import("./electron-mock"));

// A fake venmic utilityProcess host: records posted messages; `onLink` decides how (and whether)
// the host answers a {t:"link"} request. Exit/kill are driven by the test.
function fakeHost(onLink?: (pid: number, emit: (msg: unknown) => void) => void) {
  const messageListeners = new Set<(msg: unknown) => void>();
  const exitListeners = new Set<() => void>();
  const posted: unknown[] = [];
  let killed = false;
  const emitMessage = (msg: unknown): void => {
    for (const listener of messageListeners) listener(msg);
  };
  const emitExit = (): void => {
    for (const listener of exitListeners) listener();
    exitListeners.clear();
  };
  const host: VenmicHostLike = {
    postMessage(msg: unknown) {
      posted.push(msg);
      const rec = msg as { t?: string; pid?: number };
      if (rec.t === "link" && typeof rec.pid === "number") onLink?.(rec.pid, emitMessage);
    },
    on(_event, listener) {
      messageListeners.add(listener);
      return host;
    },
    off(event, listener) {
      if (event === "message") messageListeners.delete(listener as (msg: unknown) => void);
      else exitListeners.delete(listener as () => void);
      return host;
    },
    once(_event, listener) {
      exitListeners.add(listener);
      return host;
    },
    kill() {
      killed = true;
      emitExit();
      return true;
    },
  };
  return { host, posted, emitMessage, emitExit, wasKilled: () => killed };
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

describe("Task-3 prepareVenmic (utilityProcess host)", () => {
  it("forks the host once and links with the audio-service PID", async () => {
    const fake = fakeHost((_pid, emit) => {
      emit({ t: "link.result", ok: true });
    });
    const fork = vi.fn(() => fake.host);
    const deps = { platform: "linux" as const, metrics: () => [AUDIO_SERVICE], fork };

    expect(await prepareVenmic(deps)).toBe(true);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fake.posted).toEqual([{ t: "link", pid: 4242 }]);

    // Second share start reuses the SAME host (no respawn while it lives).
    expect(await prepareVenmic(deps)).toBe(true);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("non-linux is false without forking", async () => {
    const fork = vi.fn();
    expect(await prepareVenmic({ platform: "darwin", fork })).toBe(false);
    expect(await prepareVenmic({ platform: "win32", fork })).toBe(false);
    expect(fork).not.toHaveBeenCalled();
  });

  it("no audio-service process yet → false, no fork (voices would leak without the exclusion)", async () => {
    const fork = vi.fn();
    const ok = await prepareVenmic({
      platform: "linux",
      metrics: () => [{ pid: 1, type: "Browser" }],
      fork,
    });
    expect(ok).toBe(false);
    expect(fork).not.toHaveBeenCalled();
  });

  it("a host that reports link failure (no PipeWire, link refused) → false", async () => {
    const fake = fakeHost((_pid, emit) => {
      emit({ t: "link.result", ok: false });
    });
    const ok = await prepareVenmic({
      platform: "linux",
      metrics: () => [AUDIO_SERVICE],
      fork: () => fake.host,
    });
    expect(ok).toBe(false);
  });

  it("a host that CRASHES mid-link (native PipeWire abort) → false; the next share respawns", async () => {
    const crashing = fakeHost();
    const fresh = fakeHost((_pid, emit) => {
      emit({ t: "link.result", ok: true });
    });
    const fork = vi
      .fn<() => VenmicHostLike>()
      .mockReturnValueOnce(crashing.host)
      .mockReturnValueOnce(fresh.host);
    const deps = { platform: "linux" as const, metrics: () => [AUDIO_SERVICE], fork };

    const attempt = prepareVenmic(deps);
    crashing.emitExit(); // SIGABRT stand-in
    expect(await attempt).toBe(false);

    expect(await prepareVenmic(deps)).toBe(true);
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("a hung host is killed at the timeout and reports false", async () => {
    const fake = fakeHost(); // never answers
    const ok = await prepareVenmic({
      platform: "linux",
      metrics: () => [AUDIO_SERVICE],
      fork: () => fake.host,
      timeoutMs: 10,
    });
    expect(ok).toBe(false);
    expect(fake.wasKilled()).toBe(true);
  });
});

describe("Task-3 releaseVenmic / shutdownVenmic", () => {
  function linkedHost() {
    const fake = fakeHost((_pid, emit) => {
      emit({ t: "link.result", ok: true });
    });
    const deps = { platform: "linux" as const, metrics: () => [AUDIO_SERVICE], fork: () => fake.host };
    return { fake, deps };
  }

  it("unlinks once after a successful link; a re-link re-arms it", async () => {
    const { fake, deps } = linkedHost();
    await prepareVenmic(deps);
    releaseVenmic();
    releaseVenmic(); // idempotent — the linked flag guards the double-send
    expect(fake.posted.filter((m) => (m as { t: string }).t === "unlink")).toHaveLength(1);

    await prepareVenmic(deps);
    releaseVenmic();
    expect(fake.posted.filter((m) => (m as { t: string }).t === "unlink")).toHaveLength(2);
  });

  it("is a no-op when nothing ever linked", () => {
    expect(() => releaseVenmic()).not.toThrow();
  });

  it("a crashed host is never messaged (its mic died with it)", async () => {
    const { fake, deps } = linkedHost();
    await prepareVenmic(deps);
    fake.emitExit();
    releaseVenmic();
    expect(fake.posted.filter((m) => (m as { t: string }).t === "unlink")).toHaveLength(0);
  });

  it("shutdown kills the host for app quit", async () => {
    const { fake, deps } = linkedHost();
    await prepareVenmic(deps);
    shutdownVenmic();
    expect(fake.wasKilled()).toBe(true);
  });
});
