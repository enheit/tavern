/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { REALTIME_URL } from "../playwright.config";

// FR-19 voice, @realtime nightly (real Cloudflare Realtime SFU — §10 hermeticity split). The Worker
// runs WITHOUT TAVERN_SFU_MOCK, so there IS a media plane: B auto-subscribes A's mic and the inbound
// RTP actually flows. Remote-audio truth is asserted two ways: inbound-rtp bytesReceived climbing
// (via __tavernTestRtc.stats('voice')) AND the REMOTE speaking ring — the §App-B analyser RMS over
// the DECODED pulled track. The inbound-rtp `audioLevel` stat is deliberately NOT asserted: Chromium
// sources it from the RTP ssrc-audio-level header extension, which the Cloudflare SFU strips, so it
// reads 0 even while the tone is audible (S12.4 nightly finding — verified by decoded-RMS probe).
// The PR/mock suite (voice.spec.ts) covers the state/signaling side. baseURL is the real-SFU worker
// on 8788 (serves the app + /api same-origin). Every page is opened with `?e2e=1`. Skipped unless
// the realtime secrets are present (nightly/main only).
//
// The __tavernTestAudio / __tavernTestRtc window types are declared (ambient, project-wide) in
// voice.spec.ts.

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

async function seedMany(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
  prefixes: string[],
): Promise<Client[]> {
  const target = baseURL ?? REALTIME_URL;
  const [adminPrefix, ...restPrefixes] = prefixes;
  if (adminPrefix === undefined) throw new Error("seedMany needs at least one member");
  const admin = await api.createUser(adminPrefix);
  const server = await api.createServer(admin);
  const rest = await Promise.all(
    restPrefixes.map(async (prefix) => {
      const user = await api.createUser(prefix);
      await api.join(user, server.nickname);
      return user;
    }),
  );
  return Promise.all(
    [admin, ...rest].map(async (user): Promise<Client> => {
      const context = await browser.newContext({
        baseURL: target,
        storageState: await user.request.storageState(),
      });
      const page = await context.newPage();
      // Boot via "/" (single-server member lands on /s/:id); `?e2e=1` sets platform.isE2E at load.
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expectServerReady(page);
      return { user, context, page };
    }),
  );
}

async function seedPair(
  browser: Browser,
  baseURL: string | undefined,
  api: Api,
): Promise<{ clients: [Client, Client] }> {
  const built = await seedMany(browser, baseURL, api, ["a", "b"]);
  const [first, second] = built;
  if (!first || !second) throw new Error("expected two clients");
  return { clients: [first, second] };
}

// Join + wait until FULLY wired (publish + voice pull connected) — the §7.1 registration races make
// anything sequenced after a bare chip-visible wait flaky on slow runners.
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

async function readStats(
  page: Page,
): Promise<{ bytesReceived: number; audioLevel: number | null }> {
  const stats = await page.evaluate(() => window.__tavernTestRtc?.stats("voice"));
  if (stats === undefined) throw new Error("__tavernTestRtc.stats unavailable");
  return stats;
}

// Per-trackName inbound audio bytes of `viewer`'s voice pull (TASK-1 pairwise probe).
async function byTrack(viewer: Client): Promise<Record<string, number>> {
  const stats = await viewer.page.evaluate(() => window.__tavernTestRtc?.statsByTrack("voice"));
  if (stats === undefined) throw new Error("__tavernTestRtc.statsByTrack unavailable");
  return stats;
}

// The remote speaking ring on `viewer`'s page for `subject` — lit iff the DECODED pulled audio
// crosses the §App-B speaking threshold (stores/media.ts remote analyser).
function speakingRing(viewer: Client, subject: Client) {
  return viewer.page.getByTestId(`voice-chip-${subject.user.userId}`);
}

test.describe("FR-19 voice @realtime", () => {
  test("B receives A: inbound-rtp bytesReceived strictly increases over 5s AND A's remote speaking ring lights while the tone plays", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      // Wait until B is actually receiving A's mic before sampling.
      await expect
        .poll(async () => (await readStats(b.page)).bytesReceived, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const t0 = await readStats(b.page);
      await b.page.waitForTimeout(5_000);
      const t1 = await readStats(b.page);

      // FR-19 AC: real remote audio flowing — bytes climb AND the decoded tone drives B's remote
      // speaking ring for A (the audioLevel stat is unusable through this SFU; see header comment).
      expect(t1.bytesReceived).toBeGreaterThan(t0.bytesReceived);
      await expect(speakingRing(b, a)).toHaveAttribute("data-speaking", "true", {
        timeout: 10_000,
      });
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });

  // TASK-1 regression: the audibility bug was PAIRWISE-asymmetric (A hears B, C doesn't), which the
  // aggregate bytesReceived can't see — one loud pair hides a deaf one. Four clients join
  // CONCURRENTLY (the §7.1 registration race at its worst), then EVERY ordered pair's per-mic
  // inbound bytes must flow and strictly grow.
  test("four concurrent joiners: every ordered pair's per-mic bytesReceived flows and grows", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(300_000);
    const clients = await seedMany(browser, baseURL, api, ["a", "b", "c", "d"]);
    try {
      await Promise.all(clients.map((client) => joinVoice(client)));

      // Every viewer first RECEIVES every other mic (bytes > 0 per mic:{uid} — presence, not just
      // an aggregate), then a 5s-apart resample proves each of the 12 ordered pairs keeps flowing.
      await Promise.all(
        clients.map(async (viewer) => {
          const others = clients.filter((other) => other !== viewer);
          await expect
            .poll(
              async () => {
                const stats = await byTrack(viewer);
                return others.every((o) => (stats[`mic:${o.user.userId}`] ?? 0) > 0);
              },
              { timeout: 60_000 },
            )
            .toBe(true);
        }),
      );

      const t0 = await Promise.all(clients.map((viewer) => byTrack(viewer)));
      await clients[0]?.page.waitForTimeout(5_000);
      const t1 = await Promise.all(clients.map((viewer) => byTrack(viewer)));
      for (const [i, viewer] of clients.entries()) {
        for (const other of clients.filter((o) => o !== viewer)) {
          const key = `mic:${other.user.userId}`;
          expect(
            t1[i]?.[key] ?? 0,
            `${viewer.user.username} ← ${other.user.username}`,
          ).toBeGreaterThan(t0[i]?.[key] ?? 0);
        }
      }
    } finally {
      await Promise.all(clients.map((client) => client.context.close()));
    }
  });

  test("A mute → B's remote speaking ring for A goes dark within 3s", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(120_000);
    const {
      clients: [a, b],
    } = await seedPair(browser, baseURL, api);
    try {
      await joinVoice(a);
      await joinVoice(b);
      // B is hearing A: the decoded tone lights A's ring on B's page.
      await expect(speakingRing(b, a)).toHaveAttribute("data-speaking", "true", {
        timeout: 20_000,
      });

      // A mutes (track disabled → silence) → the decoded stream goes quiet → ring off within ~3s
      // (the §App-B analyser hold-off included).
      await a.page.getByTestId("controls-mute").click();
      await expect(speakingRing(b, a)).toHaveAttribute("data-speaking", "false", {
        timeout: 5_000,
      });
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });
});
