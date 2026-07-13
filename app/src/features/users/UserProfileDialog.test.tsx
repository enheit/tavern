import type { Member, StatsResponse as StatsResponseType } from "@tavern/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
  apiClient: { get: (path: string, schema: unknown) => getMock(path, schema) },
}));

import { UserProfileName } from "@/features/users/UserProfileName";
import { useSessionStore } from "@/stores/session";

const SERVER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEMBER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SELF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const member: Member = {
  userId: MEMBER_ID,
  username: "alice_u",
  displayName: "Alice",
  color: "#8b5cf6",
  presence: "online",
  isAdmin: false,
  joinedAt: 1,
};

beforeEach(() => {
  getMock.mockReset();
  useSessionStore.setState({
    status: "authed",
    profile: { userId: SELF_ID, username: "self", displayName: "Self", color: "#ffffff" },
  });
});

afterEach(() => cleanup());

function renderName(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UserProfileName serverId={SERVER_ID} member={member} />
    </QueryClientProvider>,
  );
}

describe("user profile dialog", () => {
  it("opens from the underlined-on-hover nickname and shows that user's stats", async () => {
    const response: StatsResponseType = {
      perUser: [{ userId: MEMBER_ID, messages: 42, streamSeconds: 7_200 }],
      watchPairs: [{ viewerId: SELF_ID, streamerId: MEMBER_ID, seconds: 3_600 }],
    };
    getMock.mockResolvedValue(response);
    renderName();

    const trigger = screen.getByTestId(`user-profile-trigger-${MEMBER_ID}`);
    expect(trigger.className).toContain("hover:underline");
    fireEvent.click(trigger);

    expect(await screen.findByTestId("user-profile-dialog")).toBeDefined();
    expect(screen.getByTestId("user-profile-name").textContent).toBe("Alice");
    expect(screen.getByTestId("user-profile-username").textContent).toBe("@alice_u");
    await waitFor(() => expect(screen.getByTestId("user-profile-messages").textContent).toBe("42"));
    expect(screen.getByTestId("user-profile-streamed").textContent).toBe("2:00");
    expect(screen.getByTestId("user-profile-watched").textContent).toBe("1:00");
    expect(getMock).toHaveBeenCalledWith(`/api/servers/${SERVER_ID}/stats`, expect.anything());
  });

  it("falls back to the colored initial when the avatar cannot load", async () => {
    getMock.mockResolvedValue({ perUser: [], watchPairs: [] });
    renderName();
    fireEvent.click(screen.getByTestId(`user-profile-trigger-${MEMBER_ID}`));
    fireEvent.error(await screen.findByTestId(`profile-avatar-${MEMBER_ID}`));
    expect(screen.getByTestId(`profile-avatar-fallback-${MEMBER_ID}`).textContent).toBe("A");
  });
});
