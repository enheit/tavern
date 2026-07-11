import type { Browser } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-02 auth route guards: an already-authenticated account may only sit on its server (or /join when
// it has none). GuestOnlyLayout bounces it off /login + /register; RequireNoServerLayout bounces it
// off /join once it has a server. Drives the real local stack (wrangler dev + Vite) with the user's
// session cookie transferred into a browser context, exactly like servers.spec.ts.

async function pageFor(browser: Browser, baseURL: string | undefined, user: SeededUser) {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("auth route guards", () => {
  test("account WITH a server is bounced off /login, /register AND /join to /s/:id", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const { context, page } = await pageFor(browser, baseURL, a);
    try {
      const onServer = new RegExp(`/s/${server.id}$`);
      for (const route of ["/login", "/register", "/join"]) {
        await page.goto(route);
        await expect(page, `cold-load ${route} must redirect to the server`).toHaveURL(onServer);
      }
    } finally {
      await context.close();
    }
  });

  test("account WITHOUT a server is bounced off /login + /register to /join, but may stay on /join", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a"); // registered, zero joined servers
    const { context, page } = await pageFor(browser, baseURL, a);
    try {
      for (const route of ["/login", "/register"]) {
        await page.goto(route);
        await expect(page, `cold-load ${route} must redirect to /join`).toHaveURL(/\/join$/);
        await expect(page.getByTestId("page-join")).toBeAttached();
      }
      // /join is the one place a server-less account belongs — it must NOT bounce.
      await page.goto("/join");
      await expect(page).toHaveURL(/\/join$/);
      await expect(page.getByTestId("page-join")).toBeAttached();
    } finally {
      await context.close();
    }
  });
});
