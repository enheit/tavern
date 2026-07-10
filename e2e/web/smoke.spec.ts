import { expect, test } from "../harness/fixtures";
import { readTestIds, recordTestIds, uniquePageIds } from "../harness/testids";

// FR-43 (web, smoke level): a cold load shows the single global boot-loader and lands on the login
// page — never flashing any other page-* state. (No language-switch assertion: the login page has no
// locale control at this milestone; the Settings language select is e2e-tested in S6.2.)
test.describe("FR-43 web smoke", () => {
  test("cold load reaches page-login through boot-loader with no page flash", async ({ page }) => {
    await recordTestIds(page);
    await page.goto("/");

    // The login page is a placeholder empty div at this milestone (real auth UI lands in S5.1), so
    // it has no bounding box yet — assert it ATTACHED, not visible.
    await expect(page.getByTestId("page-login")).toBeAttached();

    const seen = await readTestIds(page);
    expect(seen).toContain("boot-loader");
    expect(uniquePageIds(seen)).toEqual(["page-login"]);
  });
});
