import { LIMITS } from "@tavern/shared";
import { describe, expect, it, vi } from "vitest";
import {
  forceInfiniteWebpLoop,
  MarketImageError,
  normalizeMarketIcon,
} from "../src/lib/marketImage";

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

function imageBinding(
  outputBytes: Uint8Array = animatedWebp(3),
  inputInfo: ImageInfoResponse = { format: "image/png", fileSize: 4, width: 12, height: 12 },
  outputInfo: ImageInfoResponse = {
    format: "image/webp",
    fileSize: outputBytes.byteLength,
    width: LIMITS.marketIconSizePx,
    height: LIMITS.marketIconSizePx,
  },
): {
  images: Pick<ImagesBinding, "info" | "input">;
  transform: ReturnType<typeof vi.fn>;
  output: ReturnType<typeof vi.fn>;
} {
  let infoCalls = 0;
  const transform = vi.fn();
  const output = vi.fn();
  const transformer: ImageTransformer = {
    transform(options) {
      transform(options);
      return transformer;
    },
    draw() {
      return transformer;
    },
    async output(options) {
      output(options);
      return {
        response: () => new Response(outputBytes),
        contentType: () => "image/webp",
        image: () => new Blob([outputBytes]).stream(),
      };
    },
  };
  return {
    images: {
      async info() {
        const info = infoCalls === 0 ? inputInfo : outputInfo;
        infoCalls += 1;
        return info;
      },
      input() {
        return transformer;
      },
    },
    transform,
    output,
  };
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

  it("leaves a valid static WebP unchanged", () => {
    const input = new Uint8Array(12);
    input.set(new TextEncoder().encode("RIFF"), 0);
    input.set(new TextEncoder().encode("WEBP"), 8);

    expect(forceInfiniteWebpLoop(input)).toEqual(input);
  });

  it("rejects truncated and undersized WebP chunks", () => {
    const truncated = animatedWebp(1).slice(0, 24);
    const undersized = animatedWebp(1);
    new DataView(undersized.buffer).setUint32(16, 4, true);

    expect(() => forceInfiniteWebpLoop(truncated)).toThrowError(
      expect.objectContaining({ code: "unsupported_media" }),
    );
    expect(() => forceInfiniteWebpLoop(undersized)).toThrowError(
      expect.objectContaining({ code: "unsupported_media" }),
    );
  });

  it("normalizes an accepted image to a padded 48px infinite-loop WebP", async () => {
    const binding = imageBinding();

    const result = await normalizeMarketIcon(
      binding.images,
      new File([new Uint8Array([1, 2, 3, 4])], "icon.png", { type: "image/png" }),
    );

    expect(new DataView(result.buffer).getUint16(24, true)).toBe(0);
    expect(binding.transform).toHaveBeenCalledWith({
      width: LIMITS.marketIconSizePx,
      height: LIMITS.marketIconSizePx,
      fit: "pad",
      background: "rgba(0,0,0,0)",
    });
    expect(binding.output).toHaveBeenCalledWith({ format: "image/webp", quality: 90, anim: true });
  });

  it("rejects an oversized upload before invoking the Images binding", async () => {
    const binding = imageBinding();
    const file = new File([new Uint8Array(LIMITS.marketIconInputMaxBytes + 1)], "huge.png");

    await expect(normalizeMarketIcon(binding.images, file)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    expect(binding.transform).not.toHaveBeenCalled();
  });

  it("maps invalid Images input and rejects unsupported input metadata", async () => {
    const invalidImages = {
      async info(): Promise<ImageInfoResponse> {
        throw { code: 9412 };
      },
      input(): ImageTransformer {
        throw new Error("input must not run");
      },
    } satisfies Pick<ImagesBinding, "info" | "input">;
    const svg = imageBinding(animatedWebp(0), { format: "image/svg+xml" });
    const file = new File([new Uint8Array([1])], "icon.bin");

    await expect(normalizeMarketIcon(invalidImages, file)).rejects.toMatchObject({
      code: "unsupported_media",
    });
    await expect(normalizeMarketIcon(svg.images, file)).rejects.toMatchObject({
      code: "unsupported_media",
    });
  });

  it("rejects an oversized or invalid transformation result", async () => {
    const oversized = imageBinding(new Uint8Array(LIMITS.marketIconOutputMaxBytes + 1));
    const wrongDimensions = imageBinding(animatedWebp(0), undefined, {
      format: "image/webp",
      fileSize: 26,
      width: LIMITS.marketIconSizePx + 1,
      height: LIMITS.marketIconSizePx,
    });
    const file = new File([new Uint8Array([1])], "icon.png");

    await expect(normalizeMarketIcon(oversized.images, file)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await expect(normalizeMarketIcon(wrongDimensions.images, file)).rejects.toMatchObject({
      code: "unsupported_media",
    });
  });
});
