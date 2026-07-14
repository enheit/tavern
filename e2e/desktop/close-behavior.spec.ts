import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, expectServerReady, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

test.describe("desktop close behavior", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("defaults to the tray and can be changed to quit on close", async ({ api }) => {
    const user = await api.createUser("closepref");
    await api.createServer(user);
    const desktop = await launchDesktop({ instance: 0, user });

    await expect(desktop.page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });
    await desktop.page.evaluate((token) => window.tavern?.secrets.setToken(token), user.token);
    await desktop.page.goto(WEB_URL);
    await expectServerReady(desktop.page, 30_000);

    await desktop.page.getByTestId("sidebar-settings-button").click();
    await desktop.page.getByTestId("settings-tab-app").click();
    const toggle = desktop.page.getByTestId("settings-close-to-tray");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("data-checked", "");

    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect
      .poll(() =>
        desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      )
      .toBe(false);

    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await expect(desktop.page.getByTestId("settings-dialog")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-unchecked", "");

    const closed = desktop.app.waitForEvent("close");
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
  });
});
