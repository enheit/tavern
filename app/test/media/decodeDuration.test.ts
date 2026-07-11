import { describe, expect, it, vi } from "vitest";

// decodeDurationMs only touches the injected audio port — stub it so no real AudioContext exists.
const createContext = vi.hoisted(() => vi.fn());
vi.mock("@/media/ports", () => ({ browserAudioPort: { createContext } }));

import { decodeDurationMs } from "@/media/decodeDuration";

function fakeFile(): File {
  return { arrayBuffer: vi.fn(async () => new ArrayBuffer(8)) } as unknown as File;
}

describe("FR-34 decodeDurationMs", () => {
  it("decodes at 48 kHz, rounds duration to ms and closes the context", async () => {
    const close = vi.fn(async () => undefined);
    const decodeAudioData = vi.fn(async () => ({ duration: 1.2345 }));
    createContext.mockReturnValue({ decodeAudioData, close });

    await expect(decodeDurationMs(fakeFile())).resolves.toBe(1235);
    expect(createContext).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the context even when decoding fails", async () => {
    const close = vi.fn(async () => undefined);
    createContext.mockReturnValue({
      decodeAudioData: vi.fn(async () => {
        throw new Error("bad file");
      }),
      close,
    });

    await expect(decodeDurationMs(fakeFile())).rejects.toThrow("bad file");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
