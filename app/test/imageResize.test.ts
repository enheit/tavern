import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeToWebp, UnsupportedImageError } from "@/lib/imageResize";

// jsdom implements neither createImageBitmap nor a real 2D canvas, so both are stubbed as test doubles
// and the module's crop math + encode call are asserted against them.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FR-05 avatar resize", () => {
  it("rejects unsupported mime type", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "x.gif", { type: "image/gif" });
    await expect(resizeToWebp(file)).rejects.toBeInstanceOf(UnsupportedImageError);
  });

  it("center-crops to 256×256 webp", async () => {
    // A 512×300 source: the largest centered square is 300×300 at x=106, y=0.
    const bitmap = { width: 512, height: 300, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    let seenWidth = 0;
    let seenHeight = 0;
    let seenType: string | undefined;
    let seenQuality: number | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: number,
    ) {
      seenWidth = this.width;
      seenHeight = this.height;
      seenType = type;
      seenQuality = quality;
      callback(new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" }));
    });

    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const blob = await resizeToWebp(file);

    expect(createImageBitmap).toHaveBeenCalledWith(file);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 106, 0, 300, 300, 0, 0, 256, 256);
    expect(seenWidth).toBe(256);
    expect(seenHeight).toBe(256);
    expect(seenType).toBe("image/webp");
    expect(seenQuality).toBe(0.9);
    expect(blob.type).toBe("image/webp");
    expect(bitmap.close).toHaveBeenCalled();
  });
});
