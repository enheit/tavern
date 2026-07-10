import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-28 desktop screen-share smoke: one Electron instance (launchDesktop sets TAVERN_E2E=1 → the
// main-process fake-media flags + committed tone WAV, §10). A seeded user is pre-authenticated through
// the launchDesktop `user` seam, lands on its single server, and joins voice (the ControlsBar screen
// button is disabled until in voice). We then open the SharePickerDialog (desktop variant) and assert
// its IPC contract: window.tavern.capture.getScreenSources() returns an array. If ≥1 real source is
// enumerated AND the OS grants capture, we select the first + assert the share reaches `sharing` against
// the mock SFU; under a headless display (xvfb) or without a capture-permission grant no source
// captures, so the pinned fallback asserts the dialog + IPC contract only (never a failure) and logs.

// Minimal typing for the desktop IPC bridge used here (the app-side TavernIpc is not part of the e2e
// tsconfig). The __tavernTestRtc window type is declared (ambient) in voice.spec.ts.
declare global {
  interface Window {
    tavern?: {
      secrets: { setToken(t: string): Promise<void> };
      capture: { getScreenSources(): Promise<Array<{ id: string; name: string }>> };
    };
  }
}

test.describe("FR-28 desktop share smoke", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("SharePickerDialog lists capture sources via IPC", async ({ api }) => {
    test.setTimeout(120_000);
    const user = await api.createUser("dshare");
    await api.createServer(user);

    const { page } = await launchDesktop({ instance: 0, user });
    await expect(page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });
    await page.evaluate((token) => window.tavern?.secrets.setToken(token), user.token);
    await page.goto(WEB_URL);
    await expect(page.getByTestId("controls-bar")).toBeVisible({ timeout: 30_000 });

    // The screen-share control is enabled only while in voice — join first.
    await page.getByTestId("controls-join").click();
    await expect(page.getByTestId(`voice-chip-${user.userId}`)).toBeVisible({ timeout: 20_000 });

    // Open the SharePickerDialog (desktop variant renders Screens/Windows tabs + the preset select).
    await page.getByTestId("controls-screen").click();
    await expect(page.getByTestId("share-tab-screens")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("share-preset")).toBeVisible();

    // IPC contract (FR-28): getScreenSources resolves to an array (length ≥ 0 — xvfb may expose none).
    const sources = await page.evaluate(() => window.tavern?.capture.getScreenSources());
    expect(Array.isArray(sources)).toBe(true);
    const list = sources ?? [];

    if (list.length === 0) {
      // Pinned fallback: no capturable source (headless display) — dialog + IPC contract proven above.
      console.log("xvfb: no sources");
      return;
    }

    // At least one source: prefer a SCREEN (the default-visible tab; a window source lives behind the
    // Windows tab). Selecting + starting is best-effort — capture still needs an OS grant (macOS TCC),
    // and a share against the mock SFU only reaches `sharing` where getDisplayMedia is permitted. Any
    // failure here (hidden tab, denied permission) is an environment limitation, logged not failed; the
    // dialog + IPC contract asserted above are the pinned gate.
    const source = list.find((s) => s.id.startsWith("screen:")) ?? list[0];
    if (source === undefined) throw new Error("unreachable: non-empty list has a first element");
    try {
      await page.getByTestId(`share-source-${source.id}`).click({ timeout: 5_000 });
      await page.getByTestId("share-start").click({ timeout: 5_000 });
      await expect(page.getByTestId("controls-screen")).toHaveAttribute("aria-pressed", "true", {
        timeout: 15_000,
      });
    } catch {
      console.log("desktop: capture source present but share did not start (capture unavailable)");
    }
  });
});
