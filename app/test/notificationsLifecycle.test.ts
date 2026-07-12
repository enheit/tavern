import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBootStore } from "@/features/boot/bootStore";
import { bindNotificationsToBootPhase } from "@/features/boot/notificationsLifecycle";

// FR-16: notifications must be live exactly while boot is at `ready`, and rebuilt on every return to
// it — the regression guard for the in-tab logout→login bug where a notification session stayed bound
// to sockets that closeAllRooms had already destroyed, so nothing was ever delivered again.

let unbind: (() => void) | null = null;

beforeEach(() => {
  useBootStore.setState({ phase: "loading" });
});

afterEach(() => {
  unbind?.();
  unbind = null;
});

describe("FR-16 notifications lifecycle vs boot phase", () => {
  it("inits on ready, tears down on leaving, and re-inits on return (logout→login)", () => {
    const teardown = vi.fn();
    const init = vi.fn(() => teardown);
    useBootStore.setState({ phase: "ready" });
    unbind = bindNotificationsToBootPhase(init);
    expect(init).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();

    useBootStore.setState({ phase: "unauthed" }); // logout
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);

    useBootStore.setState({ phase: "ready" }); // re-login, no page reload
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("does not init before ready", () => {
    const init = vi.fn(() => vi.fn());
    useBootStore.setState({ phase: "loadingMe" });
    unbind = bindNotificationsToBootPhase(init);
    expect(init).not.toHaveBeenCalled();
    useBootStore.setState({ phase: "connectingActive" });
    expect(init).not.toHaveBeenCalled();
    useBootStore.setState({ phase: "ready" });
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across repeated ready transitions", () => {
    const init = vi.fn(() => vi.fn());
    useBootStore.setState({ phase: "ready" });
    unbind = bindNotificationsToBootPhase(init);
    useBootStore.setState({ phase: "ready" }); // store notifies again on the same phase
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("unbind tears down a live session", () => {
    const teardown = vi.fn();
    useBootStore.setState({ phase: "ready" });
    unbind = bindNotificationsToBootPhase(() => teardown);
    unbind();
    unbind = null;
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
