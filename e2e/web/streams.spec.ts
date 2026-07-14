/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { PresetId } from "@tavern/shared";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-30/31/32/33 + G4 streams, PR hermeticity: the Worker runs with TAVERN_SFU_MOCK=1 (fixture-backed
// mock SFU, no media plane — PLAN §10). These specs therefore assert SIGNALING + STATE + LAYOUT + UX:
// stream.added fan-out (placeholder tiles), watch → exactly one pull (via the __tavernTestRtc.pullStates
// hook), the App-C canvas geometry via computed grid templates, always-high-layer pulls with no focus
// downswitch (__tavernTestRtc.pullCalls/layerCalls), per-stream volume persistence, stop removes the
// tile, the FR-39 activity
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
      await expect(page.getByTestId("app-shell")).toBeVisible();
      return { user, context, page };
    }),
  );
  // Every socket is live once each client sees the others on Dashboard (so broadcasts land).
  await Promise.all(
    clients.map(async (client) => {
      await Promise.all(
        clients
          .filter((other) => other.user.userId !== client.user.userId)
          .map((other) =>
            expect(client.page.getByTestId(`home-member-${other.user.userId}`)).toBeVisible(),
          ),
      );
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

// Opens the cross-platform pre-share quality dialog, optionally chooses a base preset, then starts
// fake display capture. Resolves once publish → stream.added renders the sharer's self tile.
async function startScreenShare(client: Client, preset?: PresetId): Promise<string> {
  await client.page.getByTestId("controls-screen").click();
  await expect(client.page.getByTestId("share-preset")).toBeVisible();
  if (preset !== undefined) {
    await client.page.getByTestId("share-preset").click();
    await client.page.getByTestId(`preset-option-${preset}`).click();
  }
  await client.page.getByTestId("share-start").click();
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

// Publishes through the same mock-SFU + DO reservation/commit path as PublishSession, but without
// waiting for mock ICE: the hermetic SFU deliberately has no media plane, so its PeerConnection can
// never become connected. Publisher capture/refresh is covered by the focused browser-unit tests;
// this helper keeps the e2e focused on the real preview API, broadcast, R2 read, and rendered tile.
async function publishMockScreen(
  client: Client,
  serverId: string,
): Promise<{
  trackName: string;
  previewId: string;
}> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });

  const session = await client.user.request.post(`/api/rtc/${serverId}/session`, {
    data: { mediaReadyVersion: 2 },
  });
  expect(session.status(), await session.text()).toBe(200);
  const sessionBody: unknown = await session.json();
  if (
    typeof sessionBody !== "object" ||
    sessionBody === null ||
    !("sessionId" in sessionBody) ||
    typeof sessionBody.sessionId !== "string"
  ) {
    throw new Error("mock publish session did not return a sessionId");
  }

  const trackName = screenTrackOf(client.user);
  const publish = await client.user.request.post(
    `/api/rtc/${serverId}/tracks?session=${sessionBody.sessionId}`,
    {
      data: {
        sessionDescription: {
          type: "offer",
          sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n",
        },
        tracks: [{ location: "local", mid: "0", trackName }],
      },
    },
  );
  expect(publish.status(), await publish.text()).toBe(200);
  const publishBody: unknown = await publish.json();
  if (
    typeof publishBody !== "object" ||
    publishBody === null ||
    !("publicationId" in publishBody) ||
    typeof publishBody.publicationId !== "string"
  ) {
    throw new Error("mock screen publish did not return a publicationId");
  }

  const confirm = await client.user.request.post(
    `/api/rtc/${serverId}/tracks/ready?session=${sessionBody.sessionId}`,
    { data: { publicationId: publishBody.publicationId } },
  );
  expect(confirm.status(), await confirm.text()).toBe(200);
  return { trackName, previewId: publishBody.publicationId };
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

test.describe("FR-30/31/32/33 G4 streams (mock SFU)", () => {
  test("web chooses capture ceiling and data budget before sharing", async ({
    browser,
    baseURL,
    api,
  }) => {
    const { clients } = await seedRoom(browser, baseURL, api, ["quality"]);
    const client = clients[0];
    if (!client) throw new Error("expected quality client");
    try {
      await joinVoice(client);
      await client.page.getByTestId("controls-screen").click();
      await expect(client.page.getByTestId("share-preset")).toBeVisible();
      await expect(client.page.getByTestId("share-data-tier")).toContainText("100%");

      await client.page.getByTestId("share-preset").click();
      await client.page.getByTestId("preset-option-1080p60").click();
      await client.page.getByTestId("share-data-tier").click();
      await client.page.getByRole("option", { name: "50%" }).click();
      await client.page.getByTestId("share-start").click();

      await expect(
        client.page.getByTestId(`stream-tile-${screenTrackOf(client.user)}`),
      ).toBeVisible({
        timeout: 20_000,
      });
      await expect(client.page.getByTestId("share-fps-60")).toHaveAttribute("aria-pressed", "true");
      await expect(client.page.getByTestId("share-data-50")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-30 share appears as a shaded preview until watched", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      const { trackName: track, previewId } = await publishMockScreen(a, serverId);
      const upload = await a.page.evaluate(
        async ({ targetServerId, targetPreviewId }) => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext("2d");
          if (context === null) throw new Error("2D canvas is unavailable");
          const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, "#7048e8");
          gradient.addColorStop(0.55, "#1971c2");
          gradient.addColorStop(1, "#0b7285");
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "rgba(255, 255, 255, 0.92)";
          context.font = "600 44px system-ui";
          context.fillText("Shared screen", 150, 196);
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (result) =>
                result === null ? reject(new Error("WebP encode failed")) : resolve(result),
              "image/webp",
              0.6,
            );
          });
          const response = await fetch(
            `/api/servers/${targetServerId}/stream-previews/${targetPreviewId}`,
            {
              method: "PUT",
              headers: { "content-type": "image/webp" },
              body: blob,
            },
          );
          return { status: response.status, body: await response.text() };
        },
        { targetServerId: serverId, targetPreviewId: previewId },
      );
      expect(upload.status, upload.body).toBe(200);

      // B (not in voice, not watching) sees A's placeholder tile: A's displayName + a Watch button.
      const tile = b.page.getByTestId(`stream-tile-${track}`);
      await expect(tile).toBeVisible({ timeout: 15_000 });
      await expect(tile).toHaveAttribute("data-watching", "false");
      await expect(b.page.getByTestId(`stream-watch-${track}`)).toBeVisible();
      await expect(tile.getByText(a.user.username, { exact: true })).toBeVisible();
      const preview = b.page.getByTestId(`stream-preview-image-${track}`);
      await expect(preview).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          preview.evaluate((element) =>
            element instanceof HTMLImageElement ? element.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
      expect(await preview.evaluate((element) => getComputedStyle(element).filter)).toContain(
        "blur",
      );
      await expect(b.page.getByText("Preview", { exact: true })).toBeVisible();
      const shadeColor = await b.page
        .getByTestId(`stream-preview-shade-${track}`)
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(shadeColor).toMatch(/(?:\/|,)\s*0\.55\)$/);
      await tile.screenshot({
        path: testInfo.outputPath("shaded-stream-preview.png"),
        animations: "disabled",
      });

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

  test("FR-28 explicit stream-audio source publishes a screenAudio companion the watcher pulls", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      // Pick an explicit stream-audio device in Settings → Voice — the e2e opt-in for the FR-28
      // system-audio fallback (auto-mode is skipped under the harness; media/capture.ts §10 note).
      // The fake-device flag provides deterministic audioinputs to choose from.
      await a.page.getByTestId("sidebar-settings-button").click();
      await expect(a.page.getByTestId("settings-dialog")).toBeVisible();
      await a.page.getByTestId("settings-tab-voice").click();
      await a.page.getByTestId("settings-voice-stream-audio").click();
      await a.page
        .locator(
          '[data-testid^="stream-audio-"]:not([data-testid="stream-audio-auto"]):not([data-testid="stream-audio-off"])',
        )
        .first()
        .click();
      await a.page.keyboard.press("Escape");
      await expect(a.page.getByTestId("settings-dialog")).toBeHidden();

      const track = await startScreenShare(a);
      const audioTrack = `screenAudio:${a.user.userId}:1`;
      await joinVoice(b);
      await expect(b.page.getByTestId(`stream-tile-${track}`)).toBeVisible({ timeout: 15_000 });
      await b.page.getByTestId(`stream-watch-${track}`).click();
      await expect
        .poll(() => b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track), {
          timeout: 20_000,
        })
        .toBe("connected");
      // The watch pulled the audio companion too — the fallback-captured track traveled
      // stream.start → DO → stream.added → pullTracks end-to-end.
      const pulledAudio = await b.page.evaluate(
        (tn) => (window.__tavernTestRtc?.pullCalls ?? []).some((c) => c.trackName === tn),
        audioTrack,
      );
      expect(pulledAudio).toBe(true);
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

  test("FR-33 watcher pulls the single screen encoding; focus never switches layers", async ({
    browser,
    baseURL,
    api,
  }) => {
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

      // A screen pull carries no simulcast rid: there is only the user-selected encoding.
      const pullRid = await b.page.evaluate(
        (tn) => (window.__tavernTestRtc?.pullCalls ?? []).find((c) => c.trackName === tn)?.rid,
        track,
      );
      expect(pullRid).toBeNull();

      // Focus + unfocus are layout-only: no tracks/update layer switch is ever issued.
      await b.page.getByTestId(`stream-tile-${track}`).click();
      await expect(b.page.getByTestId("canvas")).toHaveAttribute("data-focused", "true");
      await b.page.keyboard.press("Escape");
      await expect(b.page.getByTestId("canvas")).not.toHaveAttribute("data-focused", "true");
      expect(await lastLayerRid(b.page)).toBeNull();
    } finally {
      await closeClients(clients);
    }
  });

  test("FR-33 fullscreen and compact thumbnail presentation stay stable", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["fulla", "fullc"]);
    const [a, c] = clients;
    if (!a || !c) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      const first = await startScreenShare(a);
      const second = (await publishMockScreen(c, serverId)).trackName;
      await expect(a.page.getByTestId(`stream-tile-${second}`)).toBeVisible({ timeout: 20_000 });
      const localVideo = a.page.getByTestId(`stream-self-${first}`);
      await expect(localVideo).toBeVisible();
      await expect
        .poll(() =>
          localVideo.evaluate(
            (element) => element instanceof HTMLVideoElement && element.readyState >= 2,
          ),
        )
        .toBe(true);
      await localVideo.evaluate((element) => element.setAttribute("data-continuity-probe", "live"));

      await a.page.getByTestId(`stream-tile-${first}`).click();
      await expect(a.page.getByTestId("canvas")).toHaveAttribute("data-focused", "true");
      await expect(localVideo).toHaveAttribute("data-continuity-probe", "live");
      const compact = a.page.getByTestId(`stream-tile-${second}`);
      await expect(a.page.getByTestId(`stream-slot-${second}`)).toHaveAttribute(
        "data-focus-thumbnail",
        "true",
      );
      await expect(compact).toBeVisible();
      await expect(compact.getByTestId(`stream-watch-${second}`)).toBeVisible();
      await expect(compact.getByTestId(`stream-fullscreen-${second}`)).toHaveCount(0);
      await a.page.screenshot({
        path: testInfo.outputPath("compact-stream-thumbnail.png"),
        animations: "disabled",
      });

      await a.page.getByTestId(`stream-tile-${first}`).click();
      await expect(a.page.getByTestId("canvas")).toHaveAttribute("data-fullscreen", "true");
      await expect(localVideo).toHaveAttribute("data-continuity-probe", "live");
      await expect(a.page.getByText("Resume preview", { exact: true })).toHaveCount(0);
      await expect(a.page.getByTestId(`stream-self-paused-${first}`)).toHaveCount(0);
      await expect(a.page.getByTestId(`stream-tile-${second}`)).toBeHidden();
      await a.page.screenshot({
        path: testInfo.outputPath("live-self-stream-fullscreen.png"),
        animations: "disabled",
      });
      await a.page.keyboard.press("Escape");
      await expect(a.page.getByTestId("canvas")).not.toHaveAttribute("data-fullscreen", "true");
      await expect(localVideo).toHaveAttribute("data-continuity-probe", "live");
      await expect(a.page.getByTestId(`stream-tile-${first}`)).toBeVisible();
      await expect(a.page.getByTestId(`stream-tile-${second}`)).toBeVisible();
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

      // The restored slider and tile-wheel gesture share one persisted userId:kind level. Drive the
      // slider to 15%, then use one upward wheel notch to reach 20%; neither control focuses the tile.
      const streamKey = `${a.user.userId}:screen`;
      await b.page.getByTestId(`stream-tile-${track}`).hover();
      const slider = b.page.getByTestId(`stream-volume-${streamKey}`);
      await expect(slider).toBeVisible();
      await slider.locator('[data-slot="slider-thumb"]').click();
      await pressKeyN(b.page, "ArrowLeft", 40);
      await pressKeyN(b.page, "ArrowRight", 3);
      await expect(b.page.getByTestId(`stream-volume-percent-${streamKey}`)).toHaveText("15%");
      await expect.poll(() => readStreamVolume(b.page, streamKey)).toBe(0.15);

      await wheelN(b.page, -100, 1);
      await expect(b.page.getByTestId(`stream-volume-percent-${streamKey}`)).toHaveText("20%");
      await expect.poll(() => readStreamVolume(b.page, streamKey)).toBe(0.2);
      await expect(b.page.getByTestId("canvas")).not.toHaveAttribute("data-focused", "true");

      // Persisted (settings.volumes.streams) → survives a fresh boot and re-watch into the slider.
      await b.page.goto(`/?e2e=1`);
      await expect(b.page).toHaveURL(new RegExp(`/s/${serverId}$`));
      await expectServerReady(b.page);
      await expect.poll(() => readStreamVolume(b.page, streamKey)).toBe(0.2);
      await b.page.getByTestId(`stream-watch-${track}`).click();
      await expect(b.page.getByTestId(`stream-video-${track}`)).toBeVisible({ timeout: 20_000 });
      await b.page.getByTestId(`stream-tile-${track}`).hover();
      await expect(b.page.getByTestId(`stream-volume-percent-${streamKey}`)).toHaveText("20%");
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

  test("Dashboard stays available while the live canvas follows stream and voice lifecycle", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected a client");
    try {
      await joinVoice(a);
      const track = await startScreenShare(a);

      await expect(a.page.getByTestId("workspace-tab-stream")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await a.page.getByTestId("workspace-tab-dashboard").click();
      await expect(a.page.getByTestId("tavern-home")).toBeVisible();
      await expect(a.page.getByTestId("workspace-tab-dashboard")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await a.page.getByTestId("workspace-tab-stream").click();
      await expect(a.page.getByTestId(`stream-tile-${track}`)).toBeVisible();

      await a.page.getByTestId("controls-screen").click();
      await expect(a.page.getByTestId(`stream-tile-${track}`)).toHaveCount(0, { timeout: 15_000 });
      // Stopping the screen removes only that tile. A is still in voice, so the redesigned canvas
      // remains the active center view with A's voice avatar and Dashboard remains selectable.
      await expect(a.page.getByTestId(`voice-avatar-tile-${a.user.userId}`)).toBeVisible();
      await expect(a.page.getByTestId("workspace-tab-stream")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await a.page.getByTestId("workspace-tab-dashboard").click();
      await expect(a.page.getByTestId("tavern-home")).toBeVisible();
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
      await expect(a.page.getByTestId("share-preset")).toBeVisible();
      await a.page.getByTestId("share-start").click();

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

// Asserts the canvas grid rows match the expected per-row tile counts (App-C layout outcome). Tiles
// remain direct, stable canvas children so focus/fullscreen never remount their live video elements.
async function expectGridRows(page: Page, expected: number[]): Promise<void> {
  await Promise.all(
    expected.map(async (cols, r) => {
      await expect(page.locator(`[data-layout-row="${r}"]`)).toHaveCount(cols);
    }),
  );
  await expect(page.locator(`[data-layout-row="${expected.length}"]`)).toHaveCount(0);
}

// Rolls the mouse wheel `n` times at the current pointer position (no await-in-loop; a reduce chain).
// Each notch is one 5% volume step in useVolumeScroll; deltaY<0 = louder.
async function wheelN(page: Page, deltaY: number, n: number): Promise<void> {
  await Array.from({ length: n }).reduce<Promise<void>>(
    (p) => p.then(() => page.mouse.wheel(0, deltaY)),
    Promise.resolve(),
  );
}

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
  // The persisted control level (0..2) under settings.volumes.v1 → streams[userId:kind] — the slider's
  // source of truth (§5.4 VolumesV1). Traversed without an `as`-cast (§9.1) via Object.entries.
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
    const level = pick(pick(JSON.parse(raw), "streams"), key);
    return typeof level === "number" ? level : undefined;
  }, streamKey);
}
