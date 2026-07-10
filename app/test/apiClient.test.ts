import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES, WsTicketResponse } from "@tavern/shared";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";

// The apiClient reads auth headers through authTransport; mock it so we can drive both the
// no-header (web) and bearer (desktop) cases without a real platform.
vi.mock("@/lib/authTransport", () => ({
  authTransport: {
    getAuthHeaders: vi.fn(async () => ({})),
    storeFromResponse: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  },
}));
import { authTransport } from "@/lib/authTransport";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  body: unknown;
}

function fakeResponse(init: FakeResponseInit): Response {
  // Test double for the fetch Response the apiClient consumes.
  return {
    ok: init.ok,
    status: init.status,
    headers: new Headers(),
    json: async () => init.body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(authTransport.getAuthHeaders).mockResolvedValue({});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("§9.8 apiClient", () => {
  it("throws ApiError('bad_message') when the success body fails schema validation", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, body: { wrong: 1 } }));
    await expect(apiClient.get("/api/x", WsTicketResponse)).rejects.toBeInstanceOf(ApiError);
    await expect(apiClient.get("/api/x", WsTicketResponse)).rejects.toMatchObject({
      code: "bad_message",
    });
  });

  it("maps a non-2xx { error } body to the typed ErrorCode and status", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ ok: false, status: 403, body: { error: "forbidden" } }),
    );
    await expect(apiClient.get("/api/x", WsTicketResponse)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("attaches the bearer header from authTransport (desktop)", async () => {
    vi.mocked(authTransport.getAuthHeaders).mockResolvedValue({ Authorization: "Bearer tok" });
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, body: { ticket: "tok" } }));
    await apiClient.get("/api/x", WsTicketResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });
});

describe("errorMessage", () => {
  it("returns a non-empty string for every ErrorCode (Record is exhaustive)", () => {
    for (const code of ERROR_CODES) {
      expect(errorMessage(code).length).toBeGreaterThan(0);
    }
  });
});
