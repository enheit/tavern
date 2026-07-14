// The selectable user-name colors (FR-04). Deliberately NO gray/neutral swatches: gray reads as
// "unassigned/placeholder", so it is neither offered in the picker nor auto-assigned. New users get
// a random entry from this palette on registration (see worker/src/auth.ts), and the profile editor
// renders exactly these as swatches (a free hex input still covers everything else).
export const USER_COLORS = [
  "#f87171", // red
  "#fb923c", // orange
  "#facc15", // yellow
  "#4ade80", // green
  "#34d399", // emerald
  "#22d3ee", // cyan
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#c084fc", // purple
  "#f472b6", // pink
] as const;

// Voice avatars keep the bright profile palette and add neutrals plus deeper clothing shades. This
// is deliberately separate from USER_COLORS: black, gray, and white work well as clothing but read
// as unassigned or low-contrast when used for names and presence indicators.
export const VOICE_AVATAR_OUTFIT_COLORS = [
  ...USER_COLORS,
  "#18181b", // black
  "#52525b", // gray
  "#e4e4e7", // white
  "#7f1d1d", // burgundy
  "#92400e", // brown
  "#166534", // forest
  "#0f766e", // teal
  "#1e3a8a", // navy
  "#6b21a8", // plum
  "#be185d", // berry
] as const;

// Random palette color — used as the better-auth `color` field default so every new user starts with
// a distinct, non-gray name color instead of the old shared gray placeholder.
export function randomUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] as string;
}
