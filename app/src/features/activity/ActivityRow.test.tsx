import type { ActivityEntry, ActivityType, Member } from "@tavern/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityRow } from "@/features/activity/ActivityRow";

afterEach(() => {
  cleanup();
});

function member(over?: Partial<Member>): Member {
  return {
    userId: "u1",
    username: "alice",
    displayName: "Alice",
    color: "#aabbcc",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
    ...over,
  };
}

function entry(type: ActivityType, over?: Partial<ActivityEntry>): ActivityEntry {
  return { id: 1, type, userId: "u1", meta: {}, at: Date.now(), ...over };
}

// Pinned en interpolation for every `activity.types` value (App-A), name resolved to "Alice".
const EXPECTED_EN: Record<ActivityType, string> = {
  "voice.join": "Alice joined voice",
  "voice.leave": "Alice left voice",
  "stream.start": "Alice started streaming",
  "stream.stop": "Alice stopped streaming",
  "rec.start": "Alice started a voice recording",
  "rec.stop": "Alice stopped the voice recording",
  "member.join": "Alice joined the server",
  "member.kick": "Alice was kicked",
};

describe("FR-39 activity rows", () => {
  for (const [type, expected] of Object.entries(EXPECTED_EN) as [ActivityType, string][]) {
    it(`renders the ${type} row with the interpolated en string`, () => {
      render(<ActivityRow entry={entry(type)} members={[member()]} locale="en" />);
      expect(screen.getByText(expected)).toBeDefined();
    });
  }

  it("falls back to former-member label for unknown userId", () => {
    // The entry's userId is not in the member map (departed member).
    render(
      <ActivityRow
        entry={entry("voice.join", { userId: "gone" })}
        members={[member()]}
        locale="en"
      />,
    );
    expect(screen.getByText("Former member joined voice")).toBeDefined();
  });
});
