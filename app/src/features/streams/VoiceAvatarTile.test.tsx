import type { Member, VoiceMember } from "@tavern/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaStore } from "@/stores/media";
import { VoiceAvatarTile } from "./VoiceAvatarTile";

const profile: Member = {
  userId: "voice-user",
  username: "voice-user",
  displayName: "Voice User",
  color: "#8b5cf6",
  voiceAvatar: {
    version: 2,
    skinTone: "warm-medium",
    hairColor: "ginger",
    hairStyle: "wavy",
    eyeColor: "green",
    glassesStyle: "round",
    facialHairStyle: "mustache",
    outfitColor: "#f97316",
  },
  presence: "in-voice",
  isAdmin: false,
  joinedAt: 1,
};

const voice: VoiceMember = { userId: profile.userId, muted: false, deafened: false };

beforeEach(() => useMediaStore.getState().clearSpeaking());
afterEach(() => cleanup());

describe("Stream voice avatar tile", () => {
  it("shows speaking/custom state and promotes itself when clicked", async () => {
    const onFocus = vi.fn();
    useMediaStore.getState().setSpeaking(profile.userId, true);
    render(
      <VoiceAvatarTile active member={{ profile, voice }} onFocus={onFocus} serverId="server" />,
    );

    const tile = screen.getByTestId(`voice-avatar-tile-${profile.userId}`);
    expect(tile.getAttribute("data-speaking")).toBe("true");
    expect(tile.getAttribute("data-avatar-mode")).toBe("custom");
    await waitFor(() => expect(tile.getAttribute("data-renderer")).toBe("fallback"));

    fireEvent.click(tile);
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("marks server-muted participants and uses compact presentation in the strip", async () => {
    render(
      <VoiceAvatarTile
        active
        compact
        member={{ profile, voice: { ...voice, muted: true } }}
        onFocus={vi.fn()}
        serverId="server"
      />,
    );

    const tile = screen.getByTestId(`voice-avatar-tile-${profile.userId}`);
    expect(tile.getAttribute("data-muted")).toBe("true");
    expect(tile.getAttribute("data-compact")).toBe("true");
    await waitFor(() => expect(tile.getAttribute("data-renderer")).toBe("fallback"));
  });
});
