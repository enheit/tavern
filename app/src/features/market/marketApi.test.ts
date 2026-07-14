import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer production-token" })),
  storeFromResponse: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authTransport", () => ({ authTransport: auth }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_API_URL", "https://tavern.example.workers.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production market icon loading", () => {
  it("fetches WebP bytes from the production API with desktop authentication", async () => {
    const response = new Response("animated-webp", {
      headers: { "content-type": "image/webp" },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const { fetchMarketIcon, marketIconUrl } = await import("./marketApi");
    const signal = new AbortController().signal;

    expect(marketIconUrl("server-1", "item-1")).toBe(
      "https://tavern.example.workers.dev/api/media/market-icons/server-1/item-1.webp",
    );
    const blob = await fetchMarketIcon("server-1", "item-1", signal);

    expect(blob.type).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tavern.example.workers.dev/api/media/market-icons/server-1/item-1.webp",
      expect.objectContaining({
        headers: { Authorization: "Bearer production-token" },
        credentials: "include",
        signal,
      }),
    );
    expect(auth.storeFromResponse).toHaveBeenCalledWith(response.headers);
  });

  it("rejects a non-WebP response instead of handing broken bytes to the image element", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("html", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const { fetchMarketIcon } = await import("./marketApi");

    await expect(
      fetchMarketIcon("server-1", "item-1", new AbortController().signal),
    ).rejects.toThrow("market icon response was not a bounded WebP image");
  });
});
