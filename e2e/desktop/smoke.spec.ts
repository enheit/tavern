import { closeAll, launchDesktop } from "../harness/desktop";
import { expect, test } from "../harness/fixtures";
import { readTestIds, recordTestIds, uniquePageIds } from "../harness/testids";

// FR-43 (desktop, smoke level): the packaged renderer boots exactly like the web build — window
// titled Tavern, single boot-loader, lands on login — and two instances can run at once because the
// single-instance lock is skipped under TAVERN_E2E (§10).
test.describe("FR-43 desktop smoke", () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test("launches to page-login through boot-loader with no page flash", async () => {
    const { page } = await launchDesktop({ instance: 0 });

    // Placeholder pages are empty divs (no bounding box) until S5.1 — assert ATTACHED, not visible.
    await expect(page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });
    expect(await page.title()).toBe("Tavern");

    // FR-43 covers launch AND refresh: re-boot with the recorder installed so the transient loader is
    // captured deterministically (addInitScript applies to the reload).
    await recordTestIds(page);
    await page.reload();
    await expect(page.getByTestId("page-login")).toBeAttached();

    const seen = await readTestIds(page);
    expect(seen).toContain("boot-loader");
    expect(uniquePageIds(seen)).toEqual(["page-login"]);
  });

  test("two instances launch concurrently with separate userData", async () => {
    const first = await launchDesktop({ instance: 0 });
    const second = await launchDesktop({ instance: 1 });

    await expect(first.page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });
    await expect(second.page.getByTestId("page-login")).toBeAttached({ timeout: 30_000 });
  });
});
