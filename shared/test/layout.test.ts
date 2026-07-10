import { describe, it, expect } from "vitest";
import { computeLayout, fittedTileArea } from "../src/layout";

describe("FR-32 canvas auto-layout", () => {
  const expected = [
    [1],
    [2],
    [2, 1],
    [2, 2],
    [2, 3],
    [3, 3],
    [4, 3],
    [4, 4],
    [3, 3, 3],
    [4, 3, 3],
    [4, 4, 3],
    [4, 4, 4],
  ];

  it("locks the full table at 1600x900 for n=1..12", () => {
    for (let n = 1; n <= 12; n++) {
      expect(computeLayout(n, 1600, 900).rows).toEqual(expected[n - 1]);
    }
  });

  it("n=2 tie-break by fitted area", () => {
    expect(computeLayout(2, 2100, 900).rows).toEqual([2]); // side 620156.25 > stacked 360000
    expect(computeLayout(2, 1600, 900).rows).toEqual([2]); // tie 360000 = 360000
    expect(computeLayout(2, 1200, 900).rows).toEqual([1, 1]); // 202500 < 360000
  });

  it("fittedTileArea spot values", () => {
    expect(fittedTileArea(800, 900)).toBe(360000);
    expect(fittedTileArea(1050, 900)).toBe(620156.25);
  });

  it("extension rule + edge cases", () => {
    expect(computeLayout(13, 1600, 900).rows).toEqual([4, 3, 3, 3]);
    expect(computeLayout(16, 1600, 900).rows).toEqual([4, 4, 4, 4]);
    expect(computeLayout(0, 1600, 900).rows).toEqual([]);
  });
});
