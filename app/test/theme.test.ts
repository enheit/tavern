import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MediaListener = (event: { matches: boolean }) => void;

// Test double for MediaQueryList: our code only reads `.matches` and (add|remove)EventListener.
function stubMatchMedia(initial: boolean): (matches: boolean) => void {
  const listeners = new Set<MediaListener>();
  const mql = {
    matches: initial,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, cb: MediaListener) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: MediaListener) => {
      listeners.delete(cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql as unknown as MediaQueryList),
  );
  return (matches: boolean) => {
    mql.matches = matches;
    for (const cb of listeners) cb({ matches });
  };
}

describe("FR-06 theme", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles the dark class light<->dark and persists to localStorage", async () => {
    const { applyTheme } = await import("@/stores/settings");
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("tavern.theme")).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("tavern.theme")).toBe("light");
  });

  it("system follows a mocked matchMedia change event", async () => {
    const emit = stubMatchMedia(false);
    const { applyTheme } = await import("@/stores/settings");

    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    emit(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Switching away from `system` unsubscribes: later OS changes must NOT re-toggle the class.
    applyTheme("light");
    emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("setTheme updates the store state and applies the theme", async () => {
    const { useSettingsStore } = await import("@/stores/settings");
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("the boot module applies the stored theme before React mounts", async () => {
    localStorage.setItem("tavern.theme", "dark");
    await import("@/theme-boot");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
