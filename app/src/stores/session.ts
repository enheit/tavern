import type { UserProfile } from "@tavern/shared";
import { create } from "zustand";

// The account session (FR-43). `booting` is the pre-boot-gate state; the boot machine transitions
// it to `unauthed` or `authed` (§9.9 selectors).
type SessionStatus = "booting" | "unauthed" | "authed";

interface SessionState {
  status: SessionStatus;
  profile: UserProfile | null;
  setBooting: () => void;
  setUnauthed: () => void;
  setAuthed: (profile: UserProfile) => void;
  // Merge fields into the current profile (e.g. avatarKey after an avatar upload) so surfaces that
  // read the profile — the header avatar — reflect the change without a full refetch. No-op if unauthed.
  patchProfile: (patch: Partial<UserProfile>) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: "booting",
  profile: null,
  setBooting: () => set({ status: "booting", profile: null }),
  setUnauthed: () => set({ status: "unauthed", profile: null }),
  setAuthed: (profile) => set({ status: "authed", profile }),
  patchProfile: (patch) =>
    set((s) => (s.profile === null ? s : { profile: { ...s.profile, ...patch } })),
}));
