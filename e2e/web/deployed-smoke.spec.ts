import { randomBytes } from "node:crypto";
import { expect, test } from "../harness/fixtures";

// FR-42 deployed smoke (S11.1): auth + chat against the REAL deployment. Runs only when
// E2E_BASE_URL is set (e.g. E2E_BASE_URL=https://tavern-worker.<account>.workers.dev) and navigates
// to that URL directly, ignoring the project baseURL — this spec is the pinned mechanism for the
// manual deploy evidence, not part of the hermetic suite. Voice/media against production is nightly
// @realtime territory (PLAN §10), deliberately out of scope here.

const base = process.env.E2E_BASE_URL;

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

test.describe("FR-42 deployed smoke", () => {
  test.skip(base === undefined || base === "", "E2E_BASE_URL not set");

  test("register, login, send and receive a chat message", async ({ browser }) => {
    test.setTimeout(120_000);
    const target = (base ?? "").replace(/\/$/, "");
    const username = `u_smoke_${hex(3)}`;
    const password = `pw-${hex(5)}`;

    // Register via the real UI → first run has no servers → /join → create a server → server view.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${target}/register`);
      await page.getByTestId("input-username").fill(username);
      await page.getByTestId("input-password").fill(password);
      await page.getByTestId("input-repeat-password").fill(password);
      await page.getByTestId("submit").click();
      await expect(page).toHaveURL(/\/join$/, { timeout: 15_000 });

      await page.getByTestId("create-nickname").fill(`smoke-${hex(4)}`);
      await page.getByTestId("create-submit").click();
      await expect(page).toHaveURL(/\/s\/[0-9a-zA-Z-]+$/, { timeout: 15_000 });

      // A chat.send fired while the room WS is still connecting is dropped by design (the optimistic
      // row stays until the reconnect resnapshot clears it) — so wait for the live connection before
      // sending. Real edge latency makes this race reliably lose without the gate.
      await expect(page.getByTestId("connection-dot")).toHaveAttribute("data-status", "open", {
        timeout: 15_000,
      });

      // Send: the message must RECONCILE (optimistic rows render instantly with a negative id —
      // message--N — and only flip to the server id once chat.new comes back over the WS; closing
      // the context on the optimistic copy would lose the send if the socket is still connecting,
      // which real edge latency made happen on the first run of this spec).
      const text = `deployed-${hex(4)}`;
      const input = page.getByTestId("composer-input");
      await input.fill(text);
      await input.press("Enter");
      await expect(
        page
          .locator('li[data-testid^="message-"]:not([data-testid^="message--"])')
          .filter({ hasText: text }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await context.close();
    }

    // Receive: a FRESH session logs in via the UI and gets the message back from the deployed D1
    // history (not from optimistic local state) after the boot gate lands it on the server.
    const second = await browser.newContext();
    const page2 = await second.newPage();
    try {
      await page2.goto(`${target}/login`);
      await page2.getByTestId("input-username").fill(username);
      await page2.getByTestId("input-password").fill(password);
      await page2.getByTestId("submit").click();
      await expect(page2).toHaveURL(/\/s\/[0-9a-zA-Z-]+$/, { timeout: 15_000 });
      await expect(page2.getByText(/^deployed-/, { exact: false }).first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await second.close();
    }
  });
});
