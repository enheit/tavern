/* oxlint-disable no-underscore-dangle -- reads the §10 e2e hook global window.__tavernTestRtc */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-25 recording e2e, PR-hermetic (TAVERN_SFU_MOCK=1 — §10). The recorder mixes the LOCAL audio graph
// (own mic = the committed tone WAV) into a MediaRecorder and uploads R2 multipart parts through the
// e2e worker's local R2; the SFU has no media plane here, so these assertions are signaling + state +
// the real local recording/upload/playback pipeline (no remote-media claims). A ~6s clip is a single
// sub-part-size chunk, so the sink opens the multipart on the FINAL part (post rec.stop) — the pinned
// row-based open path.

declare global {
  interface Window {
    __tavernTestRtc?: {
      publishState: string;
      pullStates: Record<string, string>;
      stats(session: "voice"): Promise<{ bytesReceived: number; audioLevel: number | null }>;
      // Kept identical to voice.spec's ambient block (interface-merge requires it); unused here.
      outboundVideoStats(trackName: string): Promise<
        Array<{
          rid: string | null;
          frameHeight: number | null;
          framesSent: number;
          bytesSent: number;
          framesPerSecond: number | null;
          targetBitrate: number | null;
          qualityLimitationReason: string | null;
        }>
      >;
      layerCalls: Array<{ trackName: string; rid: "h" | "l" }>;
    };
  }
}

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

interface RecordingRow {
  id: string;
  startedBy: string;
  durationMs: number | null;
  startedAt: number;
  endedAt: number | null;
}

async function seedRoom(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
  prefixes: string[],
): Promise<{ serverId: string; nickname: string; clients: Client[] }> {
  const target = baseURL ?? WEB_URL;
  const [adminPrefix, ...restPrefixes] = prefixes;
  if (adminPrefix === undefined) throw new Error("seedRoom needs at least one member");
  const admin = await api.createUser(adminPrefix);
  const server = await api.createServer(admin);
  const rest = await Promise.all(
    restPrefixes.map(async (prefix) => {
      const user = await api.createUser(prefix);
      await api.join(user, server.nickname);
      return user;
    }),
  );
  const users = [admin, ...rest];
  const clients = await Promise.all(
    users.map(async (user): Promise<Client> => {
      const context = await browser.newContext({
        baseURL: target,
        storageState: await user.request.storageState(),
      });
      const page = await context.newPage();
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      return { user, context, page };
    }),
  );
  await Promise.all(
    clients.map(async (client) => {
      await client.page.getByTestId("tab-people").click();
      await Promise.all(
        clients
          .filter((other) => other.user.userId !== client.user.userId)
          .map((other) =>
            expect(client.page.getByTestId(`member-${other.user.userId}`)).toBeVisible(),
          ),
      );
      await client.page.getByTestId("tab-chat").click();
    }),
  );
  return { serverId: server.id, nickname: server.nickname, clients };
}

// Clicks Join and waits until the joiner is fully wired (self chip + both sessions connected) — the
// same serialization voice.spec uses so a later joiner never races the pull of a not-yet-published mic.
async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        client.page.evaluate(() => {
          const rtc = window.__tavernTestRtc;
          return rtc ? { publish: rtc.publishState, pull: rtc.pullStates.voice ?? "none" } : null;
        }),
      { timeout: 20_000 },
    )
    .toEqual({ publish: "connected", pull: "connected" });
}

async function listRecordings(client: Client, serverId: string): Promise<RecordingRow[]> {
  const res = await client.user.request.get(`/api/servers/${serverId}/recordings`);
  if (!res.ok()) return [];
  const body: { recordings: RecordingRow[] } = await res.json();
  return body.recordings;
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

test.describe("FR-25 recording e2e (mock SFU)", () => {
  test("A records → B sees the REC chip + activity; stop lists it ≥5s; B plays it back", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(120_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);

      // B watches the Activity tab so the rec.start entry lands live.
      await b.page.getByTestId("tab-activity").click();

      // A starts recording.
      await a.page.getByTestId("controls-record").click();
      await expect(a.page.getByTestId("controls-record")).toHaveAttribute("aria-pressed", "true", {
        timeout: 10_000,
      });

      // (1) B sees the red REC chip AND the activity entry (FR-25: visible to ALL voice members).
      await expect(b.page.getByTestId("rec-indicator")).toBeVisible({ timeout: 10_000 });
      await expect(
        b.page.getByText(`${a.user.username} started a voice recording`, { exact: true }),
      ).toBeVisible({ timeout: 10_000 });

      // Record ~6s (FR-25 AC ≥ 5s).
      await a.page.waitForTimeout(6000);

      // (2) A stops → indicator drops for B, the recording finalizes and lists with durationMs ≥ 5000.
      await a.page.getByTestId("controls-record").click();
      await expect(b.page.getByTestId("rec-indicator")).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () => (await listRecordings(a, serverId))[0]?.durationMs ?? 0, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(5000);

      const [recording] = await listRecordings(a, serverId);
      if (recording === undefined) throw new Error("recording not listed");

      // (3) B plays it back: the audio element reaches readyState ≥ 2 and shows a non-zero mm:ss.
      await b.page.getByTestId("tab-recordings").click();
      await expect(b.page.getByTestId(`recording-${recording.id}`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(b.page.getByTestId(`recording-duration-${recording.id}`)).not.toHaveText("0:00");
      await b.page.getByTestId(`recording-play-${recording.id}`).click();
      await expect
        .poll(
          () =>
            b.page.evaluate((id) => {
              const el = document.querySelector(`[data-testid="recording-audio-${id}"]`);
              return el instanceof HTMLMediaElement ? el.readyState : 0;
            }, recording.id),
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await closeClients(clients);
    }
  });

  test("A leaves voice mid-recording → the recording finalizes (graceful) and appears in the list", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(120_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);

      await a.page.getByTestId("controls-record").click();
      await expect(b.page.getByTestId("rec-indicator")).toBeVisible({ timeout: 10_000 });
      await a.page.waitForTimeout(6000);

      // A LEAVES voice without pressing stop — the ControlsBar runs stop-and-complete BEFORE
      // voice.leave, so the recording finalizes instead of being dirty-ended (discarded).
      await a.page.getByTestId("controls-leave").click();

      await expect
        .poll(async () => (await listRecordings(b, serverId)).length, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);
      const [recording] = await listRecordings(b, serverId);
      expect(recording?.endedAt).not.toBeNull();
    } finally {
      await closeClients(clients);
    }
  });
});
