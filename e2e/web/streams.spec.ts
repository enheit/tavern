/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { PresetId } from "@tavern/shared";
import { expect, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-30/31/32/33 + G4 streams, PR hermeticity: the Worker runs with TAVERN_SFU_MOCK=1 (fixture-backed
// mock SFU, no media plane — PLAN §10). These specs therefore assert SIGNALING + STATE + LAYOUT + UX:
// stream.added fan-out (placeholder tiles), watch → exactly one pull (via the __tavernTestRtc.pullStates
// hook), the App-C canvas geometry via computed grid templates, focus → high-layer request
// (__tavernTestRtc.layerCalls), per-stream volume persistence, stop removes the tile, the FR-39 activity
// lifecycle, and the G4 share cap (seeded via the test-only /api/__test/seed-shares route). Remote-media
// assertions (real frames, preset drops, resolution rises) live in streams-realtime.spec.ts (@realtime).
// The __tavernTestRtc window type is declared (ambient) in voice.spec.ts.

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

// Seeds a fresh server with `count` members (the first is the admin/creator) and opens one browser
// context per member, each booted onto /s/:id?e2e=1. Mirrors voice.spec's harness so the streams specs
// share the exact multi-client topology.
async function seedRoom(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
  prefixes: string[],
): Promise<{ serverId: string; nickname: string; clients: Client[] }> {
  const target = baseURL ?? WEB_URL;
  const [adminPrefix, ...restPrefixes] = prefixes;
  if (adminPrefix === undefined) throw new Error("seedRoom needs at least one member");
  const admin = await api.createUser(adminPrefix);
  const server = await api.createServer(admin);
  const rest = await Promise.all(
    restPrefixes.map(async (prefix) => {
      const user = await api.createUser(prefix);
      await api.join(user, server.nickname);
      return user;
    }),
  );
  const users = [admin, ...rest];
  const clients = await Promise.all(
    users.map(async (user): Promise<Client> => {
      const context = await browser.newContext({
        baseURL: target,
        storageState: await user.request.storageState(),
      });
      const page = await context.newPage();
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      return { user, context, page };
    }),
  );
  // Every socket is live once each client sees the others in People (so stream broadcasts land).
  await Promise.all(
    clients.map(async (client) => {
      await client.page.getByTestId("tab-people").click();
      await Promise.all(
        clients
          .filter((other) => other.user.userId !== client.user.userId)
          .map((other) =>
            expect(client.page.getByTestId(`member-${other.user.userId}`)).toBeVisible(),
          ),
      );
      await client.page.getByTestId("tab-chat").click();
    }),
  );
  return { serverId: server.id, nickname: server.nickname, clients };
}

// Joins voice and waits until fully wired (self chip + publish/voice-pull connected) — identical to the
// voice.spec gate. A watcher must be in voice (a pull needs an SFU session.new, in-voice only, §7.1/G1).
async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        client.page.evaluate(() => {
          const rtc = window.__tavernTestRtc;
          return rtc ? { publish: rtc.publishState, pull: rtc.pullStates.voice ?? "none" } : null;
        }),
      { timeout: 20_000 },
    )
    .toEqual({ publish: "connected", pull: "connected" });
}

// The trackName the first screen share of a fresh publish session always gets (PublishSession's `n`
// counter starts at 1; the session is created on voice join, so it is 1 for the first share).
function screenTrackOf(user: SeededUser): string {
  return `screen:${user.userId}:1`;
}
function camTrackOf(user: SeededUser): string {
  return `cam:${user.userId}`;
}

// Starts a screen share via the split share button (web: clicking it starts immediately — the fake
// getDisplayMedia device stands in for the browser picker; no dialog). Optionally picks a preset first
// through the caret menu. Resolves once the sharer's own self tile appears (publish → stream.added).
async function startScreenShare(client: Client, preset?: PresetId): Promise<string> {
  if (preset !== undefined) {
    await client.page.getByTestId("controls-screen-preset").click();
    await client.page.getByTestId(`preset-option-${preset}`).click();
  }
  await client.page.getByTestId("controls-screen").click();
  const trackName = screenTrackOf(client.user);
  await expect(client.page.getByTestId(`stream-tile-${trackName}`)).toBeVisible({
    timeout: 20_000,
  });
  return trackName;
}

