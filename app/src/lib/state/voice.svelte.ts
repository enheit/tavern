// Placeholder voice state for the S3.1 panel. S4 wires the engine (voice_join,
// mute/deafen, RMS levels, per-user gain); here the toggles are local UI state
// only so the panel is interactive without media.
export class VoiceStore {
  channelId = $state<string | null>(null);
  muted = $state(false);
  deafened = $state(false);

  get inVoice(): boolean {
    return this.channelId !== null;
  }

  toggleMute(): void {
    this.muted = !this.muted;
  }

  toggleDeafen(): void {
    this.deafened = !this.deafened;
    // Deafen implies mic muted (§1); undeafen leaves mute as the user last set it.
    if (this.deafened) this.muted = true;
  }
}

export const voice = new VoiceStore();
