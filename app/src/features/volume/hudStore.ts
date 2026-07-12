import { createStore } from "zustand/vanilla";

// Per-user / per-stream volume-scroll feedback (FR-20/31). Scrolling on a voice nickname or a watched
// stream tile adjusts THAT target's local gain (0–200%, default 100%). The gesture drives a single
// center-screen HUD — a vanilla zustand store so the overlay (mounted once in AppShell) is the only
// subscriber and any component can push without prop-drilling. `seq` bumps on every push so the overlay
// restarts its fade-out timer even when the same target is scrolled repeatedly.
export interface VolumeHudPayload {
  // Stable id of the target (userId for a voice member, `${userId}:${kind}` for a stream). Only used
  // to let the overlay tell repeated same-target updates from a switch to a new target.
  key: string;
  // Human label shown in the HUD (member/stream-owner display name).
  label: string;
  // 0–200. 100 = unity; 0 = silenced (middle-click reset).
  percent: number;
  // Name color for the accent (voice members carry one); undefined falls back to the neutral accent.
  color?: string;
  // Monotonic tick — the overlay keys its fade timer on this so each scroll notch re-shows + re-fades.
  seq: number;
}

interface HudState {
  current: VolumeHudPayload | null;
}

export const volumeHudStore = createStore<HudState>(() => ({ current: null }));

let seq = 0;

// Show (or refresh) the volume HUD for one target. Called on every wheel notch / middle-click reset.
export function pushVolumeHud(p: Omit<VolumeHudPayload, "seq">): void {
  seq += 1;
  volumeHudStore.setState({ current: { ...p, seq } });
}
