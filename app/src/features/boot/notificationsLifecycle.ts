import { initNotifications } from "@/lib/notifications";
import { type BootPhase, useBootStore } from "./bootStore";

// FR-16 notification lifecycle. Notifications must be LIVE exactly while the boot machine is at
// `ready`, and must be rebuilt whenever it leaves and returns. The teardown-on-leave is load-bearing:
// an in-tab logout→login (reset → unauthed → restart → ready, with NO page reload, so nothing
// unmounts) recreates every room socket via connectRoom; a notification session still bound to the
// old, now-closed sockets would silently deliver nothing. Re-running initNotifications on each return
// to `ready` re-attaches its `chat.new` listeners to the fresh sockets. Mid-session socket reconnects
// keep the same RoomConnection instance and do NOT change the boot phase, so steady state never churns.
//
// `init` is injected (defaulting to the real initNotifications) purely so this contract is unit
// testable without standing up the whole app. Returns an unsubscribe that also tears down any live
// session — call it from the owning effect's cleanup.
export function bindNotificationsToBootPhase(
  init: () => () => void = initNotifications,
): () => void {
  let cleanup: (() => void) | null = null;
  const sync = (phase: BootPhase): void => {
    if (phase === "ready") {
      if (cleanup === null) cleanup = init();
    } else if (cleanup !== null) {
      cleanup();
      cleanup = null;
    }
  };
  sync(useBootStore.getState().phase);
  const unsubscribe = useBootStore.subscribe((state) => sync(state.phase));
  return () => {
    unsubscribe();
    cleanup?.();
    cleanup = null;
  };
}
