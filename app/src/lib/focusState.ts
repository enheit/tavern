import { createStore } from "zustand/vanilla";

// FR-16 pinned focus definition: the window counts as "focused" iff the document has OS focus AND is
// visible. Exposed as a zustand-vanilla store so notification logic (and its tests) can read/observe
// `focused` without a live browser — the store is the single source, refreshed on the three DOM
// events that can change either input (window focus/blur, document visibilitychange).
interface FocusState {
  focused: boolean;
}

function computeFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus() && document.visibilityState === "visible";
}

export const focusStore = createStore<FocusState>(() => ({ focused: computeFocused() }));

function refresh(): void {
  focusStore.setState({ focused: computeFocused() });
}

// Guards against double-wiring (React StrictMode remounts / a second initNotifications call).
let wired = false;

// Subscribes the store to the pinned DOM events. Idempotent; returns an unsubscribe used on teardown.
export function initFocusTracking(): () => void {
  if (typeof window === "undefined" || wired) return () => undefined;
  wired = true;
  window.addEventListener("focus", refresh);
  window.addEventListener("blur", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    wired = false;
    window.removeEventListener("focus", refresh);
    window.removeEventListener("blur", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

export function isWindowFocused(): boolean {
  return focusStore.getState().focused;
}
