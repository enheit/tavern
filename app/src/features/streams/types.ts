import type { PresetId } from "@tavern/shared";

// App-local screen-share selection (NOT a protocol type — the wire uses trackName/preset only).
// `sourceId` is the desktop capturer source id to arm (null on web, where the browser picks the
// source). `preset` is the App-D quality ceiling. `withAudio` requests system/tab audio (FR-28) —
// the picker only sets it true where the OS supports it.
export interface ShareSelection {
  sourceId: string | null;
  preset: PresetId;
  withAudio: boolean;
}
