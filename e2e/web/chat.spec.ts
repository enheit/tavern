import { randomBytes } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { expect, expectMemberVisible, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-14 / FR-15 / FR-17 chat UI against the real local stack (wrangler dev + Vite; SFU not used).
// Users are seeded via the `api` fixture; their session cookie is transferred into a browser context
// and each boots through `/` (the boot gate lands a single-server member on `/s/:id`), so both land
// on the same server's Chat tab. The emoji dataset is served same-origin from /emojibase (strict CSP).

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

interface Opened {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}

async function pageFor(
  browser: Browser,
  baseURL: string | undefined,
  user: SeededUser,
): Promise<Opened> {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  return { context, page };
}

async function bootOnto(opened: Opened, serverId: string): Promise<void> {
  await opened.page.goto("/");
  await expect(opened.page).toHaveURL(new RegExp(`/s/${serverId}$`));
  await expect(opened.page.getByTestId("composer-input")).toBeVisible();
}

// Two members of one fresh server, each booted onto its Chat tab and seeing the other in People
// (which proves both WebSocket connections are live before we assert message delivery).
async function bootPair(browser: Browser, baseURL: string | undefined, api: Api) {
  const a = await api.createUser("a");
  const server = await api.createServer(a);
  const b = await api.createUser("b");
  await api.join(b, server.nickname);

  const openedA = await pageFor(browser, baseURL, a);
  const openedB = await pageFor(browser, baseURL, b);
  await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
  // Both sockets live: each sees the other in the People tab (restored to Chat afterward).
  await expectMemberVisible(openedA.page, b.userId);
  await expectMemberVisible(openedB.page, a.userId);

  return { a, b, server, openedA, openedB };
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

// One paced send (kept in its own async fn so the caller's sequential chain has no await-in-loop).
async function sendPaced(page: Page, text: string): Promise<void> {
  await sendMessage(page, text);
  await page.waitForTimeout(210); // under the 5/s chat rate limit (LIMITS.rateChatPerSec)
}

test.describe("FR-14 FR-15 FR-17 chat", () => {
  test("B sees A's message within 1s", async ({ browser, baseURL, api }) => {
    const { openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      const text = `hello-${hex(4)}`;
      await sendMessage(openedA.page, text);
      // Delivered live to B, and A keeps its own (optimistic → reconciled) copy.
      await expect(openedB.page.getByText(text, { exact: true })).toBeVisible({ timeout: 1000 });
      await expect(openedA.page.getByText(text, { exact: true })).toBeVisible();
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("A mentions @B via autocomplete; highlighted on B, accent-only on A", async ({
    browser,
    baseURL,
    api,
  }) => {
    const { b, openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      const input = openedA.page.getByTestId("composer-input");
      // Type a prefix of B's username → the autocomplete lists B; pick it, then send.
      await input.fill(`hey @${b.username.slice(0, 6)}`);
      await expect(openedA.page.getByTestId("mention-autocomplete")).toBeVisible();
      await openedA.page.getByTestId(`mention-option-${b.username}`).click();
      await expect(input).toHaveValue(`hey @${b.username} `);
      await input.press("Enter");

      // On B the mention is self-highlighted (B's userId is in the server-computed mentions).
      await expect(openedB.page.locator('[data-testid="mention"][data-self="true"]')).toHaveText(
        `@${b.username}`,
        { timeout: 2000 },
      );
      // On A (the sender, not mentioned) the same token is accent-only, never self-highlighted.
      await expect(openedA.page.locator('[data-testid="mention"][data-self="false"]')).toHaveText(
        `@${b.username}`,
      );
      await expect(openedA.page.locator('[data-testid="mention"][data-self="true"]')).toHaveCount(
        0,
      );
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("picked emoji appears in the delivered message", async ({ browser, baseURL, api }) => {
    // The composer's emoji picker is temporarily hidden (SHOW_EMOJI=false in Composer.tsx, per
    // request) — re-enable this test when the flag flips back.
    test.skip(true, "emoji picker temporarily hidden (Composer.tsx SHOW_EMOJI=false)");
    const { openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      await openedA.page.getByTestId("composer-emoji").click();
      // frimousse fetches the self-hosted /emojibase dataset; wait for the grid to render. `:visible`
      // skips the picker's hidden aria-hidden "row-sizer" emoji (used only to measure cell size).
      const firstEmoji = openedA.page.locator('[data-slot="emoji-picker-emoji"]:visible').first();
      await expect(firstEmoji).toBeVisible({ timeout: 15000 });
      const emojiChar = ((await firstEmoji.textContent()) ?? "").trim();
      expect(emojiChar.length).toBeGreaterThan(0);
      await firstEmoji.click();

      const input = openedA.page.getByTestId("composer-input");
      expect(await input.inputValue()).toContain(emojiChar);
      await input.press("Enter");

      await expect(openedB.page.getByText(emojiChar, { exact: true })).toBeVisible({
        timeout: 3000,
      });
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("history survives B reload and older page loads on scroll-top", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(60000);
    const { server, openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      // 55 messages > one 50-message page, so chat-0..chat-4 land on the older page. Sent as a
      // sequential promise chain (no await-in-loop) so the pacing holds under the rate limit.
      let chain = Promise.resolve();
      for (let i = 0; i < 55; i++) {
        const text = `chat-${i}`;
        chain = chain.then(() => sendPaced(openedA.page, text));
      }
      await chain;

      // History persists server-side (FR-17): B restarts (fresh boot via "/", which re-runs the boot
      // gate and lands the single-server member back on /s/:id — a deep-link refresh gate is S11.1)
      // and the newest page is restored from the server, not from B's live-appended session state.
      await openedB.page.goto("/");
      await expect(openedB.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(openedB.page.getByText("chat-54", { exact: true })).toBeVisible({
        timeout: 5000,
      });
      await expect(openedB.page.getByText("chat-0", { exact: true })).toHaveCount(0);

      // Scrolling to the top triggers the older page load.
      await openedB.page.getByTestId("message-scroll").evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(openedB.page.getByText("chat-0", { exact: true })).toBeVisible({
        timeout: 5000,
      });
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });
});
