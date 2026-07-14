import type { UserProfile } from "@tavern/shared";
import { create } from "zustand";

// The account session (FR-43). `booting` is the pre-boot-gate state; the boot machine transitions
// it to `unauthed` or `authed` (§9.9 selectors).
type SessionStatus = "booting" | "unauthed" | "authed";

interface SessionState {
  status: SessionStatus;
  profile: UserProfile | null;
  // Avatar objects use a stable per-user path. Bump this locally after every successful upload so
  // avatar surfaces request the replacement bytes without changing the backend profile contract.
  avatarRevision: number;
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
  avatarRevision: 0,
  setBooting: () => set({ status: "booting", profile: null, avatarRevision: 0 }),
  setUnauthed: () => set({ status: "unauthed", profile: null, avatarRevision: 0 }),
  setAuthed: (profile) => set({ status: "authed", profile }),
  patchProfile: (patch) =>
    set((s) =>
      s.profile === null
        ? s
        : {
            profile: { ...s.profile, ...patch },
            avatarRevision: patch.avatarKey === undefined ? s.avatarRevision : s.avatarRevision + 1,
          },
    ),
}));
