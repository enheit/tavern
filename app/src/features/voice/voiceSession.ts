// Refresh auto-resume: the per-tab voice-session snapshot. sessionStorage on purpose — it survives
// a reload but dies with the tab, so a NEW tab never auto-joins the call (localStorage would).
// Written by the voiceController (join/leave/mute/deafen) + WebcamController (camOn); consumed once
// per page load by voiceResume.ts after boot `ready`.
export const VOICE_SESSION_KEY = "tavern.voiceSession.v1";

export interface VoiceSessionV1 {
  serverId: string;
  // The user's INTENT flags (userMuted, deafened) — not effectiveMuted; the restore path replays
  // them through setDeafened/setMuted like the WS-reconnect path does.
  muted: boolean;
  deafened: boolean;
  camOn: boolean;
}

export function loadVoiceSession(): VoiceSessionV1 | null {
  try {
    const raw = sessionStorage.getItem(VOICE_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.serverId !== "string") return null;
    return {
      serverId: rec.serverId,
      muted: rec.muted === true,
      deafened: rec.deafened === true,
      camOn: rec.camOn === true,
    };
  } catch {
    // sessionStorage unavailable (privacy mode) or corrupt blob — no resume, the call still works.
    return null;
  }
}

export function saveVoiceSession(session: VoiceSessionV1): void {
  try {
    sessionStorage.setItem(VOICE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // sessionStorage unavailable — resume is best-effort only.
  }
}

// Patch the stored session (mute/deafen/cam toggles). A missing blob means not in voice → no-op,
// which makes the webcam/controller call sites safe to run unconditionally.
export function updateVoiceSession(patch: Partial<Omit<VoiceSessionV1, "serverId">>): void {
  const current = loadVoiceSession();
  if (current === null) return;
  saveVoiceSession({ ...current, ...patch });
}

export function clearVoiceSession(): void {
  try {
    sessionStorage.removeItem(VOICE_SESSION_KEY);
  } catch {
    // sessionStorage unavailable — nothing was stored anyway.
  }
}
