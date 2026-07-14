/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// § screenshots (mock SFU): Space over the FOCUSED stream captures a still → R2 → the Screenshots tab.
// The self-webcam path renders the LOCAL getUserMedia stream directly (FR-29), and Playwright launches
// Chromium with --use-fake-device-for-media-stream, so the self tile carries REAL frames even though the
// mock SFU has no media plane. That lets this spec exercise the true DOM→canvas→R2 capture leg, the
// member-gated list/delete, and the public capability view URL (the <img> loads from /api/screenshots/*).

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

// One admin/creator client booted onto their fresh server (mirrors streams.spec's single-client setup).
async function openClient(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
): Promise<{ serverId: string; client: Client }> {
  const target = baseURL ?? WEB_URL;
  const user = await api.createUser("shooter");
  const server = await api.createServer(user);
  const context = await browser.newContext({
    baseURL: target,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  await page.goto(`/?e2e=1`);
  await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
  await expectServerReady(page);
  return { serverId: server.id, client: { user, context, page } };
}

// Joins voice and waits until fully wired (self chip + publish/voice-pull connected) — identical to the
// streams/voice.spec gate; a webcam publish needs an in-voice SFU session.
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

test.describe("§ screenshots (mock SFU)", () => {
  test("Space over a focused stream captures, lists, and deletes a screenshot", async ({
    browser,
    baseURL,
    api,
  }) => {
    const { client } = await openClient(browser, baseURL, api);
    const page = client.page;
    const track = `cam:${client.user.userId}`;

    await joinVoice(client);

    // Start the self webcam → the self tile renders the local fake-camera stream (real frames).
    await page.getByTestId("controls-cam").click();
    await expect(page.getByTestId(`stream-tile-${track}`)).toBeVisible({ timeout: 20_000 });
    const selfVideo = page.getByTestId(`stream-self-${track}`);
    await expect
      .poll(() => selfVideo.evaluate((v) => (v as HTMLVideoElement).videoWidth), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // No focus yet → Space is a no-op that only hints (spec: "if no stream focused, no-one captures").
    // Blur the just-clicked cam button first: Space intentionally yields to a focused control, so the
    // key only reaches the Canvas handler once DOM focus is off any button (a real user is on the tile).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await expect(page.getByText(/focus a stream first/i)).toBeVisible({ timeout: 10_000 });

    // Focus the tile, wait for frames to resume on the reparented main tile, then capture with Space.
    await page.getByTestId(`stream-tile-${track}`).click();
    await expect(page.getByTestId("canvas")).toHaveAttribute("data-focused", "true");
    await expect
      .poll(() => selfVideo.evaluate((v) => (v as HTMLVideoElement).videoWidth), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await expect(page.getByText(/screenshot saved/i)).toBeVisible({ timeout: 15_000 });

    // The Screenshots tab shows the still and its thumbnail actually loads from the public view URL.
    await page.getByTestId("workspace-tab-screenshots").click();
    const card = page.locator('[data-testid^="screenshot-"]').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const img = card.locator("img");
    await expect
      .poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // Clicking the thumbnail opens the public full-resolution image in a real browser tab.
    const openLink = card.locator("a");
    await expect(openLink).toHaveAttribute(
      "href",
      /\/api\/screenshots\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/,
    );
    const popupPromise = page.waitForEvent("popup");
    await openLink.click();
    const screenshotPage = await popupPromise;
    await screenshotPage.waitForLoadState("load");
    await expect(screenshotPage).toHaveURL(/\/api\/screenshots\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/);
    const fullImage = screenshotPage.locator("img");
    await expect(fullImage).toBeVisible();
    await expect
      .poll(() =>
        fullImage.evaluate((image) => (image instanceof HTMLImageElement ? image.naturalWidth : 0)),
      )
      .toBeGreaterThan(0);
    await screenshotPage.close();

    // Top-right ✕ asks for confirmation. Cancel preserves it; confirm removes it.
    await card.hover();
    await card.locator('[data-testid^="screenshot-delete-"]').click();
    const confirm = page.getByTestId(/^screenshot-delete-confirm-/);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toBeVisible();

    await card.hover();
    await card.locator('[data-testid^="screenshot-delete-"]').click();
    await page.getByTestId(/^screenshot-delete-do-/).click();
    await expect(page.getByTestId("screenshots-empty")).toBeVisible({ timeout: 15_000 });

    await client.context.close();
  });
});
