import { createStore } from "zustand/vanilla";

// Window attention has two deliberately separate signals:
// - `focused` is for attention-only work such as notifications and the local self-preview
//   (keyboard focus AND page visibility; suspending that preview never changes outgoing quality).
// - `visible` is for media policy. A Tavern window on a second monitor remains visible even when a
//   game owns keyboard focus, so media must not downshift merely because `focused` is false.
// Both values live in one store because the same DOM events can affect them, while consumers select
// the semantic signal they actually need.
interface FocusState {
  focused: boolean;
  visible: boolean;
}

function computeState(): FocusState {
  if (typeof document === "undefined") return { focused: true, visible: true };
  const visible = document.visibilityState === "visible";
  return { focused: document.hasFocus() && visible, visible };
}

export const focusStore = createStore<FocusState>(() => computeState());

function refresh(): void {
  focusStore.setState(computeState());
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