// Starts a webcam share (no dialog — the ControlsBar toggle). Resolves once the self cam tile appears.
async function startWebcam(client: Client): Promise<string> {
  await client.page.getByTestId("controls-cam").click();
  const trackName = camTrackOf(client.user);
  await expect(client.page.getByTestId(`stream-tile-${trackName}`)).toBeVisible({
    timeout: 20_000,
  });
  return trackName;
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

test.describe("FR-30/31/32/33 G4 streams (mock SFU)", () => {
  test("FR-30 share appears as placeholder until watched", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);

      // B (not in voice, not watching) sees A's placeholder tile: A's displayName + a Watch button.
      const tile = b.page.getByTestId(`stream-tile-${track}`);
      await expect(tile).toBeVisible({ timeout: 15_000 });
      await expect(tile).toHaveAttribute("data-watching", "false");
      await expect(b.page.getByTestId(`stream-watch-${track}`)).toBeVisible();
      await expect(tile.getByText(a.user.username, { exact: true })).toBeVisible();

      // Cost guardrail (FR-30): a non-watching client holds zero pulls for the stream.
      const pullForTrack = await b.page.evaluate(
        (tn) => window.__tavernTestRtc?.pullStates[tn],
        track,
      );
      expect(pullForTrack).toBeUndefined();
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-30 watch creates exactly one pull", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);
      await joinVoice(b); // a watcher must be in voice to open a pull session (G1/§7.1)

      await expect(b.page.getByTestId(`stream-tile-${track}`)).toBeVisible({ timeout: 15_000 });
      await b.page.getByTestId(`stream-watch-${track}`).click();

      // The dedicated watch pull reaches connected (mock SFU offer accepted; signaling complete).
      await expect
        .poll(() => b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track), {
          timeout: 20_000,
        })
        .toBe("connected");
      // The tile flips to the live view — the <video> element is present.
      await expect(b.page.getByTestId(`stream-video-${track}`)).toBeVisible();
      await expect(b.page.getByTestId(`stream-tile-${track}`)).toHaveAttribute(
        "data-watching",
        "true",
      );
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-32 two-tile geometry at 1280×720 → stacked [1,1]", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected a client");
    try {
      await a.page.setViewportSize({ width: 1280, height: 720 });
      await joinVoice(a);
      const screen = await startScreenShare(a);
      const cam = await startWebcam(a);
      await expect(a.page.getByTestId(`stream-tile-${screen}`)).toBeVisible();
      await expect(a.page.getByTestId(`stream-tile-${cam}`)).toBeVisible();

      // App-C tie-break at canvas 1280−240−320 × 720−40−56 (aspect < 16:9) ⇒ stacked: 2 rows of 1.
      await expectGridRows(a.page, [1, 1]);
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-32 two-tile geometry at 2600×1000 → side-by-side [2]", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected a client");
    try {
      await a.page.setViewportSize({ width: 2600, height: 1000 });
      await joinVoice(a);
      const screen = await startScreenShare(a);
      const cam = await startWebcam(a);
      await expect(a.page.getByTestId(`stream-tile-${screen}`)).toBeVisible();
      await expect(a.page.getByTestId(`stream-tile-${cam}`)).toBeVisible();

      // App-C tie-break at canvas 2600−240−320 × 1000−40−56 (aspect > 16:9) ⇒ side-by-side: 1 row of 2.
      await expectGridRows(a.page, [2]);
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-33 focus requests high layer", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);
      await joinVoice(b);
      await b.page.getByTestId(`stream-tile-${track}`).getByTestId(`stream-watch-${track}`).click();
      await expect
        .poll(() => b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track), {
          timeout: 20_000,
        })
        .toBe("connected");

      // A single click focuses → the watcher requests the high simulcast layer (FR-33).
      await b.page.getByTestId(`stream-tile-${track}`).click();
      await expect.poll(() => lastLayerRid(b.page), { timeout: 10_000 }).toBe("h");

      // Esc leaves focus → back to the low grid layer.
      await b.page.keyboard.press("Escape");
      await expect.poll(() => lastLayerRid(b.page), { timeout: 10_000 }).toBe("l");
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-31 stream volume persists", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);
      await joinVoice(b);
      await b.page.getByTestId(`stream-watch-${track}`).click();
      await expect(b.page.getByTestId(`stream-video-${track}`)).toBeVisible({ timeout: 20_000 });

      // The per-stream slider is keyed by the opaque userId:kind (survives trackName rotation).
      const streamKey = `${a.user.userId}:screen`;
      const slider = b.page.getByTestId(`stream-volume-${streamKey}`);
      // Hover the tile to reveal the overlay controls, focus the slider thumb, then drive it to 140%.
      // Base UI's slider binds Arrow keys (each = the 5% step) but not Home/End, so floor with ArrowLeft
      // then step up: 0 + 28·5% = 140%.
      await b.page.getByTestId(`stream-tile-${track}`).hover();
      await slider.locator('[data-slot="slider-thumb"]').click();
      await pressKeyN(b.page, "ArrowLeft", 40);
      await pressKeyN(b.page, "ArrowRight", 28);
      await expect.poll(() => readStreamVolume(b.page, streamKey)).toBe(1.4);

      // Persisted (settings.volumes.streams) → survives a fresh boot; the slider re-reads 140%.
      await b.page.goto(`/?e2e=1`);
      await expect(b.page).toHaveURL(new RegExp(`/s/${serverId}$`));
      await expect(b.page.getByTestId("controls-bar")).toBeVisible();
      await expect.poll(() => readStreamVolume(b.page, streamKey)).toBe(1.4);
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-30 stop removes tile", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);
      await joinVoice(b);
      await b.page.getByTestId(`stream-watch-${track}`).click();
      await expect
        .poll(() => b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track), {
          timeout: 20_000,
        })
        .toBe("connected");

      // A stops sharing (ControlsBar toggle) → stream.removed → B's tile is gone + the pull is cleared.
      await a.page.getByTestId("controls-screen").click();
      await expect(b.page.getByTestId(`stream-tile-${track}`)).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(() => b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track))
        .toBeUndefined();
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-39 activity records stream lifecycle", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected a client");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);
      await a.page.getByTestId("controls-screen").click();
      await expect(a.page.getByTestId(`stream-tile-${track}`)).toHaveCount(0, { timeout: 15_000 });

      // The Activity tab surfaces the FR-39 stream.start + stream.stop entries for A.
      await a.page.getByTestId("tab-activity").click();
      await expect(a.page.locator('[data-activity-type="stream.start"]')).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(a.page.locator('[data-activity-type="stream.stop"]')).toHaveCount(1, {
        timeout: 10_000,
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("G4 share cap rejects the fifth share", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected a client");
    try {
      await joinVoice(a);
      // Seed the server at the concurrent-share cap (LIMITS.maxConcurrentScreenShares = 4) via the
      // test-only route, then A's own share is the rejected 5th.
      const seed = await a.user.request.post("/api/__test/seed-shares", {
        data: { serverId, count: 4 },
      });
      expect(seed.ok()).toBe(true);
      expect(await seed.json()).toEqual({ screens: 4 });

      await a.page.getByTestId("controls-screen").click();

      // The publish is rejected with error.share_cap → an i18n toast; no tile appears.
      await expect(a.page.getByText("Too many screens are being shared")).toBeVisible({
        timeout: 15_000,
      });
      await expect(a.page.getByTestId(`stream-tile-${screenTrackOf(a.user)}`)).toHaveCount(0);
    } finally {
      await closeClients(clients);
    }
  });
});

