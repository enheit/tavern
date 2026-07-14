import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import {
  expect,
  expectMemberVisible,
  expectServerReady,
  test,
  withDashboardMembers,
} from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-03/04/05/06/07 settings persistence against the real local stack: live profile propagation via
// `member.update`, theme+language surviving a reload (localStorage mechanisms), and avatar upload
// (client resize → POST → R2) rendering on Dashboard.

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
  await expectServerReady(opened.page);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("sidebar-settings-button").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
}

async function openAccountSettings(page: Page): Promise<void> {
  await page.getByTestId("sidebar-profile-name").click();
  await expect(page.getByTestId("account-settings-dialog")).toBeVisible();
}

test.describe("FR-03 FR-04 FR-05 FR-06 FR-07 settings persistence", () => {
  test("displayName + color changes propagate live to the other client's Dashboard/chat", async ({
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
      await expectMemberVisible(openedB.page, a.userId);

      const newName = `Renamed-${hex(3)}`;
      await openAccountSettings(openedA.page);
      await openedA.page.getByTestId("input-display-name").fill(newName);
      await openedA.page.getByTestId("swatch-#f87171").click();
      await openedA.page.getByTestId("settings-account-save").click();
      await expect(openedA.page.getByTestId("account-settings-dialog")).toBeHidden();
      await expect(openedA.page.getByTestId("sidebar-profile-name")).toHaveCSS(
        "color",
        "rgb(248, 113, 113)",
      );

      // The other client sees the new display name AND color live on Dashboard (member.update).
      await withDashboardMembers(openedB.page, async () => {
        await expect(openedB.page.getByTestId(`home-member-name-${a.userId}`)).toHaveText(newName);
        await expect(openedB.page.getByTestId(`home-member-name-${a.userId}`)).toHaveCSS(
          "color",
          "rgb(248, 113, 113)",
        );
      });
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

  test("uploaded avatar renders on Dashboard for both clients", async ({
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

      await openAccountSettings(openedA.page);
      const upload = openedA.page.waitForResponse(
        (res) => res.url().endsWith("/api/me/avatar") && res.status() === 200,
      );
      await openedA.page.getByTestId("avatar-input").setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: AVATAR_PNG,
      });
      await upload;

      // The Dashboard avatar <img> only re-attempts its src on a fresh load, so both clients reload;
      // now-stored webp then decodes (naturalWidth > 0) instead of falling back to the initial.
      await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
      const assertAvatarLoaded = async (opened: Opened): Promise<void> => {
        // Assert the uploaded image while the Dashboard member list is active.
        await withDashboardMembers(opened.page, async () => {
          const img = opened.page.getByTestId(`home-member-avatar-${a.userId}`);
          await expect(img).toBeVisible();
          await expect
            .poll(() =>
              img.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)),
            )
            .toBeGreaterThan(0);
        });
      };
      await Promise.all([assertAvatarLoaded(openedA), assertAvatarLoaded(openedB)]);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("custom voice avatar saves, reloads, and renders live for another member", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    const a = await api.createUser("voiceavatar");
    const server = await api.createServer(a);
    const b = await api.createUser("observer");
    await api.join(b, server.nickname);
    const openedA = await pageFor(browser, baseURL, a);
    const openedB = await pageFor(browser, baseURL, b);
    try {
      await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
      await openedA.page.setViewportSize({ width: 1440, height: 1200 });
      await openAccountSettings(openedA.page);
      await expect(openedA.page.getByTestId("voice-avatar-preview")).toHaveAttribute(
        "data-renderer",
        "ready",
      );
      await openedA.page.getByTestId("voice-avatar-skin-ebony").click();
      await openedA.page.getByTestId("voice-avatar-hair-color-ginger").click();
      await openedA.page.getByTestId("voice-avatar-hair-style-wavy").click();
      await openedA.page.getByTestId("voice-avatar-eye-color-green").click();
      await openedA.page.getByTestId("voice-avatar-glasses-aviator").click();
      await openedA.page.getByTestId("voice-avatar-facial-hair-mustache").click();
      await openedA.page.getByTestId("voice-avatar-outfit-#1e3a8a").click();
      await openedA.page.getByTestId("settings-account-save").click();
      await expect(openedA.page.getByTestId("account-settings-dialog")).toBeHidden();

      await bootOnto(openedA, server.id);
      await openAccountSettings(openedA.page);
      await expect(openedA.page.getByTestId("voice-avatar-skin-ebony")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(openedA.page.getByTestId("voice-avatar-hair-color-ginger")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(openedA.page.getByTestId("voice-avatar-hair-style-wavy")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(openedA.page.getByTestId("voice-avatar-eye-color-green")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(openedA.page.getByTestId("voice-avatar-glasses-aviator")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(openedA.page.getByTestId("voice-avatar-facial-hair-mustache")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const editorScreenshotPath = testInfo.outputPath("voice-avatar-editor.png");
      await openedA.page
        .getByTestId("account-settings-dialog")
        .screenshot({ path: editorScreenshotPath });
      await testInfo.attach("voice-avatar-editor", {
        path: editorScreenshotPath,
        contentType: "image/png",
      });
      await openedA.page.keyboard.press("Escape");
      await expect(openedA.page.getByRole("dialog", { name: "Account Settings" })).toBeHidden();

      // Roster membership is enough to render the lounge; the mock SFU intentionally has no media
      // plane, so this visual test does not wait for its PeerConnection to become connected.
      await openedA.page.getByTestId("channel-voice").click();
      const avatar = openedB.page.getByTestId(`voice-avatar-tile-${a.userId}`);
      await expect(avatar).toBeVisible({ timeout: 10_000 });
      await expect(avatar).toHaveAttribute("data-avatar-mode", "custom");
      await expect(avatar).toHaveAttribute("data-renderer", "ready", { timeout: 10_000 });
      const screenshotPath = testInfo.outputPath("custom-voice-avatar.png");
      await avatar.screenshot({ path: screenshotPath });
      await testInfo.attach("custom-voice-avatar", {
        path: screenshotPath,
        contentType: "image/png",
      });
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("settings sidebar keeps logout separate from independently scrolling content", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("logout");
    const server = await api.createServer(a);
    const opened = await pageFor(browser, baseURL, a);
    try {
      await bootOnto(opened, server.id);
      await expect(opened.page.getByTestId("sidebar-profile-name")).toHaveText(a.username);
      await openSettings(opened.page);
      await expect(opened.page.getByTestId("settings-sidebar-scroll")).toBeVisible();
      await expect(opened.page.getByTestId("settings-content-scroll")).toBeVisible();
      await opened.page.getByTestId("settings-logout").click();
      await expect(opened.page).toHaveURL(/\/login$/);
      await expect(opened.page.getByTestId("page-login")).toBeVisible();
    } finally {
      await opened.context.close();
    }
  });

  test("settings shows a themed selected tab and only renders a scrollbar for overflowing content", async ({
    browser,
    baseURL,
    api,
  }) => {
    const a = await api.createUser("tabs");
    const server = await api.createServer(a);
    const opened = await pageFor(browser, baseURL, a);
    try {
      await bootOnto(opened, server.id);
      await openSettings(opened.page);

      const appTab = opened.page.getByTestId("settings-tab-app");
      const notificationsTab = opened.page.getByTestId("settings-tab-notifications");
      const sidebar = opened.page.getByTestId("settings-sidebar-scroll");
      const content = opened.page.getByTestId("settings-content-scroll");
      const verticalScrollbar = '[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]';

      await opened.page.getByTestId("theme-option-light").click();
      await expect(opened.page.locator("html")).not.toHaveClass(/dark/);
      await expect(appTab).toHaveAttribute("data-active");
      await expect(sidebar.locator(verticalScrollbar)).toHaveCount(0);
      await expect(content.locator(verticalScrollbar)).toHaveCount(0);

      const lightTabColors = await Promise.all([
        appTab.evaluate((element) => getComputedStyle(element).backgroundColor),
        notificationsTab.evaluate((element) => getComputedStyle(element).backgroundColor),
      ]);
      expect(lightTabColors[0]).not.toBe(lightTabColors[1]);
      expect(await appTab.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe(
        "0",
      );

      await notificationsTab.click();
      await expect(notificationsTab).toHaveAttribute("data-active");
      await expect(content.locator(verticalScrollbar)).toHaveCount(0);

      await opened.page.getByTestId("settings-tab-tavern-usage").click();
      await expect(opened.page.getByTestId("settings-cloudflare-usage")).toBeVisible();
      await expect(content.locator(verticalScrollbar)).toHaveCount(1);
      const overflow = await content
        .locator('[data-slot="scroll-area-viewport"]')
        .evaluate((viewport) => viewport.scrollHeight - viewport.clientHeight);
      expect(overflow).toBeGreaterThan(0);

      await appTab.click();
      await opened.page.getByTestId("theme-option-dark").click();
      await expect(opened.page.locator("html")).toHaveClass(/dark/);
      const darkTabColors = await Promise.all([
        appTab.evaluate((element) => getComputedStyle(element).backgroundColor),
        notificationsTab.evaluate((element) => getComputedStyle(element).backgroundColor),
      ]);
      expect(darkTabColors[0]).not.toBe(darkTabColors[1]);
      expect(darkTabColors[0]).not.toBe(lightTabColors[0]);
    } finally {
      await opened.context.close();
    }
  });
});
