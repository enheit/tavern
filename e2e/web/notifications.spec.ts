import { randomBytes } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { expect, expectMemberVisible, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-16 system notifications against the real local stack. Both pages install the pinned §10 test
// hook (`window.__tavernTestNotifications`) BEFORE any app script runs, so the platform bridge records
// notifications instead of raising OS ones; specs then assert the decision rule from those records.

declare global {
  interface Window {
    __tavernTestNotifications?: { title: string; body: string; serverId: string }[];
  }
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

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
  await page.addInitScript(() => {
    window["__tavernTestNotifications"] = [];
  });
  return { context, page };
}

async function bootOnto(opened: Opened, serverId: string): Promise<void> {
  await opened.page.goto("/");
  await expect(opened.page).toHaveURL(new RegExp(`/s/${serverId}$`));
  await expect(opened.page.getByTestId("composer-input")).toBeVisible();
}

async function bootPair(browser: Browser, baseURL: string | undefined, api: Api) {
  const a = await api.createUser("a");
  const server = await api.createServer(a);
  const b = await api.createUser("b");
  await api.join(b, server.nickname);

  const openedA = await pageFor(browser, baseURL, a);
  const openedB = await pageFor(browser, baseURL, b);
  await Promise.all([bootOnto(openedA, server.id), bootOnto(openedB, server.id)]);
  // Both sockets live: each sees the other on Dashboard while Chat remains persistent.
  await expectMemberVisible(openedA.page, b.userId);
  await expectMemberVisible(openedB.page, a.userId);
  return { a, b, server, openedA, openedB };
}

// The pinned technique: force the window's focus state via document overrides + the matching event.
async function setFocus(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((isFocused) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (isFocused ? "visible" : "hidden"),
    });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => isFocused });
    window.dispatchEvent(new Event(isFocused ? "focus" : "blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  }, focused);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

async function notifications(
  page: Page,
): Promise<{ title: string; body: string; serverId: string }[]> {
  return page.evaluate(() => window["__tavernTestNotifications"] ?? []);
}

test.describe("FR-16 notifications", () => {
  test("unfocused B records a notification for A's message", async ({ browser, baseURL, api }) => {
    const { openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      await setFocus(openedB.page, false);
      const text = `ping-${hex(4)}`;
      await send(openedA.page, text);
      await expect
        .poll(async () => (await notifications(openedB.page)).some((n) => n.body.includes(text)))
        .toBe(true);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("focused B on the active server records none", async ({ browser, baseURL, api }) => {
    const { openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      await setFocus(openedB.page, true);
      const text = `quiet-${hex(4)}`;
      await send(openedA.page, text);
      // B sees the message live (proves delivery) but records no notification.
      await expect(openedB.page.getByText(text, { exact: true })).toBeVisible({ timeout: 3000 });
      expect(await notifications(openedB.page)).toHaveLength(0);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("all-off + mentions-on: only the mention notifies", async ({ browser, baseURL, api }) => {
    const { b, openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      // Turn OFF all-messages (keep mentions ON) via B's Settings UI — disabling needs no permission.
      await openedB.page.getByTestId("user-menu").click();
      await openedB.page.getByTestId("user-menu-settings").click();
      await openedB.page.getByTestId("settings-tab-notifications").click();
      await openedB.page.getByTestId("settings-notify-all").click();
      await openedB.page.keyboard.press("Escape");
      await expect(openedB.page.getByTestId("settings-dialog")).toBeHidden();

      await setFocus(openedB.page, false);
      const plain = `plain-${hex(4)}`;
      const mention = `hey @${b.username} shout-${hex(4)}`;
      await send(openedA.page, plain);
      await send(openedA.page, mention);

      // Exactly one notification — the mention — and its body carries the pinned '@ ' prefix.
      await expect.poll(async () => (await notifications(openedB.page)).length).toBe(1);
      const recorded = await notifications(openedB.page);
      expect(recorded[0]?.body.startsWith("@ ")).toBe(true);
      expect(recorded[0]?.body.includes(plain)).toBe(false);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });

  test("notification record carries the right serverId", async ({ browser, baseURL, api }) => {
    const { server, openedA, openedB } = await bootPair(browser, baseURL, api);
    try {
      await setFocus(openedB.page, false);
      await send(openedA.page, `tag-${hex(4)}`);
      await expect.poll(async () => (await notifications(openedB.page)).length).toBeGreaterThan(0);
      const recorded = await notifications(openedB.page);
      expect(recorded[0]?.serverId).toBe(server.id);
    } finally {
      await openedA.context.close();
      await openedB.context.close();
    }
  });
});