// ---- helpers reading the DOM / test hooks

// Asserts the canvas grid rows match the expected per-row column counts (App-C layout outcome). Each
// `canvas-row-{r}` is a CSS grid whose resolved gridTemplateColumns has one track per tile in that row.
async function expectGridRows(page: Page, expected: number[]): Promise<void> {
  await Promise.all(
    expected.map(async (cols, r) => {
      const row = page.getByTestId(`canvas-row-${r}`);
      await expect(row).toBeVisible();
      await expect
        .poll(() =>
          row.evaluate(
            (el) =>
              getComputedStyle(el)
                .gridTemplateColumns.split(" ")
                .filter((t) => t.length > 0).length,
          ),
        )
        .toBe(cols);
    }),
  );
  await expect(page.getByTestId(`canvas-row-${expected.length}`)).toHaveCount(0);
}

// Presses a key `n` times in sequence (no await-in-loop lint escape hatch; a reduce chain).
async function pressKeyN(page: Page, key: string, n: number): Promise<void> {
  await Array.from({ length: n }).reduce<Promise<void>>(
    (p) => p.then(() => page.keyboard.press(key)),
    Promise.resolve(),
  );
}

async function lastLayerRid(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const calls = window.__tavernTestRtc?.layerCalls ?? [];
    return calls.at(-1)?.rid ?? null;
  });
}

async function readStreamVolume(page: Page, streamKey: string): Promise<number | undefined> {
  // The persisted gain (0..2) under settings.volumes.v1 → streams[userId:kind] — the slider's source
  // of truth (§5.4 VolumesV1). Traversed without an `as`-cast (§9.1) via Object.entries.
  return page.evaluate((key) => {
    // Defined inside page.evaluate (serialized to the browser) — it cannot be hoisted to module scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page's browser context
    const pick = (obj: unknown, k: string): unknown => {
      if (typeof obj !== "object" || obj === null) return undefined;
      for (const [name, value] of Object.entries(obj)) if (name === k) return value;
      return undefined;
    };
    const raw = localStorage.getItem("settings.volumes.v1");
    if (raw === null) return undefined;
    const gain = pick(pick(JSON.parse(raw), "streams"), key);
    return typeof gain === "number" ? gain : undefined;
  }, streamKey);
}
