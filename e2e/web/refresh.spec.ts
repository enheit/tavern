import { randomBytes } from "node:crypto";
import { expect, test } from "../harness/fixtures";
import { readTestIds, recordTestIds, uniquePageIds } from "../harness/testids";
import { WEB_URL } from "../playwright.config";

// FR-43 refresh gate (S11.1): a logged-in member sitting on /s/:serverId reloads the page and must
// see the boot loader, then the SAME server view with chat history — the login page must never
// attach, not even for a frame. The "content never renders before ready" invariant is unit-tested in
// S4.3 (boot.test.tsx); this spec is the integration proof against the real stack. The server view
// deliberately has no page-* test id, so the no-flash assertion is uniquePageIds === [] — any page-*
// (login/register/join) attaching during the reload is a gate regression.

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

test.describe("FR-43 refresh gate", () => {
  test("reload shows loader then same server view, login never flashes", async ({
    browser,
    baseURL,
    api,
  }) => {
    const user = await api.createUser("refresh");
    const server = await api.createServer(user);
    const context = await browser.newContext({
      baseURL: baseURL ?? WEB_URL,
      storageState: await user.request.storageState(),
    });
    const page = await context.newPage();
    try {
      // Arrange: land on the server view and put ≥1 message into history via the composer.
      await page.goto(`/s/${server.id}`);
      const text = `before-reload-${hex(4)}`;
      const input = page.getByTestId("composer-input");
      await input.fill(text);
      await input.press("Enter");
      await expect(page.getByText(text, { exact: true })).toBeVisible();

      // recordTestIds installs a MutationObserver via addInitScript, which applies to the NEXT
      // document — i.e. exactly the reload under test.
      await recordTestIds(page);
      await page.reload();

      // (b) The login page never appears during boot: poll for absence 20×100ms (pinned cadence).
      // Sequential by nature — each probe must observe a distinct moment of the boot window.
      let loginSeen = 0;
      let probe = Promise.resolve();
      for (let i = 0; i < 20; i++) {
        probe = probe
          .then(() => page.getByTestId("page-login").count())
          .then((count) => {
            loginSeen += count;
            return page.waitForTimeout(100);
          });
      }
      await probe;
      expect(loginSeen).toBe(0);

      // (c) Final state: same server view, history rendered.
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("composer-input")).toBeVisible();
      await expect(page.getByText(text, { exact: true })).toBeVisible();

      // (a) The boot loader attached before any route content, and no page-* ever attached (the
      // MutationObserver saw the whole boot — polling alone could miss a one-frame flash).
      const seen = await readTestIds(page);
      expect(seen).toContain("boot-loader");
      expect(uniquePageIds(seen)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("deep link direct load lands on server view", async ({ browser, baseURL, api }) => {
    const user = await api.createUser("deeplink");
    const server = await api.createServer(user);
    const context = await browser.newContext({
      baseURL: baseURL ?? WEB_URL,
      storageState: await user.request.storageState(),
    });
    const page = await context.newPage();
    try {
      // A FRESH navigation straight to the deep link (BrowserRouter + SPA fallback): under the
      // worker-served target this exercises the single-page-application not_found_handling.
      await recordTestIds(page);
      await page.goto(`/s/${server.id}`);

      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("composer-input")).toBeVisible();

      const seen = await readTestIds(page);
      expect(seen).toContain("boot-loader");
      expect(uniquePageIds(seen)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
