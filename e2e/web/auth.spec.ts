import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";

// FR-01 / FR-02 auth flow against the real local stack (wrangler dev + Vite, mocked SFU not needed
// here). The register form drives useAuth → the boot gate → /join; a fresh navigation re-boots from
// the persisted session cookie; clearing the session returns to /login.

const uniqueName = (): string => `u_${randomBytes(4).toString("hex")}`; // [a-z0-9_]{3,20}
const password = (): string => `pw${randomBytes(5).toString("hex")}`; // ≥8 chars

async function registerViaUi(page: Page, username: string, pw: string): Promise<void> {
  await page.goto("/register");
  await page.getByTestId("input-username").fill(username);
  await page.getByTestId("input-password").fill(pw);
  await page.getByTestId("input-repeat-password").fill(pw);
  await page.getByTestId("submit").click();
}

test.describe("FR-01 FR-02 auth", () => {
  test("register lands on /join (first run, no servers)", async ({ page }) => {
    await registerViaUi(page, uniqueName(), password());
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByTestId("page-join")).toBeAttached();
  });

  test("reload restores session without re-login", async ({ page }) => {
    await registerViaUi(page, uniqueName(), password());
    await expect(page).toHaveURL(/\/join$/);

    // Full document reload, then a fresh navigation to "/" that re-runs the boot gate: the persisted
    // session cookie must re-authenticate (0 servers → /join), never bouncing to /login.
    await page.reload();
    await page.goto("/");
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByTestId("page-join")).toBeAttached();
  });

  test("logout returns to /login", async ({ page }) => {
    await registerViaUi(page, uniqueName(), password());
    await expect(page).toHaveURL(/\/join$/);

    // Drive logout at the session level: end the
    // browser session (what useAuth.logout does via sign-out + authTransport.clear — that client wiring
    // is unit-tested) and assert the boot gate then routes to /login on the next navigation.
    await page.context().clearCookies();

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("page-login")).toBeVisible();
  });

  test("wrong password shows a readable error and stays on /login", async ({ page, api }) => {
    const user = await api.createUser("wrongpw"); // exists in D1; browser page stays unauthed

    await page.goto("/login");
    await page.getByTestId("input-username").fill(user.username);
    await page.getByTestId("input-password").fill("definitely-the-wrong-password");
    await page.getByTestId("submit").click();

    // A single form-level error (generic — no field is singled out as wrong), and no navigation away.
    // The message must be a READABLE remapped error, never the old generic `bad_message` fallback
    // ("That message couldn't be sent" / "Не вдалося надіслати повідомлення") that leaked when the
    // better-auth error body couldn't be mapped. A fresh worker (CI) returns 401 → wrong-credentials;
    // on localhost every sign-in shares one rate-limit bucket, so a hot bucket returns 429 →
    // rate-limited. Both are the readable messages we want — assert one of them, and never the fallback.
    const formError = page.getByTestId("form-error");
    await expect(formError).toBeVisible();
    await expect(formError).toHaveText(
      /wrong username or password|Неправильний нікнейм або пароль|too many attempts|Забагато спроб/i,
    );
    expect(await page.getByTestId("error-username").count()).toBe(0);
    expect(await page.getByTestId("error-password").count()).toBe(0);
    await expect(page).toHaveURL(/\/login$/);
  });
});
