/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-40 Stats tab e2e against the real local stack (wrangler dev + Vite). The PR spec runs with
// TAVERN_SFU_MOCK=1 and asserts server-authoritative MESSAGE counts (A sends 3 → B's Stats tab shows
// A's row ≥3) plus the presence of the "you watch most" section (mock mode moves no media, so no
// watch seconds accrue). The @realtime spec (nightly, real SFU per §10) asserts watch seconds
// actually accruing: B watches A's stream ~10s and A then appears in B's watch-most ranking.

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

interface Opened {
  context: BrowserContext;
  page: Page;
}

async function pageFor(
  browser: Browser,
  baseURL: string | undefined,
  user: SeededUser,
  query = "",
): Promise<Opened> {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  await page.goto(`/${query}`);
  return { context, page };
}

async function bootOnto(opened: Opened, serverId: string): Promise<void> {
  await expect(opened.page).toHaveURL(new RegExp(`/s/${serverId}$`));
  await expect(opened.page.getByTestId("controls-bar")).toBeVisible();
}

// Joins voice and waits until FULLY wired (publish + voice pull connected) — a premature
// share/watch races its own grant/pull on slow runners and reverts (nightly CI finding).
async function joinWired(opened: Opened, userId: string): Promise<void> {
  await opened.page.getByTestId("controls-join").click();
  await expect(opened.page.getByTestId(`voice-chip-${userId}`)).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        opened.page.evaluate(() => {
          const rtc = window.__tavernTestRtc;
          return rtc ? { publish: rtc.publishState, pull: rtc.pullStates.voice ?? "none" } : null;
        }),
      { timeout: 20_000 },
    )
    .toEqual({ publish: "connected", pull: "connected" });
}

async function sendPaced(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(220); // under the 5/s chat rate limit (LIMITS.rateChatPerSec)
}

test.describe("FR-40 stats e2e", () => {
  test("message counts appear: A sends 3 messages, B stats tab shows A row with ≥3", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(60_000);
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);

    const openedA = await pageFor(browser, baseURL, a);
    const openedB = await pageFor(browser, baseURL, b);
    try {
      await bootOnto(openedA, server.id);
      await bootOnto(openedB, server.id);
      // Both sockets live before A sends — B sees A in People, so B will hold a fresh member map.
      await expect(openedB.page.getByTestId(`member-${a.userId}`)).toBeVisible();

      // A sends 3 messages (paced under the rate limit). These are A's server-authoritative
      // messages-sent count (SELECT COUNT(*) … GROUP BY user_id in the DO).
      let chain = Promise.resolve();
      for (let i = 0; i < 3; i++) {
        const text = `m-${hex(3)}-${i}`;
        chain = chain.then(() => sendPaced(openedA.page, text));
      }
      await chain;

      // B opens the Stats tab — its query fetches the snapshot on activation and renders A's row.
      await openedB.page.getByTestId("tab-stats").click();
      const cell = openedB.page.getByTestId(`stats-messages-${a.userId}`);
      await expect(cell).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => Number((await cell.textContent()) ?? "0"), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3);

      // Watch-most section is present (presence only — mock mode accrues no watch seconds for B).
      await expect(openedB.page.getByTestId("stats-watch-most")).toBeVisible();
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("@realtime watch seconds accrue: B watches A stream 10s, B watch-most shows A with >0", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);

    // `?e2e=1` installs the platform test hooks (media auto-permission + fake devices) — §10.
    const openedA = await pageFor(browser, baseURL, a, "?e2e=1");
    const openedB = await pageFor(browser, baseURL, b, "?e2e=1");
    try {
      await bootOnto(openedA, server.id);
      await bootOnto(openedB, server.id);
      await expect(openedB.page.getByTestId(`member-${a.userId}`)).toBeVisible();

      // Both join voice (a stream pull requires an active voice membership — G1) and are FULLY
      // wired (publish + voice pull connected) before any share/watch — a premature watch races
      // its own grant/pull on slow runners and reverts, accruing nothing (nightly CI finding).
      await joinWired(openedA, a.userId);
      await joinWired(openedB, b.userId);

      // A screen-shares (web picker variant: preset + audio hint, then Start).
      await openedA.page.getByTestId("controls-screen").click();
      await openedA.page.getByTestId("share-start").click();

      // B sees A's stream tile appear and clicks Watch (opt-in — FR-30).
      const watchButton = openedB.page.locator('[data-testid^="stream-watch-"]').first();
      await expect(watchButton).toBeVisible({ timeout: 20_000 });
      await watchButton.click();
      // The watch pull must actually be LIVE before the accrual clock matters — a reverted watch
      // (error frame / rejected REST pull) would silently accrue nothing on a slow runner.
      await expect
        .poll(
          () =>
            openedB.page.evaluate(() => {
              const rtc = window.__tavernTestRtc;
              if (!rtc) return "none";
              const entry = Object.entries(rtc.pullStates).find(([key]) =>
                key.startsWith("screen:"),
              );
              return entry ? entry[1] : "none";
            }),
          { timeout: 20_000 },
        )
        .toBe("connected");

      // Accrue ~10s of watch time, then UNWATCH: the stats snapshot reads only BANKED SQLite rows
      // (open intervals are deliberately not read — stats.ts pin), and banking happens on
      // watch.stop or the 60s alarm flush. Stopping the watch banks the interval immediately.
      await openedB.page.waitForTimeout(11_000);
      await openedB.page.locator('[data-testid^="stream-unwatch-"]').first().click();

      // B opens Stats — B's "you watch most" now lists A (viewer=B → streamer=A pair, seconds > 0,
      // so the row is rendered even though 10s displays as "0:00" in h:mm).
      await openedB.page.getByTestId("tab-stats").click();
      await expect(
        openedB.page.locator(`[data-testid="stats-watch-row"][data-streamer-id="${a.userId}"]`),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });
});
