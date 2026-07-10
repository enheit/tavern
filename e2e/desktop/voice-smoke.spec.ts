/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-18 desktop voice smoke: one Electron instance (launchDesktop sets TAVERN_E2E=1 → main-process
// fake-media flags + the committed tone WAV, §10). A seeded user is pre-authenticated through the
// launchDesktop `user` seam (its bearer token is stored via the IPC safeStorage secrets channel, then
// the boot gate restores the session — FR-02), lands on its single server, and joins voice with the
// fake mic. We assert the SIGNALING/local path only (mock SFU, TAVERN_SFU_MOCK=1): the publish
// session reaches `connected` (rtc hook) and the self speaking ring lights from the LOCAL analyser on
// the tone.

// Minimal typing for the desktop IPC bridge used to inject the session token (the app-side TavernIpc
// is not part of the e2e tsconfig). The __tavernTestRtc window type is declared (ambient) in
// voice.spec.ts.
declare global {
  interface Window {
    // Kept identical to share-smoke.spec's block (interface-merge requires it); `capture` unused here.
    tavern?: {
      secrets: { setToken(t: string): Promise<void> };
      capture: { getScreenSources(): Promise<Array<{ id: string; name: string }>> };
    };
  }
}

test.describe("FR-18 desktop voice smoke", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("joins voice, publish reaches connected and self speaking ring lights", async ({ api }) => {
    test.setTimeout(120_000);
    // Seed a user that already owns (and is a member of) one server, so boot lands on /s/:id.
    const user = await api.createUser("desktop");
    await api.createServer(user);

    const { page } = await launchDesktop({ instance: 0, user });
    await expect(page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });

    // Pre-authenticate: store the bearer token via the IPC secrets channel (safeStorage), then boot
    // from the renderer root (the boot gate restores the session — FR-02 — and routes the single-server
    // member to /s/:id; reloading the /login route does not re-run that redirect). No flaky login form.
    await page.evaluate((token) => window.tavern?.secrets.setToken(token), user.token);
    await page.goto(WEB_URL);

    // Boot gate lands the single-server member on the server shell.
    await expect(page.getByTestId("controls-bar")).toBeVisible({ timeout: 30_000 });

    // Join voice with the fake mic.
    await page.getByTestId("controls-join").click();
    await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });

    // Publish session reaches connected (mock SFU answer accepted; signaling path complete).
    await expect
      .poll(() => page.evaluate(() => window.__tavernTestRtc?.publishState), { timeout: 15_000 })
      .toBe("connected");

    // FR-23: the 440 Hz tone drives the local analyser past the speaking threshold within ~2 s.
    await expect(page.getByTestId(`voice-chip-${user.userId}`)).toHaveAttribute(
      "data-speaking",
      "true",
      { timeout: 3_000 },
    );
  });
});
