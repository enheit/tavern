import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

test.describe("desktop message reactions", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("two Electron users add, share, and remove reactions", async ({ api }, testInfo) => {
    test.setTimeout(120_000);

    const firstUser = await api.createUser("dreactiona");
    const server = await api.createServer(firstUser);
    const secondUser = await api.createUser("dreactionb");
    await api.join(secondUser, server.nickname);

    const [first, second] = await Promise.all([
      launchDesktop({ instance: 0, user: firstUser }),
      launchDesktop({ instance: 1, user: secondUser }),
    ]);

    await Promise.all([
      first.page.evaluate((token) => window.tavern?.secrets.setToken(token), firstUser.token),
      second.page.evaluate((token) => window.tavern?.secrets.setToken(token), secondUser.token),
    ]);
    await Promise.all([
      first.page.goto(`${WEB_URL}/s/${server.id}`),
      second.page.goto(`${WEB_URL}/s/${server.id}`),
    ]);
    await Promise.all([
      expect(first.page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 }),
      expect(second.page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 }),
    ]);

    const text = "Electron reaction check";
    await first.page.getByTestId("composer-input").fill(text);
    await first.page.getByTestId("composer-input").press("Enter");

    const firstRow = first.page.locator("[data-message-id]").filter({ hasText: text });
    const secondRow = second.page.locator("[data-message-id]").filter({ hasText: text });
    await expect(secondRow).toBeVisible({ timeout: 3_000 });
    const messageId = await firstRow.getAttribute("data-message-id");
    if (messageId === null) throw new Error("reaction source id missing");

    await firstRow.hover();
    await first.page.getByTestId(`add-reaction-${messageId}`).click();
    const visibleEmoji = first.page.locator('[data-slot="emoji-picker-emoji"]:visible');
    await expect(visibleEmoji.first()).toBeVisible({ timeout: 15_000 });
    await first.page.screenshot({ path: testInfo.outputPath("electron-reaction-picker.png") });

    const firstEmoji = ((await visibleEmoji.nth(0).textContent()) ?? "").trim();
    const secondEmoji = ((await visibleEmoji.nth(1).textContent()) ?? "").trim();
    if (firstEmoji.length === 0 || secondEmoji.length === 0 || firstEmoji === secondEmoji) {
      throw new Error("the picker did not expose two distinct emoji");
    }
    await visibleEmoji.nth(0).click();

    const firstReactionId = `reaction-${messageId}-${firstEmoji}`;
    const firstReactionA = first.page.getByTestId(firstReactionId);
    const firstReactionB = second.page.getByTestId(firstReactionId);
    await expect(firstReactionA).toContainText("1");
    await expect(firstReactionB).toContainText("1");

    await firstRow.hover();
    await first.page.getByTestId(`add-reaction-${messageId}`).click();
    await expect(visibleEmoji.nth(1)).toBeVisible({ timeout: 15_000 });
    await visibleEmoji.nth(1).click();
    const secondReactionId = `reaction-${messageId}-${secondEmoji}`;
    await expect(first.page.getByTestId(secondReactionId)).toContainText("1");
    await expect(second.page.getByTestId(secondReactionId)).toContainText("1");

    await firstReactionB.click();
    await expect(firstReactionA).toContainText("2");
    await expect(firstReactionB).toContainText("2");
    await first.page.screenshot({ path: testInfo.outputPath("electron-reactions-shared.png") });

    await firstReactionA.click();
    await expect(firstReactionA).toContainText("1");
    await expect(firstReactionA).toHaveAttribute("aria-pressed", "false");
    await expect(firstReactionB).toHaveAttribute("aria-pressed", "true");
    await expect(first.page.getByTestId(secondReactionId)).toContainText("1");
  });
});
