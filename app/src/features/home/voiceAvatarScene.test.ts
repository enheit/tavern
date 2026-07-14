import { describe, expect, it } from "vitest";
import {
  automaticVoiceAvatarConfig,
  avatarStyleForUser,
  voiceAvatarMouthPose,
  voiceLoungeColumns,
} from "./voiceAvatarScene";

describe("Voice Lounge avatar model", () => {
  it("uses a balanced grid up to ten people and caps wider rooms at five columns", () => {
    expect([0, 1, 5, 6, 8, 10, 18].map(voiceLoungeColumns)).toEqual([0, 1, 5, 3, 4, 5, 5]);
  });

  it("derives a stable visual identity from the user id", () => {
    const roman = avatarStyleForUser("15591ec7-e192-4059-934e-a37b897e4d79");
    expect(avatarStyleForUser("15591ec7-e192-4059-934e-a37b897e4d79")).toEqual(roman);
    expect(avatarStyleForUser("85174d13-71a7-490f-98fc-596029c205f8")).not.toEqual(roman);
  });

  it("resolves an explicit persisted recipe instead of the automatic identity", () => {
    const userId = "15591ec7-e192-4059-934e-a37b897e4d79";
    const config = {
      version: 2,
      skinTone: "ebony",
      hairColor: "ginger",
      hairStyle: "wavy",
      eyeColor: "green",
      glassesStyle: "aviator",
      facialHairStyle: "mustache",
      outfitColor: "#1e3a8a",
    } as const;
    expect(avatarStyleForUser(userId, config)).toEqual({
      skin: "#3b231c",
      hair: "#c45a2c",
      eyes: "#547b52",
      hairStyle: "wavy",
      glassesStyle: "aviator",
      facialHairStyle: "mustache",
    });
  });

  it("keeps automatic identities deterministic while inheriting the profile outfit color", () => {
    const userId = "15591ec7-e192-4059-934e-a37b897e4d79";
    const automatic = automaticVoiceAvatarConfig(userId, "#22d3ee");
    expect(automaticVoiceAvatarConfig(userId, "#22d3ee")).toEqual(automatic);
    expect(automatic.version).toBe(2);
    expect(automatic.outfitColor).toBe("#22d3ee");
    expect(automatic.eyeColor).toBe("dark-brown");
  });

  it("opens downward and moves the teeth with the mouth without letting them escape", () => {
    const idle = voiceAvatarMouthPose(0);
    const open = voiceAvatarMouthPose(1);
    const idleTop = idle.centerY + idle.scaleY / 2;
    const openTop = open.centerY + open.scaleY / 2;

    expect(openTop).toBeCloseTo(idleTop);
    expect(open.centerY - open.scaleY / 2).toBeLessThan(idle.centerY - idle.scaleY / 2);
    expect(open.teethY).toBeLessThan(idle.teethY);

    for (const level of [0, 0.25, 0.5, 0.75, 1]) {
      const pose = voiceAvatarMouthPose(level);
      const mouthTop = pose.centerY + pose.scaleY / 2;
      const mouthBottom = pose.centerY - pose.scaleY / 2;
      expect(pose.teethY + 0.055 / 2).toBeLessThan(mouthTop);
      expect(pose.teethY - 0.055 / 2).toBeGreaterThan(mouthBottom);
    }
  });
});
