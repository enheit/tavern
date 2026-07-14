// Node's Vitest worker exposes an incomplete experimental Web Storage placeholder. Install a faithful
// in-memory Storage boundary before application modules (including generated Paraglide) are imported.
const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.get(key) ?? null;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: storage,
});

// jsdom does not implement viewport intersection. The default observer stays idle; suites that need
// to drive intersections install their own controllable implementation.
class IdleIntersectionObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: IdleIntersectionObserver,
});

// Base UI's ScrollArea waits for Web Animations cleanup. jsdom has no implementation, so provide
// the standards-shaped empty result at the test boundary; browser behavior is covered by Playwright.
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});
