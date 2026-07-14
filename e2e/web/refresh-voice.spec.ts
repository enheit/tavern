/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import { expect, expectServerReady, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// A reload terminates browser-owned media. It must therefore return the UI to its idle state instead
// of recreating voice, publishing a webcam, or restoring a watcher without a fresh user action. The
// "reload" is a full document navigation to `/?e2e=1` so the test hooks remain available.

async function rtcStates(
  page: import("@playwright/test").Page,
): Promise<{ publish: string; pull: string } | null> {
  return page.evaluate(() => {
    const rtc = window.__tavernTestRtc;
    return rtc ? { publish: rtc.publishState, pull: rtc.pullStates.voice ?? "none" } : null;
  });
}

test.describe("refresh clears live media state", () => {
  test("reload while in voice with webcam and screen on → returns idle without stale tiles", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(120_000);
    const user = await api.createUser("resume");
    const server = await api.createServer(user);
    const context = await browser.newContext({
      baseURL: baseURL ?? WEB_URL,
      storageState: await user.request.storageState(),
    });
    const page = await context.newPage();
    try {
      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);

      // Join voice, mute, start the webcam (fake capture device).
      await page.getByTestId("channel-voice").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => rtcStates(page), { timeout: 20_000 })
        .toEqual({ publish: "connected", pull: "connected" });
      await page.getByTestId("controls-mute").click();
      await expect(page.getByTestId("controls-mute")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("controls-cam").click();
      const camTrackName = `cam:${user.userId}`;
      await expect(page.getByTestId(`stream-tile-${camTrackName}`)).toBeVisible({
        timeout: 20_000,
      });
      await page.getByTestId("controls-screen").click();
      await expect(page.getByTestId("share-preset")).toBeVisible();
      await page.getByTestId("share-start").click();
      const screenTrackName = `screen:${user.userId}:1`;
      await expect(page.getByTestId(`stream-tile-${screenTrackName}`)).toBeVisible({
        timeout: 20_000,
      });

      // Install before the next document starts. Final absence alone can miss a one-frame stale
      // snapshot, so record whether either abandoned self tile ever attaches during refresh boot.
      await page.addInitScript(
        ({ testIds, storageKey }) => {
          sessionStorage.setItem(storageKey, "[]");
          const seen = new Set<string>();
          const scan = (node: Node): void => {
            if (!(node instanceof Element)) return;
            const candidates = [node, ...node.querySelectorAll("[data-testid]")];
            for (const candidate of candidates) {
              const id = candidate.getAttribute("data-testid");
              if (id !== null && testIds.includes(id)) seen.add(id);
            }
            sessionStorage.setItem(storageKey, JSON.stringify([...seen]));
          };
          new MutationObserver((records) => {
            for (const record of records) for (const node of record.addedNodes) scan(node);
          }).observe(document, { childList: true, subtree: true });
        },
        {
          testIds: [`stream-tile-${camTrackName}`, `stream-tile-${screenTrackName}`],
          storageKey: "tavern-refresh-stale-stream-tiles",
        },
      );

      // Reload. Browser media tracks and the socket are gone, so no live-media control may remain
      // active or be reconstructed without a fresh user action.
      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(page.getByTestId("controls-cam")).toHaveCount(0);
      await expect(page.getByTestId("controls-screen")).toHaveCount(0);
      await expect(page.getByTestId(`stream-tile-${camTrackName}`)).toHaveCount(0);
      await expect(page.getByTestId(`stream-tile-${screenTrackName}`)).toHaveCount(0);
      const staleTiles = await page.evaluate(() =>
        sessionStorage.getItem("tavern-refresh-stale-stream-tiles"),
      );
      expect(JSON.parse(staleTiles ?? "[]")).toEqual([]);
      await expect.poll(() => rtcStates(page)).toEqual({ publish: "idle", pull: "none" });
    } finally {
      await context.close();
    }
  });

  test("explicit leave → reload stays idle", async ({ browser, baseURL, api }) => {
    test.setTimeout(120_000);
    const user = await api.createUser("noresume");
    const server = await api.createServer(user);
    const context = await browser.newContext({
      baseURL: baseURL ?? WEB_URL,
      storageState: await user.request.storageState(),
    });
    const page = await context.newPage();
    try {
      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);
      await page.getByTestId("channel-voice").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("controls-leave").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveCount(0, {
        timeout: 10_000,
      });

      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
