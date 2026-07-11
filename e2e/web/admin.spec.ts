import { randomBytes } from "node:crypto";
import type { Browser } from "@playwright/test";
import { expect, expectMemberVisible, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-10 / FR-11 / FR-12 admin UI against the real local stack (wrangler dev + Vite; SFU not used).
// Three roles: A = admin, B = existing member, C = a fresh non-member. Users are seeded through the
// `api` fixture and their session cookie is transferred into a browser context (web = same-origin
// cookie), exactly like servers.spec.ts.

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const serverNickname = (): string => `srv-${hex(4)}`; // [a-z0-9-]{3,32}
const serverPassword = (): string => `pw-${hex(4)}`; // ≥4 chars

async function pageFor(browser: Browser, baseURL: string | undefined, user: SeededUser) {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("FR-10 FR-11 FR-12 admin e2e", () => {
  test("rename: A renames, B header shows new name without reload", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);

    const admin = await pageFor(browser, baseURL, a);
    const member = await pageFor(browser, baseURL, b);
    try {
      await admin.page.goto("/");
      await expect(admin.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await member.page.goto("/");
      await expect(member.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(member.page.getByTestId("active-server-name")).toHaveText(server.nickname);

      // A opens the admin dialog (the gear is admin-only) and renames the server.
      await admin.page.getByTestId("admin-settings-button").click();
      await expect(admin.page.getByTestId("admin-dialog")).toBeVisible();
      const renamed = serverNickname();
      await admin.page.getByTestId("admin-nickname-input").fill(renamed);
      await admin.page.getByTestId("admin-rename-submit").click();

      // FR-12 AC: B sees the new name live via the `server.updated` broadcast — no reload.
      await expect(member.page.getByTestId("active-server-name")).toHaveText(renamed);
    } finally {
      await admin.context.close();
      await member.context.close();
    }
  });

  test("password: A sets password, C join fails without and succeeds with it", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a); // open server initially
    const c = await api.createUser("c");

    const admin = await pageFor(browser, baseURL, a);
    const fresh = await pageFor(browser, baseURL, c);
    try {
      await admin.page.goto("/");
      await expect(admin.page).toHaveURL(new RegExp(`/s/${server.id}$`));

      // A sets a password; wait for the PATCH so the next join sees it (FR-10 AC: next join attempt).
      const password = serverPassword();
      await admin.page.getByTestId("admin-settings-button").click();
      await admin.page.getByTestId("admin-password-input").fill(password);
      const patched = admin.page.waitForResponse(
        (r) =>
          r.url().includes(`/api/servers/${server.id}`) &&
          r.request().method() === "PATCH" &&
          r.status() === 200,
      );
      await admin.page.getByTestId("admin-password-set").click();
      await patched;

      // C joins without a password → rejected, no navigation.
      await fresh.page.goto("/join");
      await fresh.page.getByTestId("join-nickname").fill(server.nickname);
      await fresh.page.getByTestId("join-submit").click();
      await expect(fresh.page.getByTestId("join-error")).toBeVisible();
      await expect(fresh.page).toHaveURL(/\/join$/);

      // C joins with the correct password → succeeds.
      await fresh.page.getByTestId("join-password").fill(password);
      await fresh.page.getByTestId("join-submit").click();
      await expect(fresh.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectMemberVisible(fresh.page, c.userId);
    } finally {
      await admin.context.close();
      await fresh.context.close();
    }
  });

  test("kick: A kicks B, B lands on /join with toast, B rejoins using password", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const password = serverPassword();
    const server = await api.createServer(a, { password });
    const b = await api.createUser("b");
    await api.join(b, server.nickname, password);

    const admin = await pageFor(browser, baseURL, a);
    const member = await pageFor(browser, baseURL, b);
    try {
      await admin.page.goto("/");
      await expect(admin.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await member.page.goto("/");
      await expect(member.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectMemberVisible(member.page, b.userId);

      // A kicks B via the admin dialog's Members section (confirm required).
      await admin.page.getByTestId("admin-settings-button").click();
      await expect(admin.page.getByTestId("admin-dialog")).toBeVisible();
      await admin.page.getByTestId(`admin-kick-${b.userId}`).click();
      await expect(admin.page.getByTestId("kick-confirm")).toBeVisible();
      await admin.page.getByTestId("kick-confirm-action").click();

      // FR-11 AC: B's socket closes (4001) → the UI returns to /join with a toast.
      await expect(member.page).toHaveURL(/\/join$/);
      await expect(member.page.getByText(/kicked/i)).toBeVisible();

      // B rejoins with the password (required). A fresh boot gives B a clean room store (the deep-link
      // refresh gate itself is S11.1's scope; goto is the established fresh-boot technique, S6.1).
      await member.page.goto("/join");
      await member.page.getByTestId("join-nickname").fill(server.nickname);
      await member.page.getByTestId("join-password").fill(password);
      await member.page.getByTestId("join-submit").click();
      await expect(member.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectMemberVisible(member.page, b.userId);
    } finally {
      await admin.context.close();
      await member.context.close();
    }
  });
});
