import { describe, expect, it } from "vitest";
import { screenCodecPreferences, supportedScreenCodecs } from "@/media/rtc/codecs";

const capabilities: RTCRtpCapabilities = {
  codecs: [
    { mimeType: "video/VP8", clockRate: 90_000 },
    {
      mimeType: "video/H264",
      clockRate: 90_000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
    },
    {
      mimeType: "video/H264",
      clockRate: 90_000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=4d001f",
    },
    { mimeType: "video/AV1", clockRate: 90_000 },
    { mimeType: "video/VP9", clockRate: 90_000 },
    { mimeType: "video/rtx", clockRate: 90_000 },
    { mimeType: "video/red", clockRate: 90_000 },
    { mimeType: "video/ulpfec", clockRate: 90_000 },
  ],
  headerExtensions: [],
};

describe("explicit screen codec preferences", () => {
  it("reports only the user-selectable codecs actually exposed by the sender", () => {
    expect(supportedScreenCodecs(capabilities)).toEqual(["vp8", "h264", "vp9", "av1"]);
    expect(supportedScreenCodecs(null)).toEqual([]);
  });

  it("keeps every selected H.264 profile and repair codec while excluding other primaries", () => {
    const preferences = screenCodecPreferences(capabilities, "h264");
    expect(preferences.map((codec) => codec.mimeType)).toEqual([
      "video/H264",
      "video/H264",
      "video/rtx",
      "video/red",
      "video/ulpfec",
    ]);
    expect(preferences.map((codec) => codec.sdpFmtpLine).filter(Boolean)).toEqual([
      "packetization-mode=1;profile-level-id=42e01f",
      "packetization-mode=1;profile-level-id=4d001f",
    ]);
  });

  it("rejects an unavailable selection instead of falling back", () => {
    const vp8Only: RTCRtpCapabilities = {
      codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
      headerExtensions: [],
    };
    expect(() => screenCodecPreferences(vp8Only, "av1")).toThrow(
      "AV1 is not supported by this video sender",
    );
  });
});
