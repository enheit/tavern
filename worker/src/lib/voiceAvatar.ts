import { VoiceAvatarConfigInput } from "@tavern/shared";
import type { VoiceAvatarConfig } from "@tavern/shared";

// The database stores this small versioned recipe as JSON because no query filters on individual
// avatar parts. Decode once at each storage boundary so every downstream UserProfile is trustworthy.
export function voiceAvatarFromStorage(raw: string): VoiceAvatarConfig;
export function voiceAvatarFromStorage(raw: null): undefined;
export function voiceAvatarFromStorage(raw: string | null): VoiceAvatarConfig | undefined;
export function voiceAvatarFromStorage(raw: string | null): VoiceAvatarConfig | undefined {
  if (raw === null) return undefined;
  return VoiceAvatarConfigInput.parse(JSON.parse(raw));
}

export function voiceAvatarToStorage(config: VoiceAvatarConfig | null): string | null {
  return config === null ? null : JSON.stringify(config);
}
