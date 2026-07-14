/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// §8 cost guardrails end-to-end (S12.3, mock SFU + TAVERN_TEST=1): seed the egress meter through
// POST /api/__test/set-egress and prove G1/G5 — the amber warn banner at 700 GB (decimal, the meter's
// unit) on every connected client, new watches rejected with cost_cap at 900 GB with NO pull session
// created, the already-running watch untouched, and voice leave/rejoin still working at the cap.
//
// Spec deviation (documented in progress.md): the pinned test list needs a running watch (A) plus a
// separately-rejected watcher (B) of the SAME single fake share — a sharer cannot watch their own
// stream, so the minimum topology is THREE contexts (sharer S + watchers A/B), not two.

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

// Mirrors streams.spec.ts's seedRoom/joinVoice/startScreenShare harness (module-local there).
async function seedRoom(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
  prefixes: string[],
): Promise<{ serverId: string; clients: Client[] }> {
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
      await expectServerReady(page);
      return { user, context, page };
    }),
  );
  await Promise.all(
    clients.map(async (client) => {
      await Promise.all(
        clients
          .filter((other) => other.user.userId !== client.user.userId)
          .map((other) =>
            expect(client.page.getByTestId(`home-member-${other.user.userId}`)).toBeVisible(),
          ),
      );
    }),
  );
  return { serverId: server.id, clients };
}

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

async function startScreenShare(client: Client): Promise<string> {
  await client.page.getByTestId("controls-screen").click();
  await expect(client.page.getByTestId("share-preset")).toBeVisible();
  await client.page.getByTestId("share-start").click();
  const trackName = `screen:${client.user.userId}:1`;
  await expect(client.page.getByTestId(`stream-tile-${trackName}`)).toBeVisible({
    timeout: 20_000,
  });
  return trackName;
}

async function watchConnected(client: Client, track: string): Promise<void> {
  await expect(client.page.getByTestId(`stream-tile-${track}`)).toBeVisible({ timeout: 15_000 });
  await client.page.getByTestId(`stream-watch-${track}`).click();
  await expect
    .poll(() => client.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track), {
      timeout: 20_000,
    })
    .toBe("connected");
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

test.describe("§8 cost guardrails", () => {
  test("warn banner at 700 GB; kill at 900 GB rejects new watches, keeps the running watch and voice", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(180_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["s", "a", "b"]);
    const [s, a, b] = clients;
    if (!s || !a || !b) throw new Error("expected three clients");
    try {
      await joinVoice(s);
      const track = await startScreenShare(s);
      await joinVoice(a);
      await joinVoice(b);

      // (1) A watches the fake share → a running, metered pull exists.
      await watchConnected(a, track);

      // Seed 700 GB (decimal — the meter compares decimal GB, §8). The next alarm tick (5 s under
      // TAVERN_TEST_FAST_ALARM) crosses the warn threshold once per month-bucket → cost.warning →
      // the amber banner appears on EVERY connected client.
      const month = new Date().toISOString().slice(0, 7);
      const warn = await s.user.request.post("/api/__test/set-egress", {
        data: { serverId, month, bytes: 700_000_000_000 },
      });
      expect(warn.ok()).toBe(true);
      await expect(a.page.getByTestId("cost-banner")).toBeVisible({ timeout: 30_000 });
      await expect(b.page.getByTestId("cost-banner")).toBeVisible({ timeout: 30_000 });
      await expect(
        a.page.getByText("Streaming has used 700 GB of the 900 GB monthly budget", {
          exact: false,
        }),
      ).toBeVisible();

      // Dismissal is per-session and per-client: A's banner goes, B's stays.
      await a.page.getByTestId("cost-banner-dismiss").click();
      await expect(a.page.getByTestId("cost-banner")).toHaveCount(0);
      await expect(b.page.getByTestId("cost-banner")).toBeVisible();

      // (2) Seed 900 GB → B's watch.start is rejected with cost_cap BEFORE any SFU state exists:
      // the pinned toast shows, and the §10 pull-session hook never holds an entry for the track.
      const kill = await s.user.request.post("/api/__test/set-egress", {
        data: { serverId, month, bytes: 900_000_000_000 },
      });
      expect(kill.ok()).toBe(true);
      await b.page.getByTestId(`stream-watch-${track}`).click();
      await expect(
        b.page.getByText("Monthly streaming budget reached", { exact: false }),
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() =>
          b.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn] ?? "none", track),
        )
        .toBe("none");

      // A's already-running watch from (1) keeps its state through the kill.
      expect(await a.page.evaluate((tn) => window.__tavernTestRtc?.pullStates[tn], track)).toBe(
        "connected",
      );

      // (3) Voice stays alive at the cap (§8 G5): B leaves and rejoins successfully.
      await b.page.getByTestId("controls-leave").click();
      await expect(b.page.getByTestId(`voice-chip-${b.user.userId}`)).toHaveCount(0, {
        timeout: 15_000,
      });
      await joinVoice(b);
    } finally {
      await closeClients(clients);
    }
  });
});
