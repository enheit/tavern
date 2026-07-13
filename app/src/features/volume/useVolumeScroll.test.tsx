import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { volumeHudStore } from "./hudStore";
import { useVolumeScroll, type VolumeScrollOptions } from "./useVolumeScroll";

// Drives the shared FR-20/31 volume-scroll hook against a plain div — the exact gesture the voice
// voice member chips and watched stream tiles both delegate to.
function Harness({ opts }: { opts: VolumeScrollOptions }) {
  const { ref, percent } = useVolumeScroll<HTMLDivElement>(opts);
  return (
    <div ref={ref} data-testid="target">
      {percent === null ? "idle" : `${percent}%`}
    </div>
  );
}

// A live gain cell + spies mirroring a real target (settings.volumes.users[id]).
function makeOpts(over: Partial<VolumeScrollOptions> = {}): {
  opts: VolumeScrollOptions;
  write: ReturnType<typeof vi.fn>;
  get: () => number;
} {
  let gain = 1;
  const write = vi.fn((g: number) => {
    gain = g;
  });
  const opts: VolumeScrollOptions = {
    enabled: true,
    read: () => gain,
    write,
    meta: () => ({ key: "u1", label: "Alice", color: "#abcdef" }),
    ...over,
  };
  return { opts, write, get: () => gain };
}

beforeEach(() => {
  volumeHudStore.setState({ current: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FR-20/31 volume scroll gesture", () => {
  it("scroll up raises gain by 5% and scroll down lowers it, accumulating", () => {
    const { opts, write, get } = makeOpts();
    render(<Harness opts={opts} />);
    const el = screen.getByTestId("target");

    fireEvent.wheel(el, { deltaY: -100 });
    expect(write).toHaveBeenLastCalledWith(1.05);
    expect(get()).toBe(1.05);

    fireEvent.wheel(el, { deltaY: -100 });
    expect(write).toHaveBeenLastCalledWith(1.1);

    fireEvent.wheel(el, { deltaY: 120 });
    expect(write).toHaveBeenLastCalledWith(1.05);
  });

  it("clamps to the 0%–200% boundaries", () => {
    const boost = makeOpts();
    boost.write.mockImplementation(() => undefined); // keep read pinned near the ceiling
    boost.opts.read = () => 1.98;
    render(<Harness opts={boost.opts} />);
    fireEvent.wheel(screen.getByTestId("target"), { deltaY: -100 });
    expect(boost.write).toHaveBeenLastCalledWith(2);

    cleanup();

    const cut = makeOpts();
    cut.opts.read = () => 0.02;
    render(<Harness opts={cut.opts} />);
    fireEvent.wheel(screen.getByTestId("target"), { deltaY: 100 });
    expect(cut.write).toHaveBeenLastCalledWith(0);
  });

  it("middle-click resets the target to 0%", () => {
    const { opts, write } = makeOpts();
    render(<Harness opts={opts} />);
    const el = screen.getByTestId("target");
    act(() => {
      el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    });
    expect(write).toHaveBeenLastCalledWith(0);
  });

  it("pushes the target + percent to the center HUD store on each change", () => {
    const { opts } = makeOpts();
    render(<Harness opts={opts} />);
    fireEvent.wheel(screen.getByTestId("target"), { deltaY: -100 });
    const hud = volumeHudStore.getState().current;
    expect(hud).toMatchObject({ key: "u1", label: "Alice", color: "#abcdef", percent: 105 });
  });

  it("ignores horizontal scroll so a filmstrip still scrolls sideways", () => {
    const { opts, write } = makeOpts();
    render(<Harness opts={opts} />);
    fireEvent.wheel(screen.getByTestId("target"), { deltaX: -100, deltaY: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(volumeHudStore.getState().current).toBeNull();
  });

  it("is inert when disabled (self chip / audioless tile)", () => {
    const { opts, write } = makeOpts({ enabled: false });
    render(<Harness opts={opts} />);
    const el = screen.getByTestId("target");
    fireEvent.wheel(el, { deltaY: -100 });
    act(() => {
      el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("shows the inline percent then clears it after the idle delay", () => {
    vi.useFakeTimers();
    const { opts } = makeOpts();
    render(<Harness opts={opts} />);
    const el = screen.getByTestId("target");
    fireEvent.wheel(el, { deltaY: -100 });
    expect(el.textContent).toBe("105%");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(el.textContent).toBe("idle");
  });
});
