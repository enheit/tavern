// Shared app-quit intent, kept in its own dependency-free module so both window.ts (which reads it
// to decide hide-to-tray vs. real close) and tray.ts (which sets it on "Exit") can use it without
// importing each other.
let quitting = false;

export function isQuittingApp(): boolean {
  return quitting;
}

// Marks the app as genuinely quitting so the next window close is allowed through instead of being
// swallowed into a hide-to-tray. Wired to `before-quit` in index.ts, so every quit path — tray
// "Exit", Cmd+Q, and the auto-updater's quitAndInstall — is covered.
export function markQuitting(): void {
  quitting = true;
}
