import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "@tavern/shared";

// JoinOrCreatePage navigates via react-router's useNavigate — mock it to a spy so the page can be
// exercised without a router. useServers is REAL; its two seams are mocked: apiClient (the POST
// transport) and wsClient (the socket opened on success). The servers store + RHF + zod are real.
const navigateSpy = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigateSpy }));
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
  return { ApiError, apiClient: { post: vi.fn() } };
});
vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

import { ApiError, apiClient } from "@/lib/apiClient";
import { m } from "@/paraglide/messages.js";
import { JoinOrCreatePage } from "@/features/servers/JoinOrCreatePage";
import { useServersStore } from "@/stores/servers";

function summary(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: crypto.randomUUID(),
    nickname: "my-cave",
    adminUserId: crypto.randomUUID(),
    hasPassword: true,
    createdAt: 1,
    joinedAt: 1,
    ...over,
  };
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(<JoinOrCreatePage />, { wrapper });
}

// Open the create dialog by clicking its muted link trigger; wait for the portaled content.
async function openCreate(): Promise<void> {
  fireEvent.click(screen.getByTestId("create-open"));
  await screen.findByTestId("create-dialog");
}

beforeEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FR-08 join-or-create page", () => {
  it("renders the join card and create link; create dialog is not mounted initially", () => {
    renderPage();

    expect(screen.getByTestId("page-join")).not.toBeNull();
    expect(screen.getByTestId("join-nickname")).not.toBeNull();
    expect(screen.getByTestId("join-password")).not.toBeNull();
    expect(screen.getByTestId("join-submit")).not.toBeNull();
    expect(screen.getByTestId("create-open")).not.toBeNull();
    expect(screen.queryByTestId("create-dialog")).toBeNull();
  });

  it("clicking the create link opens the dialog with the create form fields", async () => {
    renderPage();
    await openCreate();

    expect(screen.getByTestId("create-nickname")).not.toBeNull();
    expect(screen.getByTestId("create-password")).not.toBeNull();
    expect(screen.getByTestId("create-code")).not.toBeNull();
    expect(screen.getByTestId("create-submit")).not.toBeNull();
  });

  it("empty create submit shows all three field errors and does not POST", async () => {
    renderPage();
    await openCreate();

    fireEvent.click(screen.getByTestId("create-submit"));

    await screen.findByTestId("create-nickname-error");
    expect(screen.getByTestId("create-nickname-error").textContent).toBe(
      m.error_nickname_invalid(),
    );
    expect(screen.getByTestId("create-password-error").textContent).toBe(
      m.servers_create_password_short(),
    );
    expect(screen.getByTestId("create-code-error").textContent).toBe(
      m.servers_create_code_required(),
    );
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("valid create POSTs {nickname,password,code} and navigates to /s/<id>", async () => {
    const created = summary({ nickname: "my-cave" });
    vi.mocked(apiClient.post).mockResolvedValue(created);
    renderPage();
    await openCreate();

    fireEvent.change(screen.getByTestId("create-nickname"), { target: { value: "my-cave" } });
    fireEvent.change(screen.getByTestId("create-password"), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByTestId("create-code"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("create-submit"));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith("/api/servers", expect.anything(), {
        nickname: "my-cave",
        password: "hunter2",
        code: "abc",
      }),
    );
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith(`/s/${created.id}`));
    expect(useServersStore.getState().servers).toContainEqual(created);
  });

  it("403 invalid_code renders the form-level create error", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new ApiError("invalid_code", 403));
    renderPage();
    await openCreate();

    fireEvent.change(screen.getByTestId("create-nickname"), { target: { value: "my-cave" } });
    fireEvent.change(screen.getByTestId("create-password"), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByTestId("create-code"), { target: { value: "used-code" } });
    fireEvent.click(screen.getByTestId("create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("create-error").textContent).toBe(m.error_invalid_code()),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
