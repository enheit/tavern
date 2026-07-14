import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sound } from "@tavern/shared";
import { SoundboardPanel } from "@/features/soundboard/SoundboardPanel";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";

const SERVER = "srv-1";

// A controllable WS connection + a stub voice controller. useSounds + the panel reach the socket via
// connectRoom and the graph via getVoiceController; both are mocked so the test drives them directly.
const { fakeConn, fakeController } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(m: unknown) => void>>();
  return {
    fakeConn: {
      sent: [] as unknown[],
      status: "open" as const,
      send(msg: unknown): void {
        this.sent.push(msg);
      },
      on(t: string, cb: (m: unknown) => void): () => void {
        const set = listeners.get(t) ?? new Set<(m: unknown) => void>();
        set.add(cb);
        listeners.set(t, set);
        return () => {
          set.delete(cb);
        };
      },
      emit(m: { t: string } & Record<string, unknown>): void {
        for (const cb of listeners.get(m.t) ?? []) cb(m);
      },
      close(): void {
        /* no-op */
      },
    },
    fakeController: {
      playSoundboard: vi.fn(async () => undefined),
      previewSoundboard: vi.fn(async () => undefined),
      previewSoundFile: vi.fn(async () => undefined),
      stopSoundboardPreview: vi.fn(),
      setSoundboardGain: vi.fn(),
    },
  };
});

vi.mock("@/lib/wsClient", () => ({
  connectRoom: () => fakeConn,
  closeAllRooms: () => undefined,
  WsNotOpenError: class extends Error {},
}));
vi.mock("@/features/voice/voiceController", () => ({
  getVoiceController: () => fakeController,
}));

function sound(id: string, name: string, playCount: number): Sound {
  return {
    id,
    name,
    emoji: "🔊",
    gain: 1,
    sourceFileName: `${name}.mp3`,
    uploaderId: "11111111-1111-1111-1111-111111111111",
    durationMs: 1000,
    trimStartMs: 0,
    trimEndMs: 1000,
    createdAt: 1,
    playCount,
  };
}

function renderPanel(sounds: Sound[]): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  queryClient.setQueryData(["sounds", SERVER], {
    pages: [{ sounds, hasMore: false }],
    pageParams: [0],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SoundboardPanel serverId={SERVER} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
  useMediaStore.setState({ voiceStatus: "idle", inVoiceServerId: null });
  fakeConn.sent.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-37/FR-38 panel", () => {
  it("click sends sound.play only while joined to this server", () => {
    useMediaStore.setState({ voiceStatus: "joined", inVoiceServerId: SERVER });
    renderPanel([sound("s1", "beep", 0)]);
    fireEvent.click(screen.getByTestId("sound-s1"));
    expect(fakeConn.sent).toContainEqual({ t: "sound.play", soundId: "s1" });
    expect(fakeController.previewSoundboard).not.toHaveBeenCalled();
  });

  it("click outside voice previews locally without sending a play frame", async () => {
    const selected = sound("s1", "beep", 7);
    renderPanel([selected]);
    fireEvent.click(screen.getByTestId("sound-s1"));

    await waitFor(() =>
      expect(fakeController.previewSoundboard).toHaveBeenCalledWith(SERVER, selected),
    );
    expect(fakeConn.sent).toEqual([]);
    expect(screen.getByTestId("sound-plays-s1").textContent).toBe("7");
  });

  it("ignores repeated clicks of one preview while allowing a different sound to overlap", async () => {
    const first = sound("s1", "first", 0);
    const second = sound("s2", "second", 0);
    renderPanel([first, second]);

    fireEvent.click(screen.getByTestId("sound-s1"));
    fireEvent.click(screen.getByTestId("sound-s1"));
    fireEvent.click(screen.getByTestId("sound-s1"));
    fireEvent.click(screen.getByTestId("sound-s2"));

    await waitFor(() => expect(fakeController.previewSoundboard).toHaveBeenCalledTimes(2));
    expect(fakeController.previewSoundboard).toHaveBeenNthCalledWith(1, SERVER, first);
    expect(fakeController.previewSoundboard).toHaveBeenNthCalledWith(2, SERVER, second);
    expect(screen.getByTestId("sound-s1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("sound-s2")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("sound-stop-s1"));
    expect(fakeController.stopSoundboardPreview).toHaveBeenCalledWith("s1");
    expect(screen.getByTestId("sound-s2")).toHaveProperty("disabled", true);
  });

  it("sound.played bumps badge without reordering", async () => {
    // s1 (5 plays) listed before s2 (3 plays); a play of s2 bumps its badge but must NOT resort.
    renderPanel([sound("s1", "alpha", 5), sound("s2", "bravo", 3)]);

    act(() => {
      fakeConn.emit({
        t: "sound.played",
        soundId: "s2",
        byUserId: "u2",
        at: Date.now(),
        trimStartMs: 0,
        trimEndMs: 1000,
        gain: 1,
      });
    });

    await waitFor(() => expect(screen.getByTestId("sound-plays-s2").textContent).toBe("4"));
    // s1's badge is unchanged and it still precedes s2 in the DOM (no reorder on sound.played).
    expect(screen.getByTestId("sound-plays-s1").textContent).toBe("5");
    const s1 = screen.getByTestId("sound-s1");
    const s2 = screen.getByTestId("sound-s2");
    expect(s1.compareDocumentPosition(s2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows timed progress and sends a synchronized stop for an active sound", async () => {
    useMediaStore.setState({ voiceStatus: "joined", inVoiceServerId: SERVER });
    renderPanel([sound("s1", "beep", 0)]);
    act(() => {
      fakeConn.emit({
        t: "sound.played",
        soundId: "s1",
        byUserId: "u2",
        at: Date.now(),
        trimStartMs: 100,
        trimEndMs: 2100,
        gain: 1,
      });
    });

    const tile = screen.getByTestId("sound-s1").parentElement;
    expect(tile?.getAttribute("data-playing")).toBe("true");
    const progress = tile?.querySelector("rect");
    expect(progress?.getAttribute("style")).toContain("2000ms");
    fireEvent.click(screen.getByTestId("sound-stop-s1"));
    expect(fakeConn.sent).toContainEqual({ t: "sound.stop", soundId: "s1" });
  });

  it("mutes without discarding the selected soundboard volume", () => {
    renderPanel([]);
    fireEvent.click(screen.getByTestId("soundboard-mute"));

    expect(useSettingsStore.getState().volumes).toMatchObject({
      soundboard: 1,
      soundboardMuted: true,
    });
    expect(fakeController.setSoundboardGain).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("soundboard-mute").getAttribute("aria-pressed")).toBe("true");
  });

  it("volume slider calls setSoundboardGain and persists to settings.volumes.v1", () => {
    renderPanel([]);
    const slider = screen.getByTestId("soundboard-volume");
    // Base UI renders the a11y control as a nested <input type="range">; drive it directly (its role
    // is not surfaced when visually hidden). onChange → onValueChange → the panel's volume handler.
    const input = slider.querySelector<HTMLInputElement>('input[type="range"]');
    if (input === null) throw new Error("slider input not found");
    fireEvent.change(input, { target: { value: "150" } });

    expect(fakeController.setSoundboardGain).toHaveBeenCalledWith(1.5);
    const stored = JSON.parse(localStorage.getItem("settings.volumes.v1") ?? "{}") as {
      soundboard: number;
    };
    expect(stored.soundboard).toBe(1.5);
  });
});
