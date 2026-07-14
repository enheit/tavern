export const SCREEN_CODECS = ["vp8", "h264", "vp9", "av1"] as const;

export type ScreenCodec = (typeof SCREEN_CODECS)[number];

// VP8 is Tavern's explicit default because it was the smoothest software encoder in the real-SFU
// comparison on the current test machine. The picker still makes this visible and lets the user
// choose any codec their sender actually exposes; Tavern never silently replaces that selection.
export const DEFAULT_SCREEN_CODEC: ScreenCodec = "vp8";

export const SCREEN_CODEC_LABELS: Record<ScreenCodec, string> = {
  vp8: "VP8",
  h264: "H.264",
  vp9: "VP9",
  av1: "AV1",
};

const SCREEN_CODEC_MIME_TYPES: Record<ScreenCodec, string> = {
  vp8: "video/vp8",
  h264: "video/h264",
  vp9: "video/vp9",
  av1: "video/av1",
};

const VIDEO_REPAIR_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);

export function isScreenCodec(value: unknown): value is ScreenCodec {
  return SCREEN_CODECS.some((codec) => codec === value);
}

export function supportedScreenCodecs(capabilities: RTCRtpCapabilities | null): ScreenCodec[] {
  if (capabilities === null) return [];
  const mimeTypes = new Set(capabilities.codecs.map((codec) => codec.mimeType.toLowerCase()));
  return SCREEN_CODECS.filter((codec) => mimeTypes.has(SCREEN_CODEC_MIME_TYPES[codec]));
}

// setCodecPreferences receives only the user's selected primary codec (all of its advertised
// profiles, in browser order) plus the browser's repair codecs. Other primary video codecs are
// deliberately excluded, so negotiation either uses the explicit selection or fails visibly.
export function screenCodecPreferences(
  capabilities: RTCRtpCapabilities | null,
  selected: ScreenCodec,
): RTCRtpCodec[] {
  if (capabilities === null) {
    throw new Error("This browser cannot report its screen-stream codec capabilities");
  }
  const selectedMimeType = SCREEN_CODEC_MIME_TYPES[selected];
  const primary = capabilities.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === selectedMimeType,
  );
  if (primary.length === 0) {
    throw new Error(`${SCREEN_CODEC_LABELS[selected]} is not supported by this video sender`);
  }
  const repair = capabilities.codecs.filter((codec) =>
    VIDEO_REPAIR_MIME_TYPES.has(codec.mimeType.toLowerCase()),
  );
  return [...primary, ...repair];
}
