import type { Browser } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

async function pageFor(browser: Browser, baseURL: string | undefined, user: SeededUser) {
  const context = await browser.newContext({
    baseURL: baseURL ?? WEB_URL,
    storageState: await user.request.storageState(),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("server points", () => {
  test("renders beside GIF and applies admin rate changes live", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    const admin = await api.createUser("p");
    const server = await api.createServer(admin);
    const opened = await pageFor(browser, baseURL, admin);
    try {
      await opened.page.goto("/");
      await expect(opened.page).toHaveURL(new RegExp(`/s/${server.id}$`));

      const composer = opened.page.getByTestId("composer-input");
      const gif = opened.page.getByTestId("composer-gif");
      const points = opened.page.getByTestId("points-trigger");
      await expect(composer).toBeVisible();
      await expect(gif).toBeVisible();
      await expect(points).toBeVisible();
      await expect(opened.page.getByTestId("points-balance")).toHaveText("0");
      await expect(points).not.toContainText("Join voice");

      const [gifBox, pointsBox] = await Promise.all([gif.boundingBox(), points.boundingBox()]);
      expect(gifBox).not.toBeNull();
      expect(pointsBox).not.toBeNull();
      if (gifBox === null || pointsBox === null)
        throw new Error("composer action boxes unavailable");
      expect(pointsBox.x).toBeGreaterThanOrEqual(gifBox.x + gifBox.width);
      expect(pointsBox.y).toBe(gifBox.y);

      await opened.page.getByTestId("points-trigger").click();
      await expect(opened.page.getByTestId("points-details")).toBeVisible();

      await opened.page.getByTestId("admin-settings-button").click();
      await opened.page.getByTestId("admin-points-base").fill("7");
      await opened.page.getByTestId("admin-points-stream").fill("9");
      await opened.page.getByTestId("admin-points-watch").fill("11");
      await opened.page.getByTestId("admin-points-cap").fill("500");
      const saved = opened.page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/servers/${server.id}/points/config`) &&
          response.request().method() === "PUT" &&
          response.status() === 200,
      );
      await opened.page.getByTestId("admin-points-save").click();
      await saved;

      await opened.page.reload();
      await opened.page.getByTestId("admin-settings-button").click();
      await expect(opened.page.getByTestId("admin-points-base")).toHaveValue("7");
      await expect(opened.page.getByTestId("admin-points-stream")).toHaveValue("9");
      await expect(opened.page.getByTestId("admin-points-watch")).toHaveValue("11");
      await expect(opened.page.getByTestId("admin-points-cap")).toHaveValue("500");

      await opened.page.keyboard.press("Escape");
      await opened.page
        .getByTestId("composer")
        .screenshot({ path: testInfo.outputPath("points-composer.png") });
    } finally {
      await opened.context.close();
    }
  });
});
