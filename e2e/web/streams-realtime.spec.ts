/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { PresetId } from "@tavern/shared";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { REALTIME_URL } from "../playwright.config";

// FR-27/30/32/33 streams, @realtime nightly (real Cloudflare Realtime SFU — §10 hermeticity split). The
// Worker runs WITHOUT TAVERN_SFU_MOCK, so there IS a media plane: A's screen share actually encodes and
// B's watch pull decodes real frames. These are the ONLY assertions that need remote media (videoWidth,
// framesDecoded, frameHeight via window.__tavernTestVideoStats); the PR/mock suite (streams.spec.ts)
// covers the state/signaling/layout side. baseURL is the real-SFU worker on 8788 (serves the app + /api
// same-origin). Skipped unless the realtime secrets are present (nightly/main only).
//
// __tavernTestRtc is declared (ambient, project-wide) in voice.spec.ts; the video-stats global is
// declared here (only this spec reads it, so no merge with __tavernTestRtc).
declare global {
  interface Window {
    __tavernTestVideoStats?: (trackName: string) => Promise<{
      framesDecoded: number;
      frameHeight: number | null;
      bytesReceived: number;
      framesPerSecond: number | null;
    }>;
  }
}

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

async function seedPair(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
): Promise<{ clients: [Client, Client] }> {
  const target = baseURL ?? REALTIME_URL;
  const admin = await api.createUser("a");
  const server = await api.createServer(admin);
  const b = await api.createUser("b");
  await api.join(b, server.nickname);
  const built = await Promise.all(
    [admin, b].map(async (user): Promise<Client> => {
      const context = await browser.newContext({
        baseURL: target,
        storageState: await user.request.storageState(),
      });
      const page = await context.newPage();
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);
      return { user, context, page };
    }),
  );
  const [first, second] = built;
  if (!first || !second) throw new Error("expected two clients");
  return { clients: [first, second] };
}

async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
}

async function startScreenShare(client: Client, preset: PresetId): Promise<string> {
  await client.page.getByTestId("controls-screen").click();
  await expect(client.page.getByTestId("share-preset")).toBeVisible();
  await client.page.getByTestId("share-preset").click();
  await client.page.getByTestId(`preset-option-${preset}`).click();
  await client.page.getByTestId("share-start").click();
  const trackName = `screen:${client.user.userId}:1`;
  await expect(client.page.getByTestId(`stream-tile-${trackName}`)).toBeVisible({
    timeout: 20_000,
  });
  return trackName;
}

async function videoStats(
  page: Page,
  trackName: string,
): Promise<{ framesDecoded: number; frameHeight: number | null }> {
  const stats = await page.evaluate((tn) => window.__tavernTestVideoStats?.(tn), trackName);
  if (stats === undefined) throw new Error("__tavernTestVideoStats unavailable");
  return stats;
}

test.describe("FR-27/30/32/33 streams @realtime", () => {
  test("FR-30/32 real frames flow to watcher", async ({ browser, baseURL, api }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      const track = await startScreenShare(a, "720p30");
      await b.page.getByTestId(`stream-tile-${track}`).getByTestId(`stream-watch-${track}`).click();

      // Real media: the pulled <video> has non-zero intrinsic dimensions.
      const video = b.page.getByTestId(`stream-video-${track}`);
      await expect
        .poll(() => video.evaluate((el) => (el instanceof HTMLVideoElement ? el.videoWidth : 0)), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // framesDecoded strictly increases over 5s (frames are actually flowing).
      await expect
        .poll(async () => (await videoStats(b.page, track)).framesDecoded, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const t0 = await videoStats(b.page, track);
      await b.page.waitForTimeout(5_000);
      const t1 = await videoStats(b.page, track);
      expect(t1.framesDecoded).toBeGreaterThan(t0.framesDecoded);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });

  test("FR-27 preset drop reaches viewer", async ({ browser, baseURL, api }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      const track = await startScreenShare(a, "720p30");
      await b.page.getByTestId(`stream-tile-${track}`).getByTestId(`stream-watch-${track}`).click();
      // The watcher receives the only selected encoding without focusing. Allow the real SFU and
      // browser bandwidth estimate to warm up before changing the preset.
      await expect
        .poll(async () => (await videoStats(b.page, track)).frameHeight ?? 0, { timeout: 40_000 })
        .toBeGreaterThan(480);

      // A drops the preset 720p30 → 480p30 on the fly (own-tile quality dropdown → setPreset: fps-only
      // applyConstraints + encoder re-scale, no renegotiation). The minified worker-served build wires Base UI popups a
      // tick late (the S11.1 slider precedent), so a blind option click can silently land on
      // nothing (bimodal never-drops failures) — retry the selection until A's own trigger
      // REFLECTS the new preset, then poll the media plane.
      await expect(async () => {
        await a.page.getByTestId(`stream-tile-${track}`).hover();
        await a.page.getByTestId(`stream-preset-${track}`).click();
        await a.page.getByTestId(`stream-preset-option-480p30`).click();
        await expect(a.page.getByTestId(`stream-preset-${track}`)).toContainText("480p", {
          timeout: 2_000,
        });
      }).toPass({ timeout: 30_000 });
      // Fault-domain split: FIRST assert A's own encoder re-encodes the single
      // output at ≤480 (outbound-rtp via the §10 hook — publisher-local, no SFU involved). A red HERE
      // means applyConstraints/setParameters did not reach the encoder; a red on the viewer poll
      // BELOW then isolates the SFU→watcher path. `Infinity` when the h layer has no frameHeight yet
      // so a missing stat can never pass the ≤ check.
      await expect
        .poll(
          async () => {
            const layers = await a.page.evaluate(
              (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
              track,
            );
            const encoding = (layers ?? [])[0];
            return encoding?.frameHeight ?? Number.POSITIVE_INFINITY;
          },
          { timeout: 20_000 },
        )
        .toBeLessThanOrEqual(480);
      // B's inbound encoding shrinks to ≤ 480 (eventual over the real SFU: encoder reconfig +
      // keyframe + forwarding; FR-27's AC pins the outcome, not a latency).
      await expect
        .poll(async () => (await videoStats(b.page, track)).frameHeight ?? 0, { timeout: 30_000 })
        .toBeLessThanOrEqual(480);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });

  test("FR-33 grid tile receives the selected encoding without focus", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      const track = await startScreenShare(a, "1080p30");
      await b.page.getByTestId(`stream-tile-${track}`).getByTestId(`stream-watch-${track}`).click();
      await expect
        .poll(async () => (await videoStats(b.page, track)).framesDecoded, { timeout: 20_000 })
        .toBeGreaterThan(0);

      // An UNFOCUSED grid tile receives the publisher's only screen encoding. The source may be
      // smaller than the requested preset in headless CI, so this checks that it is not a 270p
      // fallback rather than assuming the fake display's physical size.
      await expect
        .poll(async () => (await videoStats(b.page, track)).frameHeight ?? 0, { timeout: 40_000 })
        .toBeGreaterThan(270);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });
});
