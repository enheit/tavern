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

// Random palette color — used as the better-auth `color` field default so every new user starts with
// a distinct, non-gray name color instead of the old shared gray placeholder.
export function randomUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] as string;
}
