import { describe, expect, it } from "vitest";
import type { NotifyContext } from "@/lib/notifications";
import { shouldNotify, truncateBody } from "@/lib/notifications";

// FR-16 decision rule. The base context is "focused, on server s1, both toggles on, self = me"; each
// case overrides only what it exercises. Messages default to a foreign author so the own-message guard
// stays out of the way except where it is the subject (case 8).
const BASE: NotifyContext = {
  windowFocused: true,
  activeServerId: "s1",
  settings: { notifyAll: true, notifyMentions: true },
  myUserId: "me",
};

type CtxOverride = {
  windowFocused?: boolean;
  activeServerId?: string | null;
  myUserId?: string;
  settings?: Partial<NotifyContext["settings"]>;
};

function ctx(over: CtxOverride): NotifyContext {
  return { ...BASE, ...over, settings: { ...BASE.settings, ...over.settings } };
}

function msg(over: Partial<{ serverId: string; userId: string; mentions: string[] }>) {
  return { serverId: "s1", userId: "other", mentions: [], ...over };
}

describe("FR-16 shouldNotify", () => {
  it("focused + active server + plain message → no", () => {
    expect(shouldNotify(msg({}), ctx({}))).toBe(false);
  });

  it("focused + active server + mention → no", () => {
    expect(shouldNotify(msg({ mentions: ["me"] }), ctx({}))).toBe(false);
  });

  it("focused + OTHER server + plain + all-on → yes", () => {
    expect(shouldNotify(msg({ serverId: "s2" }), ctx({}))).toBe(true);
  });

  it("unfocused + active server + plain + all-on → yes", () => {
    expect(shouldNotify(msg({}), ctx({ windowFocused: false }))).toBe(true);
  });

  it("unfocused + plain + all-off → no", () => {
    expect(
      shouldNotify(msg({}), ctx({ windowFocused: false, settings: { notifyAll: false } })),
    ).toBe(false);
  });

  it("unfocused + mention + mentions-on + all-off → yes", () => {
    expect(
      shouldNotify(
        msg({ mentions: ["me"] }),
        ctx({ windowFocused: false, settings: { notifyAll: false, notifyMentions: true } }),
      ),
    ).toBe(true);
  });

  it("unfocused + mention + mentions-off + all-on → no (mention gate wins)", () => {
    expect(
      shouldNotify(
        msg({ mentions: ["me"] }),
        ctx({ windowFocused: false, settings: { notifyAll: true, notifyMentions: false } }),
      ),
    ).toBe(false);
  });

  it("own message never notifies", () => {
    // Otherwise a notify: unfocused, all-on — but the author is self.
    expect(shouldNotify(msg({ userId: "me" }), ctx({ windowFocused: false }))).toBe(false);
  });

  it("truncates body at 120 with ellipsis", () => {
    const long = "a".repeat(200);
    const out = truncateBody(long);
    expect(out).toHaveLength(121);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 120)).toBe("a".repeat(120));
    // A body already within the limit is returned unchanged (no ellipsis).
    expect(truncateBody("short body")).toBe("short body");
    expect(truncateBody("a".repeat(120))).toBe("a".repeat(120));
  });
});
