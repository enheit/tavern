import { randomBytes } from "node:crypto";
import type { Browser } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-08 / FR-09 / FR-41 / FR-45 server create / join / switch UI against the real local stack
// (wrangler dev + Vite; the SFU is not exercised here). Users are seeded through the `api` fixture
// and their session cookie is transferred into a browser context, exactly like the shared
// `twoContexts` fixture — every assertion drives the real /join page, header switcher and People panel.

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const serverNickname = (): string => `srv-${hex(4)}`; // [a-z0-9-]{3,32}
const serverPassword = (): string => `pw-${hex(4)}`; // ≥4 chars

// A logged-in browser page for a seeded user (web = same-origin session cookie).
async function pageFor(browser: Browser, baseURL: string | undefined, user: SeededUser) {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("FR-08 FR-09 FR-41 FR-45 servers", () => {
  test("A creates a server, lands on /s/:id, sees self in People", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const { context, page } = await pageFor(browser, baseURL, a);
    try {
      // Zero servers → the boot gate lands the fresh account on /join.
      await page.goto("/");
      await expect(page).toHaveURL(/\/join$/);

      await page.getByTestId("create-nickname").fill(serverNickname());
      await page.getByTestId("create-submit").click();

      await expect(page).toHaveURL(/\/s\/[0-9a-f-]+$/);
      await expect(page.getByTestId("app-shell")).toBeVisible();
      // The creator is a member (admin) — the People panel shows them with their displayName (= username).
      await expect(page.getByTestId(`member-${a.userId}`)).toBeVisible();
      await expect(page.getByTestId(`member-name-${a.userId}`)).toHaveText(a.username);
    } finally {
      await context.close();
    }
  });

  test("B joins by nickname+password and appears in A's People live", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const password = serverPassword();
    const server = await api.createServer(a, { password });

    const openedByA = await pageFor(browser, baseURL, a);
    const b = await api.createUser("b");
    const openedByB = await pageFor(browser, baseURL, b);
    try {
      // A boots into the freshly-created server and sees themselves; B is not a member yet.
      await openedByA.page.goto("/");
      await expect(openedByA.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(openedByA.page.getByTestId(`member-${a.userId}`)).toBeVisible();
      await expect(openedByA.page.getByTestId(`member-${b.userId}`)).toHaveCount(0);

      // B joins via the /join card with the exact nickname + password.
      await openedByB.page.goto("/join");
      await openedByB.page.getByTestId("join-nickname").fill(server.nickname);
      await openedByB.page.getByTestId("join-password").fill(password);
      await openedByB.page.getByTestId("join-submit").click();
      await expect(openedByB.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(openedByB.page.getByTestId(`member-${b.userId}`)).toBeVisible();

      // Live (member.joined broadcast, no reload): A's People panel gains B.
      await expect(openedByA.page.getByTestId(`member-${b.userId}`)).toBeVisible();
    } finally {
      await openedByA.context.close();
      await openedByB.context.close();
    }
  });

  test("wrong password shows error and does not join", async ({ browser, baseURL, api }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a, { password: serverPassword() });

    const b = await api.createUser("b");
    const { context, page } = await pageFor(browser, baseURL, b);
    try {
      await page.goto("/join");
      await page.getByTestId("join-nickname").fill(server.nickname);
      await page.getByTestId("join-password").fill("definitely-the-wrong-password");
      await page.getByTestId("join-submit").click();

      // The join card surfaces the server ErrorCode in its form-level slot; no navigation happens.
      await expect(page.getByTestId("join-error")).toBeVisible();
      await expect(page).toHaveURL(/\/join$/);
    } finally {
      await context.close();
    }
  });

  test("A switches between two servers; shell renders each server's name and members", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const alpha = await api.createServer(a);
    const bravo = await api.createServer(a);
    // B is a member of bravo only — so the two servers have distinct member lists.
    const b = await api.createUser("b");
    await api.join(b, bravo.nickname);

    const { context, page } = await pageFor(browser, baseURL, a);
    try {
      await page.goto("/");
      await expect(page.getByTestId("app-shell")).toBeVisible();

      // Switch to alpha: header shows alpha's name; only A is a member.
      await page.getByTestId("server-switcher").click();
      await page.getByTestId(`server-item-${alpha.id}`).click();
      await expect(page).toHaveURL(new RegExp(`/s/${alpha.id}$`));
      await expect(page.getByTestId("active-server-name")).toHaveText(alpha.nickname);
      await expect(page.getByTestId(`member-${a.userId}`)).toBeVisible();
      await expect(page.getByTestId(`member-${b.userId}`)).toHaveCount(0);

      // Switch to bravo: header shows bravo's name; both A and B are members (state preserved per server).
      await page.getByTestId("server-switcher").click();
      await page.getByTestId(`server-item-${bravo.id}`).click();
      await expect(page).toHaveURL(new RegExp(`/s/${bravo.id}$`));
      await expect(page.getByTestId("active-server-name")).toHaveText(bravo.nickname);
      await expect(page.getByTestId(`member-${a.userId}`)).toBeVisible();
      await expect(page.getByTestId(`member-${b.userId}`)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
