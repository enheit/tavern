import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, test } from "../harness/fixtures";

test.describe("FR-06 desktop live system theme", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("a desktop renderer restart keeps following system color-scheme changes", async () => {
    const { page } = await launchDesktop({ instance: 0 });
    await expect(page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });

    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => localStorage.setItem("tavern.theme", "system"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });
});
