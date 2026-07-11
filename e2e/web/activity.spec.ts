import { WsTicketResponse } from "@tavern/shared";
import { expect, expectMemberVisible, test } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";
import { WEB_URL, WORKER_URL } from "../playwright.config";

// FR-39 Activity tab, live path: A's voice join/leave (driven at the WS protocol level, since the
// voice UI is a later step) must appear in B's open Activity tab without a refresh, newest-first,
// with A's displayName interpolated. B is the real browser under test; A is a bare protocol client.

interface VoiceWs {
  send(frame: { t: string }): void;
  close(): void;
}

// Open a raw WS as the seeded user and complete the `hello`→`hello.ok` handshake (A4/§6.2). Direct
// to the worker (WORKER_URL) — same Durable Object as the browser reaches through the Vite proxy.
async function openVoiceWs(serverId: string, ticket: string): Promise<VoiceWs> {
  const url = `${WORKER_URL.replace(/^http/, "ws")}/api/servers/${serverId}/ws?ticket=${ticket}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws hello timeout")), 10_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", proto: 1 })));
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "t" in parsed &&
        parsed.t === "hello.ok"
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws error before hello"));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("ws closed before hello"));
    });
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => ws.close(),
  };
}

async function ticketFor(user: SeededUser, serverId: string): Promise<string> {
  const res = await user.request.post("/api/ws-ticket", { data: { serverId } });
  if (!res.ok()) throw new Error(`ws-ticket failed: ${res.status()} ${await res.text()}`);
  return WsTicketResponse.parse(await res.json()).ticket;
}

test.describe("FR-39 activity e2e", () => {
  test("voice join and leave by A appear live in B activity tab without refresh", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(60_000);
    const a = await api.createUser("a");
    const server = await api.createServer(a);
    const b = await api.createUser("b");
    await api.join(b, server.nickname);

    const context = await browser.newContext({
      baseURL: baseURL ?? WEB_URL,
      storageState: await b.request.storageState(),
    });
    const page = await context.newPage();
    let voice: VoiceWs | null = null;
    try {
      // B boots onto the server; seeing A in People proves B's snapshot + WebSocket are live (so B
      // will receive A's activity.new broadcasts).
      await page.goto("/");
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectMemberVisible(page, a.userId);

      // Open the Activity tab BEFORE A does anything — the rows must land live, not on refresh.
      await page.getByTestId("tab-activity").click();

      voice = await openVoiceWs(server.id, await ticketFor(a, server.id));

      // A joins voice → B sees the join row (A's displayName interpolated).
      voice.send({ t: "voice.join" });
      const joinText = `${a.username} joined voice`;
      await expect(page.getByText(joinText, { exact: true })).toBeVisible({ timeout: 5000 });

      // A leaves voice → B sees the leave row, newest-first (above the join row).
      voice.send({ t: "voice.leave" });
      const leaveText = `${a.username} left voice`;
      await expect(page.getByText(leaveText, { exact: true })).toBeVisible({ timeout: 5000 });

      const texts = await page.getByTestId("activity-row").allTextContents();
      const leaveIdx = texts.findIndex((t) => t.includes(leaveText));
      const joinIdx = texts.findIndex((t) => t.includes(joinText));
      expect(leaveIdx).toBeGreaterThanOrEqual(0);
      expect(joinIdx).toBeGreaterThan(leaveIdx); // leave is newer → rendered above join
    } finally {
      voice?.close();
      await context.close();
    }
  });
});
