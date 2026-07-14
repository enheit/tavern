import { describe, expect, it } from "vitest";
import { forceInfiniteWebpLoop, MarketImageError } from "../src/lib/marketImage";

function animatedWebp(loopCount: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 18, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("ANIM"), 12);
  new DataView(bytes.buffer).setUint32(16, 6, true);
  new DataView(bytes.buffer).setUint16(24, loopCount, true);
  return bytes;
}

describe("market WebP normalization", () => {
  it("forces an animated WebP loop count to the infinite sentinel without mutating the input", () => {
    const input = animatedWebp(3);
    const output = forceInfiniteWebpLoop(input);

    expect(new DataView(input.buffer).getUint16(24, true)).toBe(3);
    expect(new DataView(output.buffer).getUint16(24, true)).toBe(0);
  });

  it("rejects a malformed RIFF payload", () => {
    expect(() => forceInfiniteWebpLoop(new Uint8Array([1, 2, 3]))).toThrowError(MarketImageError);
  });
});
