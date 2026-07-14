import { MarketItemResponse } from "@tavern/shared";
import { expect, test } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// Two 1×1 frames with a Netscape loop extension. The Worker must retain both frames, normalize the
// canvas to 48×48 WebP, and rewrite the ANIM loop count to zero (the infinite sentinel).
const ANIMATED_GIF = Buffer.from(
  "R0lGODlhCAAIAPAAAP8AAAAAACH5BAAKAAAALAAAAAAIAAgAAAIHhI+py+1dAAAh+QQACgAAACwAAAAACAAIAIAAAP8AAAACB4SPqcvtXQAAOw==",
  "base64",
);

function webpLoopCount(bytes: Buffer): number | null {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > bytes.length) return null;
    if (name === "ANIM") return size >= 6 ? bytes.readUInt16LE(payload + 4) : null;
    offset = payload + size + (size % 2);
  }
  return null;
}

test.describe("one-of-one icon market", () => {
  test("admin lists an icon, a member buys and wears it, then removes it from their profile", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    const admin = await api.createUser("madmin");
    const server = await api.createServer(admin);
    const buyer = await api.createUser("mbuyer");
    await api.join(buyer, server.nickname);
    await api.seedPoints(buyer, server.id, 100);

    const target = baseURL ?? WEB_URL;
    const adminContext = await browser.newContext({
      baseURL: target,
      storageState: await admin.request.storageState(),
    });
    const buyerContext = await browser.newContext({
      baseURL: target,
      storageState: await buyer.request.storageState(),
    });
    const adminPage = await adminContext.newPage();
    const buyerPage = await buyerContext.newPage();
    try {
      await Promise.all([adminPage.goto(`/s/${server.id}`), buyerPage.goto(`/s/${server.id}`)]);
      await expect(adminPage.getByTestId("workspace-tab-market")).toBeVisible();
      await expect(buyerPage.getByTestId("points-balance")).toHaveText("100");

      await adminPage.getByTestId("workspace-tab-market").click();
      await adminPage.getByTestId("market-subtab-manage").click();
      await adminPage.getByTestId("market-manage-name").fill("Founder's fox");
      await adminPage.getByTestId("market-manage-price").fill("40");
      await adminPage.getByTestId("market-manage-file").setInputFiles({
        name: "fox.gif",
        mimeType: "image/gif",
        buffer: ANIMATED_GIF,
      });
      await expect(
        adminPage.getByTestId("market-tab").getByText(admin.username, { exact: true }),
      ).toBeVisible();
      const uploaded = adminPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/servers/${server.id}/market`) &&
          response.request().method() === "POST",
      );
      await adminPage.getByTestId("market-manage-submit").click();
      const uploadResponse = await uploaded;
      expect(uploadResponse.status()).toBe(201);
      const created = MarketItemResponse.parse(await uploadResponse.json()).item;
      const storedIcon = await buyer.request.get(
        `/api/media/market-icons/${server.id}/${created.id}.webp`,
      );
      expect(storedIcon.ok()).toBe(true);
      expect(storedIcon.headers()["content-type"]).toContain("image/webp");
      expect(webpLoopCount(await storedIcon.body())).toBe(0);

      await buyerPage.getByTestId("workspace-tab-market").click();
      const listing = buyerPage.getByTestId(`market-item-${created.id}`);
      await expect(listing).toContainText("Founder's fox");
      await expect(listing).toContainText("40 points");
      await listing.getByRole("button", { name: "Purchase" }).click();
      await expect(
        buyerPage.getByRole("heading", { name: "Purchase Founder's fox?" }),
      ).toBeVisible();
      await buyerPage.getByTestId("market-wear-immediately").check();
      const purchased = buyerPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/market/${created.id}/purchase`) &&
          response.request().method() === "POST",
      );
      await buyerPage.getByRole("button", { name: "Purchase", exact: true }).last().click();
      expect((await purchased).status()).toBe(200);
      await expect(buyerPage.getByTestId("points-balance")).toHaveText("60");
      await expect(buyerPage.getByTestId("sidebar-profile-name").locator("img")).toHaveAttribute(
        "src",
        new RegExp(`/market-icons/${server.id}/${created.id}\\.webp$`),
      );

      await adminPage.getByTestId("market-subtab-shop").click();
      const soldListing = adminPage.getByTestId(`market-item-${created.id}`);
      await expect(soldListing).toContainText("Owned by");
      await expect(soldListing.getByRole("button", { name: "Sold" })).toBeDisabled();

      await buyerPage.getByTestId("workspace-tab-dashboard").click();
      await buyerPage.getByTestId(`home-member-name-${buyer.userId}`).click();
      const receiptIcon = buyerPage.getByTestId("user-profile-market-icon");
      await expect(receiptIcon).toBeVisible();
      await expect(receiptIcon.locator("xpath=..")).toHaveAttribute(
        "aria-label",
        /Purchased .* for 40 points/,
      );
      await buyerPage.keyboard.press("Escape");

      await buyerPage.getByTestId("workspace-tab-market").click();
      await buyerPage.getByTestId("market-subtab-owned").click();
      await expect(buyerPage.getByTestId(`market-owned-${created.id}`)).toContainText("Wearing");
      await buyerPage
        .getByTestId("market-icon-picker")
        .screenshot({ path: testInfo.outputPath("owned-market-icon.png") });
      await buyerPage.getByTestId("market-owned-none").click();
      await expect(buyerPage.getByTestId("sidebar-profile-name").locator("img")).toHaveCount(0);
    } finally {
      await Promise.all([adminContext.close(), buyerContext.close()]);
    }
  });
});
