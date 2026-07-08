// Single funnel for engine events (§1: `engine://state|levels|stats`). Components
// subscribe via onEngineEvent; the Tauri event bus is bridged in only when running
// in the webview. Tests inject with emitEngineEvent (mockIPC covers commands only).
type Cb = (payload: unknown) => void;

const subs = new Map<string, Set<Cb>>();

export function onEngineEvent(name: string, cb: Cb): () => void {
  let set = subs.get(name);
  if (!set) subs.set(name, (set = new Set()));
  set.add(cb);

  let unlisten: (() => void) | undefined;
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen(name, (e) => cb(e.payload)).then((u) => {
        unlisten = u;
      }),
    );
  }

  return () => {
    set.delete(cb);
    unlisten?.();
  };
}

// Test-only (and future single-listener fan-out) injection.
export function emitEngineEvent(name: string, payload: unknown): void {
  subs.get(name)?.forEach((cb) => cb(payload));
}
