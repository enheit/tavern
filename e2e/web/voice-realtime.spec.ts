/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { REALTIME_URL } from "../playwright.config";

// FR-19 voice, @realtime nightly (real Cloudflare Realtime SFU — §10 hermeticity split). The Worker
// runs WITHOUT TAVERN_SFU_MOCK, so there IS a media plane: B auto-subscribes A's mic and the inbound
// RTP actually flows. These are the ONLY assertions that need remote media (bytesReceived / audioLevel
// via __tavernTestRtc.stats('voice')); the PR/mock suite (voice.spec.ts) covers the state/signaling
// side. baseURL is the real-SFU worker on 8788 (serves the app + /api same-origin). Every page is
// opened with `?e2e=1`. Skipped unless the realtime secrets are present (nightly/main only).
//
// The __tavernTestAudio / __tavernTestRtc window types are declared (ambient, project-wide) in
// voice.spec.ts.

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
      // Boot via "/" (single-server member lands on /s/:id); `?e2e=1` sets platform.isE2E at load.
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      return { user, context, page };
    }),
  );
  const [first, second] = built;
  if (!first || !second) throw new Error("expected two clients");
  return { clients: [first, second] };
}

async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("controls-join").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
}

async function readStats(
  page: Page,
): Promise<{ bytesReceived: number; audioLevel: number | null }> {
  const stats = await page.evaluate(() => window.__tavernTestRtc?.stats("voice"));
  if (stats === undefined) throw new Error("__tavernTestRtc.stats unavailable");
  return stats;
}

test.describe("FR-19 voice @realtime", () => {
  test("B receives A: inbound-rtp bytesReceived strictly increases over 5s AND audioLevel > 0 while the tone plays", async ({
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
      // Wait until B is actually receiving A's mic before sampling.
      await expect
        .poll(async () => (await readStats(b.page)).bytesReceived, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const t0 = await readStats(b.page);
      await b.page.waitForTimeout(5_000);
      const t1 = await readStats(b.page);

      // FR-19 AC: real remote audio flowing (bytes climb, level non-zero while the 440 Hz tone plays).
      expect(t1.bytesReceived).toBeGreaterThan(t0.bytesReceived);
      expect(t1.audioLevel ?? 0).toBeGreaterThan(0);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });

  test("A mute → B audioLevel falls to ~0 within 3s", async ({ browser, baseURL, api }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      // B is hearing A.
      await expect
        .poll(async () => (await readStats(b.page)).audioLevel ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(0.001);

      // A mutes (track disabled → silence) → B's inbound audioLevel collapses to ~0.
      await a.page.getByTestId("controls-mute").click();
      await expect
        .poll(async () => (await readStats(b.page)).audioLevel ?? 0, { timeout: 3_000 })
        .toBeLessThan(0.001);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });
});
