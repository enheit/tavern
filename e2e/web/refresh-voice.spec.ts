/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import { expect, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// Refresh voice auto-resume (voiceSession.ts / voiceResume.ts): a reload while in voice must land
// the user BACK in the call — same channel, mute/deafen flags intact, webcam restarted — with no
// click. An explicit leave (user intent) must NOT resume. The "reload" is a full document
// navigation to `/?e2e=1` (the FR-20 volume-persistence precedent): a bare page.reload() would drop
// the ?e2e=1 query the test hooks need, and sessionStorage survives any same-tab navigation the
// same way it survives F5. Mock SFU (§10): assertions are signaling + session state + local media.

async function rtcStates(
  page: import("@playwright/test").Page,
): Promise<{ publish: string; pull: string } | null> {
  return page.evaluate(() => {
    const rtc = window.__tavernTestRtc;
    return rtc ? { publish: rtc.publishState, pull: rtc.pullStates.voice ?? "none" } : null;
  });
}

test.describe("refresh voice auto-resume", () => {
  test("reload while in voice (muted, cam on) → rejoined, still muted, cam restarted", async ({
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
      await expect(page.getByTestId("controls-bar")).toBeVisible();

      // Join voice, mute, start the webcam (fake capture device).
      await page.getByTestId("channel-voice").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => rtcStates(page), { timeout: 20_000 })
        .toEqual({ publish: "connected", pull: "connected" });
      await page.getByTestId("controls-mute").click();
      await expect(page.getByTestId("controls-mute")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("controls-cam").click();
      await expect(page.getByTestId(`stream-tile-cam:${user.userId}`)).toBeVisible({
        timeout: 20_000,
      });

      // Reload. NO clicks after this point — everything below must happen on its own.
      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));

      // Back in the SAME voice channel, publish+pull re-wired.
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => rtcStates(page), { timeout: 20_000 })
        .toEqual({ publish: "connected", pull: "connected" });

      // Mute intent restored (self view + the voice.state flag round-trip is FR-26-covered).
      await expect(page.getByTestId("controls-mute")).toHaveAttribute("aria-pressed", "true");

      // Webcam restarted: cam toggle pressed + the self cam tile is live again.
      await expect(page.getByTestId("controls-cam")).toHaveAttribute("aria-pressed", "true", {
        timeout: 20_000,
      });
      await expect(page.getByTestId(`stream-tile-cam:${user.userId}`)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await context.close();
    }
  });

  test("explicit leave → reload stays OUT of voice", async ({ browser, baseURL, api }) => {
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
      await page.getByTestId("channel-voice").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("controls-leave").click();
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveCount(0, {
        timeout: 10_000,
      });

      await page.goto("/?e2e=1");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      // Give any (buggy) auto-rejoin time to fire, then assert it did not.
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
