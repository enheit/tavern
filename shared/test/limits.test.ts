import { describe, it, expect } from "vitest";
import { LIMITS } from "../src/limits";

describe("App-B limits", () => {
  it("usernameRe accepts/rejects per spec", () => {
    expect(LIMITS.usernameRe.test("roman_1")).toBe(true);
    expect(LIMITS.usernameRe.test("abc")).toBe(true);
    expect(LIMITS.usernameRe.test("ab")).toBe(false);
    expect(LIMITS.usernameRe.test("ROMAN")).toBe(false);
    expect(LIMITS.usernameRe.test("a".repeat(21))).toBe(false);
    expect(LIMITS.usernameRe.test("has space")).toBe(false);
  });

  it("serverNicknameRe is case-insensitive with length bounds", () => {
    expect(LIMITS.serverNicknameRe.test("Tavern-01")).toBe(true);
    expect(LIMITS.serverNicknameRe.test("ab")).toBe(false);
    expect(LIMITS.serverNicknameRe.test("a".repeat(33))).toBe(false);
  });

  it("colorRe accepts lowercase #rrggbb only", () => {
    expect(LIMITS.colorRe.test("#a1b2c3")).toBe(true);
    expect(LIMITS.colorRe.test("#A1B2C3")).toBe(false);
    expect(LIMITS.colorRe.test("#fff")).toBe(false);
    expect(LIMITS.colorRe.test("a1b2c3")).toBe(false);
  });
});
