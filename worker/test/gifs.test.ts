import { describe, expect, it } from "vitest";
import type { GifResult } from "@tavern/shared";
import { normalize } from "../src/routes/gifs";

// `normalize` is the untrusted-upstream boundary of the GIF proxy: it parses raw Klipy `data.data`
// items, drops anything malformed / non-gif, and projects the surviving items into the shared
// `GifResult` shape. These tests pin that projection + the tier-walk / drop rules without any network.

// Build one Klipy `file.<tier>` value — a wrapper carrying the concrete gif media for that size tier.
function tier(
  url: string,
  width: number,
  height: number,
): { gif: { url: string; width: number; height: number } } {
  return { gif: { url, width, height } };
}

describe("GIF proxy normalize()", () => {
  it("projects a valid item: full from hd, preview from sm, id stringified", () => {
    const raw = [
      {
        id: 12345,
        type: "gif",
        file: {
          hd: tier("https://static.klipy.com/gif/hero-hd.gif", 498, 371),
          md: tier("https://static.klipy.com/gif/hero-md.gif", 300, 224),
          sm: tier("https://static.klipy.com/gif/hero-sm.gif", 150, 112),
        },
      },
    ];
    const expected: GifResult[] = [
      {
        id: "12345",
        url: "https://static.klipy.com/gif/hero-hd.gif",
        previewUrl: "https://static.klipy.com/gif/hero-sm.gif",
        width: 498,
        height: 371,
      },
    ];
    expect(normalize(raw)).toEqual(expected);
  });

  it('drops Klipy ad / sticker items (type defined and not "gif")', () => {
    const raw = [
      {
        id: 1,
        type: "ad",
        file: { hd: tier("https://static.klipy.com/gif/ad-hd.gif", 320, 240) },
      },
      {
        id: 2,
        type: "sticker",
        file: { hd: tier("https://static.klipy.com/gif/sticker-hd.gif", 320, 240) },
      },
    ];
    expect(normalize(raw)).toEqual([]);
  });

  it("drops an item whose file has no gif variant in any tier", () => {
    const raw = [
      {
        id: 7,
        type: "gif",
        // Tiers present but each carries no `gif` media → pickVariant returns null for both walks.
        file: { hd: {}, md: {}, sm: {}, xs: {} },
      },
    ];
    expect(normalize(raw)).toEqual([]);
  });

  it("walks the full tier fallback: md is used when hd is absent", () => {
    const raw = [
      {
        id: 42,
        type: "gif",
        file: {
          md: tier("https://static.klipy.com/gif/fallback-md.gif", 300, 200),
          sm: tier("https://static.klipy.com/gif/fallback-sm.gif", 150, 100),
        },
      },
    ];
    const expected: GifResult[] = [
      {
        id: "42",
        url: "https://static.klipy.com/gif/fallback-md.gif",
        previewUrl: "https://static.klipy.com/gif/fallback-sm.gif",
        width: 300,
        height: 200,
      },
    ];
    expect(normalize(raw)).toEqual(expected);
  });

  it("returns [] for an empty input array", () => {
    expect(normalize([])).toEqual([]);
  });
});
