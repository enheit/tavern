// Non-secret UI prefs (theme, later per-user volume). localStorage-backed:
// persists in the Tauri WKWebView AND works in the browser test harness with no
// Tauri runtime.
// ponytail: §1 names tauri-plugin-store for prefs; localStorage is the native,
// zero-dep, test-reachable equivalent. Swap the store plugin in behind these two
// functions at S4.2 if cross-webview durability ever matters.
export function getPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage disabled / private mode — prefs are best-effort
  }
}
