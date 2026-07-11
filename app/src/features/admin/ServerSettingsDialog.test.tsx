import type { Member, ServerMessage } from "@tavern/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apiClient (PATCH transport) + sonner + authTransport are mocked seams; the stores + RHF + zod are
// real. The kick DELETE goes through the global fetch (204, no body), stubbed per test.
vi.mock("@/lib/apiClient", () => {
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  }
  return { ApiError, apiClient: { patch: vi.fn() } };
});
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/authTransport", () => ({
  authTransport: {
    getAuthHeaders: vi.fn(async () => ({})),
    storeFromResponse: vi.fn(async () => {}),
  },
}));

import { ApiError, apiClient } from "@/lib/apiClient";
import { m } from "@/paraglide/messages.js";
import { toast } from "sonner";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { ServerSettingsDialog } from "./ServerSettingsDialog";

const SID = "srv-1";
const ADMIN = "admin-1";

function member(userId: string, over: Partial<Member> = {}): Member {
  return {
    userId,
    username: "handle",
    displayName: "Member",
    color: "#8b5cf6",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
    ...over,
  };
}

function seed(members: Member[], adminUserId = ADMIN, nickname = "old-name"): void {
  const hello: Extract<ServerMessage, { t: "hello.ok" }> = {
    t: "hello.ok",
    status: "",
    self: { userId: adminUserId, username: "admin", displayName: "Admin", color: "#ffffff" },
    serverMeta: { id: SID, nickname, adminUserId },
    members,
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId: null,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
  };
  roomStore(SID).getState().apply(hello);
}

function setSelf(userId: string): void {
  useSessionStore
    .getState()
    .setAuthed({ userId, username: "self", displayName: "Self", color: "#ffffff" });
}

// Open the (self-gating) dialog by clicking its gear trigger; wait for the portaled content.
async function openDialog(): Promise<void> {
  fireEvent.click(screen.getByTestId("admin-settings-button"));
  await screen.findByTestId("admin-dialog");
}

beforeEach(() => {
  resetRoomStores();
  vi.clearAllMocks();
  useSessionStore.setState({ status: "authed", profile: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, headers: {}, json: async () => ({}) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FR-10 FR-11 FR-12 admin dialog", () => {
  it("gear button absent for non-admin", () => {
    seed([member(ADMIN, { isAdmin: true }), member("other")]);
    setSelf("other");
    render(<ServerSettingsDialog serverId={SID} />);
    expect(screen.queryByTestId("admin-settings-button")).toBeNull();
  });

  it("dialog renders three sections for admin", async () => {
    seed([member(ADMIN, { isAdmin: true })]);
    setSelf(ADMIN);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();
    expect(screen.getByTestId("admin-rename")).not.toBeNull();
    expect(screen.getByTestId("admin-password")).not.toBeNull();
    expect(screen.getByTestId("admin-members")).not.toBeNull();
  });

  it("rename rejects invalid nickname client-side", async () => {
    seed([member(ADMIN, { isAdmin: true })]);
    setSelf(ADMIN);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    // "ab" is < 3 chars → fails the shared serverNickname rule → the resolver blocks the submit.
    fireEvent.change(screen.getByTestId("admin-nickname-input"), { target: { value: "ab" } });
    fireEvent.click(screen.getByTestId("admin-rename-submit"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("rename shows inline error on nickname_taken", async () => {
    seed([member(ADMIN, { isAdmin: true })]);
    setSelf(ADMIN);
    vi.mocked(apiClient.patch).mockRejectedValue(new ApiError("nickname_taken", 409));
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    fireEvent.change(screen.getByTestId("admin-nickname-input"), { target: { value: "new-name" } });
    fireEvent.click(screen.getByTestId("admin-rename-submit"));

    await waitFor(() => screen.getByTestId("admin-nickname-error"));
    expect(screen.getByTestId("admin-nickname-error").textContent).toBe(m.admin_nickname_taken());
    expect(apiClient.patch).toHaveBeenCalledWith(`/api/servers/${SID}`, expect.anything(), {
      nickname: "new-name",
    });
  });

  it("rename success PATCHes and toasts", async () => {
    seed([member(ADMIN, { isAdmin: true })]);
    setSelf(ADMIN);
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    fireEvent.change(screen.getByTestId("admin-nickname-input"), { target: { value: "new-name" } });
    fireEvent.click(screen.getByTestId("admin-rename-submit"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/servers/${SID}`, expect.anything(), {
        nickname: "new-name",
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith(m.admin_renamed()));
  });

  it("password set PATCHes {password}", async () => {
    seed([member(ADMIN, { isAdmin: true })]);
    setSelf(ADMIN);
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    fireEvent.change(screen.getByTestId("admin-password-input"), { target: { value: "secret" } });
    fireEvent.click(screen.getByTestId("admin-password-set"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/servers/${SID}`, expect.anything(), {
        password: "secret",
      }),
    );
  });

  it("kick shows confirm with member name and DELETEs on confirm", async () => {
    seed([member(ADMIN, { isAdmin: true }), member("bob", { displayName: "Bob" })]);
    setSelf(ADMIN);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    fireEvent.click(screen.getByTestId("admin-kick-bob"));
    const confirm = await screen.findByTestId("kick-confirm");
    expect(within(confirm).getByTestId("kick-confirm-text").textContent).toBe(
      m.admin_kick_confirm({ name: "Bob" }),
    );

    fireEvent.click(screen.getByTestId("kick-confirm-action"));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain(`/api/servers/${SID}/members/bob`);
    expect(init?.method).toBe("DELETE");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(m.admin_kicked({ name: "Bob" })));
  });

  it("self row has no kick button", async () => {
    seed([member(ADMIN, { isAdmin: true }), member("bob", { displayName: "Bob" })]);
    setSelf(ADMIN);
    render(<ServerSettingsDialog serverId={SID} />);
    await openDialog();

    expect(screen.queryByTestId(`admin-kick-${ADMIN}`)).toBeNull();
    expect(screen.getByTestId("admin-kick-bob")).not.toBeNull();
  });
});
