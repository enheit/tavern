import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-03/04/05/06/07 settings persistence against the real local stack: live profile propagation via
// `member.update`, theme+language surviving a reload (localStorage mechanisms), and avatar upload
// (client resize → POST → R2) rendering in the People panel.

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const AVATAR_PNG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "avatar.png"),
);

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

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
}

test.describe("FR-03 FR-04 FR-05 FR-06 FR-07 settings persistence", () => {
  test("displayName + color changes propagate live to the other client's People/chat", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);
    const openedA = await pageFor(browser, baseURL, a);
    const openedB = await pageFor(browser, baseURL, b);
    try {
      await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
      await expect(openedB.page.getByTestId(`member-${a.userId}`)).toBeVisible();

      const newName = `Renamed-${hex(3)}`;
      await openSettings(openedA.page);
      await openedA.page.getByTestId("input-display-name").fill(newName);
      await openedA.page.getByTestId("swatch-#f87171").click();
      await openedA.page.getByTestId("settings-account-save").click();

      // The other client sees the new display name AND the new name color live (member.update).
      await expect(openedB.page.getByTestId(`member-name-${a.userId}`)).toHaveText(newName);
      await expect(openedB.page.getByTestId(`member-name-${a.userId}`)).toHaveCSS(
        "color",
        "rgb(248, 113, 113)",
      );
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("theme and language survive reload", async ({ browser, baseURL, api }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const opened = await pageFor(browser, baseURL, a);
    try {
      await bootOnto(opened, server.id);
      await openSettings(opened.page);
      await opened.page.getByTestId("settings-tab-app").click();

      await opened.page.getByTestId("theme-option-dark").click();
      await expect(opened.page.locator("html")).toHaveClass(/dark/);

      // Switching language re-keys the app (locale reload) which closes the dialog; the UI is now uk.
      await opened.page.getByTestId("settings-language").click();
      await opened.page.getByTestId("lang-option-uk").click();
      await expect(opened.page.getByText("Учасники", { exact: true })).toBeVisible();

      // Reload: theme (localStorage mirror) and language (Paraglide localStorage strategy) both stick.
      await opened.page.goto("/");
      await expect(opened.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(opened.page.locator("html")).toHaveClass(/dark/);
      await expect(opened.page.getByText("Учасники", { exact: true })).toBeVisible();
    } finally {
      await opened.context.close();
    }
  });

  test("uploaded avatar renders in People for both clients", async ({ browser, baseURL, api }) => {
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);
    const openedA = await pageFor(browser, baseURL, a);
    const openedB = await pageFor(browser, baseURL, b);
    try {
      await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);

      await openSettings(openedA.page);
      const upload = openedA.page.waitForResponse(
        (res) => res.url().endsWith("/api/me/avatar") && res.status() === 200,
      );
      await openedA.page.getByTestId("avatar-input").setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: AVATAR_PNG,
      });
      await upload;

      // The People avatar <img> only re-attempts its src on a fresh load, so both clients reload; the
      // now-stored webp then decodes (naturalWidth > 0) instead of falling back to the initial.
      await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
      const assertAvatarLoaded = async (opened: Opened): Promise<void> => {
        const img = opened.page.getByTestId(`avatar-img-${a.userId}`);
        await expect(img).toBeVisible();
        await expect
          .poll(() => img.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
          .toBeGreaterThan(0);
      };
      await Promise.all([assertAvatarLoaded(openedA), assertAvatarLoaded(openedB)]);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });
});
