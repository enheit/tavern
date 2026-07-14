import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamPreview } from "./useStreamPreview";

const auth = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })),
  storeFromResponse: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authTransport", () => ({ authTransport: auth }));

const PREVIEW_A = "123e4567-e89b-42d3-a456-426614174000";
const PREVIEW_B = "223e4567-e89b-42d3-a456-426614174000";

function previewResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "image/webp" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  let objectUrl = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:preview-${++objectUrl}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("idle stream preview loading", () => {
  it("uses the authenticated no-store member route", async () => {
    const fetchMock = vi.fn(async () => previewResponse("one"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useStreamPreview("server-1", { id: PREVIEW_A, version: "v1" }),
    );

    await waitFor(() => expect(result.current).toBe("blob:preview-1"));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/servers/server-1/stream-previews/${PREVIEW_A}`,
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
        credentials: "include",
        cache: "no-store",
      }),
    );
    expect(auth.storeFromResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps the decoded image during a version refresh and clears it for a new publication", async () => {
    let resolveSecond: ((response: Response) => void) | undefined;
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(previewResponse("one"))
      .mockImplementationOnce(() => second)
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ id, version }) => useStreamPreview("server-1", { id, version }),
      { initialProps: { id: PREVIEW_A, version: "v1" } },
    );
    await waitFor(() => expect(result.current).toBe("blob:preview-1"));

    rerender({ id: PREVIEW_A, version: "v2" });
    expect(result.current).toBe("blob:preview-1");
    if (resolveSecond === undefined) throw new Error("second preview request did not start");
    resolveSecond(previewResponse("two"));
    await waitFor(() => expect(result.current).toBe("blob:preview-2"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    rerender({ id: PREVIEW_B, version: "v1" });
    await waitFor(() => expect(result.current).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });
});
