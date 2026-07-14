import type { PresetId } from "@tavern/shared";
import type { ScreenCodec } from "@/media/rtc/codecs";

// App-local screen-share selection (NOT a protocol type — the wire uses trackName/preset only).
// `sourceId` is the desktop capturer source id to arm (null on web, where the browser picks the
// source). `preset` is the App-D quality ceiling. `codec` is the user's explicit encoder selection;
// it is applied before WebRTC creates the offer and is never silently replaced. `withAudio` requests
// system/tab audio (FR-28); the picker always enables it, while lower-level callers can model no audio.
export interface ShareSelection {
  sourceId: string | null;
  preset: PresetId;
  codec: ScreenCodec;
  withAudio: boolean;
}

// Capture geometry/audio do not depend on the encoder selected later by WebRTC. Keeping this input
// narrow lets the capture layer remain independent of codec negotiation.
export type ScreenCaptureSelection = Omit<ShareSelection, "codec">;
