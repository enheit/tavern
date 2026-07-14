/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, expectServerReady, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-18/19/20/23/24/26 voice, PR hermeticity: the Worker runs with TAVERN_SFU_MOCK=1 (fixture-backed
// mock SFU, no media plane — §10). These specs therefore assert SIGNALING + STATE + LOCAL media:
// voice.state fan-out, publish/pull session state (via the __tavernTestRtc hook), the self speaking
// ring from the LOCAL analyser on the committed tone WAV, mute/deafen badges, per-user local gains,
// and the fast-alarm session close. Remote-media assertions (bytesReceived) live in the @realtime
// nightly spec. Every page is opened with `?e2e=1` so the web platform bridge installs the hooks.

// The e2e test-hook surface (installed by app/src/lib/testHooks.ts under platform.isE2E). Declared
// here so all three voice specs can read it typed via page.evaluate — the app-side global augmentation
// is not part of the e2e tsconfig. Project-wide (ambient), so voice-smoke/voice-realtime see it too.
declare global {
  interface Window {
    __tavernTestAudio?: {
      deafened: boolean;
      userGains: Record<string, number>;
      speakingUserIds: string[];
      soundboardPlays: Array<{
        soundId: string;
        at: number;
        mode: "shared" | "local-preview" | "editor-preview";
        trimStartMs: number;
        trimEndMs: number;
        gain: number;
      }>;
      // userIds whose remote mic is attached to the live audio graph — the mock suite's pairwise
      // "can hear" truth (§ Task-1 regression: every member wired to every other member).
      remoteMicUserIds: string[];
    };
    __tavernTestRtc?: {
      publishState: string;
      pullStates: Record<string, string>;
      stats(session: "voice"): Promise<{ bytesReceived: number; audioLevel: number | null }>;
      // Per-trackName inbound audio bytes (mic:{uid} → bytesReceived) — @realtime pairwise probe.
      statsByTrack(session: "voice"): Promise<Record<string, number>>;
      // Publisher-side per-rid outbound video summary (FR-27 fault-domain split — streams-realtime
      // asserts the h layer re-encodes a dropped preset before polling the viewer; quality-probe
      // reads the bitrate/limitation fields).
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
      // Extends the S7.4 hook (S8.4 populates it; S8.5's streams specs assert it). Declared here so the
      // ambient window type stays a single source for every spec — voice.spec does not read it.
      layerCalls: Array<{ trackName: string; rid: "h" | "l" }>;
      pullCalls: Array<{ trackName: string; rid: "h" | "l" | null }>;
    };
  }
}

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
  // Rolling tail of the page's console (warn/error only) — dumped by the TASK-1 diagnostics when a
  // pairwise wiring assertion fails, so a red run says WHY (pull errors, retry exhaustion) instead
  // of just which mic was missing.
  consoleTail: string[];
}

// On a pairwise-wiring failure, dump each client's live rtc hook state + console tail — the
// difference between "one mic missing" and an actionable repro.
async function dumpVoiceDiagnostics(clients: Client[]): Promise<void> {
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- sequential diagnostic dump, failure path only
    const diag = await client.page
      .evaluate(() => ({
        pullStates: window.__tavernTestRtc?.pullStates ?? {},
        publishState: window.__tavernTestRtc?.publishState ?? "none",
        pullCalls: window.__tavernTestRtc?.pullCalls ?? [],
        remoteMicUserIds: window.__tavernTestAudio?.remoteMicUserIds ?? [],
      }))
      .catch(() => null);
    console.log(
      `[voice-diag] ${client.user.username} (${client.user.userId})`,
      JSON.stringify(diag),
      `console: ${JSON.stringify(client.consoleTail.slice(-12))}`,
    );
  }
}

// Seeds a fresh server with `count` members (the first is the admin/creator) and opens one browser
// context per member, each booted onto /s/:id?e2e=1 with Dashboard membership live. Members after the
// first join in parallel (independent); contexts open in parallel too (no await-in-loop).
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
      const consoleTail: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "warning" && msg.type() !== "error") return;
        consoleTail.push(`${msg.type()}: ${msg.text()}`.slice(0, 300));
        if (consoleTail.length > 50) consoleTail.shift();
      });
      // Boot via "/" (the boot gate lands a single-server member on /s/:id — a direct /s/:id deep-link
      // gate is S11.1). `?e2e=1` on the initial URL sets platform.isE2E at module load (frozen; the
      // client-side redirect preserves it), so the test hooks install.
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      // The controls row mounts only after joining voice; the Dashboard is the idle boot surface.
      await expect(page.getByTestId("tavern-home")).toBeVisible();
      return { user, context, page, consoleTail };
    }),
  );
  // Every socket is live once each client sees the others on Dashboard.
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

// Clicks Join and waits until the joiner is FULLY wired: self in the voice list AND both the publish
// and voice-pull sessions `connected`. Returning only at the voice.state ack (self chip visible) is
// too early — the next client to join would race this client's doJoin ⑤ (which awaits a pull of any
// member already listed), and pulling a not-yet-published mic is `pull_denied` → the join reverts.
// Serializing on the fully-connected state removes that race.
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

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

// TASK-1 pairwise truth: `viewer`'s live audio graph holds EXACTLY the given subjects' remote mics
// (exact equality also catches stale nodes lingering after a leave).
async function wiredTo(viewer: Client, subjects: Client[]): Promise<void> {
  await expect
    .poll(
      () =>
        viewer.page.evaluate(() => (window.__tavernTestAudio?.remoteMicUserIds ?? []).toSorted()),
      { timeout: 45_000 },
    )
    .toEqual(subjects.map((s) => s.user.userId).toSorted());
}

test.describe("FR-18 FR-19 voice (mock SFU)", () => {
  test("three voice members render as distinct WebGL avatars on the Dashboard", async ({
    browser,
    baseURL,
    api,
  }, testInfo) => {
    test.setTimeout(45_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b", "c", "observer"]);
    const [a, b, c, observer] = clients;
    if (!a || !b || !c || !observer) throw new Error("expected four clients");
    try {
      // voice.join updates the shared roster immediately. The mock SFU intentionally has no media
      // plane, so this visual smoke check does not wait for its PeerConnections to become connected.
      await Promise.all(
        [a, b, c].map((client) => client.page.getByTestId("channel-voice").click()),
      );
      await Promise.all(
        [a, b, c].map((member) =>
          expect(observer.page.getByTestId(`voice-avatar-tile-${member.user.userId}`)).toBeVisible({
            timeout: 10_000,
          }),
        ),
      );
      await Promise.all(
        [a, b, c].map((member) =>
          expect(
            observer.page.getByTestId(`voice-avatar-tile-${member.user.userId}`),
          ).toHaveAttribute("data-renderer", "ready", { timeout: 10_000 }),
        ),
      );
      const screenshotPath = testInfo.outputPath("voice-lounge.png");
      await observer.page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach("voice-lounge", { path: screenshotPath, contentType: "image/png" });
    } finally {
      await closeClients(clients);
    }
  });

  test("A and B join → both see 2 voice members; observer C sees both chips and the timer (FR-24)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b", "c"]);
    const [a, b, c] = clients;
    if (!a || !b || !c) throw new Error("expected three clients");
    try {
      await joinVoice(a);
      await joinVoice(b);

      // A, B, and the observer C each see BOTH voice members.
      await Promise.all(
        [a, b, c].map(async (viewer) => {
          await expect(viewer.page.getByTestId(`voice-chip-${a.user.userId}`)).toBeVisible({
            timeout: 10_000,
          });
          await expect(viewer.page.getByTestId(`voice-chip-${b.user.userId}`)).toBeVisible({
            timeout: 10_000,
          });
          await expect(viewer.page.getByTestId(`voice-avatar-tile-${a.user.userId}`)).toBeVisible({
            timeout: 10_000,
          });
          await expect(viewer.page.getByTestId(`voice-avatar-tile-${b.user.userId}`)).toBeVisible({
            timeout: 10_000,
          });
        }),
      );
      await expect(a.page.getByTestId("voice-members").getByRole("listitem")).toHaveCount(2);

      // FR-24: the observer C (never in voice) sees the session timer too.
      await expect(c.page.getByTestId("voice-timer")).toBeVisible();
    } finally {
      await closeClients(clients);
    }
  });

  test("publish session reaches connected on both (rtc hook)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      await Promise.all(
        [a, b].map((client) =>
          expect
            .poll(() => client.page.evaluate(() => window.__tavernTestRtc?.publishState), {
              timeout: 15_000,
            })
            .toBe("connected"),
        ),
      );
    } finally {
      await closeClients(clients);
    }
  });

  test("speaking ring appears on A within 2s of joining (tone WAV → local analyser, FR-23)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a] = clients;
    if (!a) throw new Error("expected client");
    try {
      await joinVoice(a);
      // The committed 440 Hz tone drives A's LOCAL analyser past the §App-B speaking threshold.
      await expect(a.page.getByTestId(`voice-chip-${a.user.userId}`)).toHaveAttribute(
        "data-speaking",
        "true",
        { timeout: 2_500 },
      );
      const avatar = a.page.getByTestId(`voice-avatar-tile-${a.user.userId}`);
      await expect(avatar).toHaveAttribute("data-renderer", "ready");
      await expect(avatar).toHaveAttribute("data-speaking", "true");
    } finally {
      await closeClients(clients);
    }
  });

  test("A mutes → B sees mute badge ≤1s (FR-26)", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      await a.page.getByTestId("controls-mute").click();
      await expect(b.page.getByTestId(`voice-muted-${a.user.userId}`)).toBeVisible({
        timeout: 1_000,
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("sidebar mute works away from the stream workspace and mirrors the controls bar", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      await a.page.getByTestId("workspace-tab-dashboard").click();
      await a.page.getByTestId("sidebar-mute").click();

      await expect(a.page.getByTestId("sidebar-mute")).toHaveAttribute("aria-pressed", "true");
      await expect(a.page.getByTestId("controls-mute")).toHaveAttribute("aria-pressed", "true");
      await expect(b.page.getByTestId(`voice-muted-${a.user.userId}`)).toBeVisible({
        timeout: 1_000,
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("B deafens → hook __tavernTestAudio.deafened === true and B auto-muted (FR-26)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      await b.page.getByTestId("controls-deafen").click();
      // Local audio hook reflects deafen; deafen forces self-mute (B's mute button is pressed).
      await expect.poll(() => b.page.evaluate(() => window.__tavernTestAudio?.deafened)).toBe(true);
      await expect(b.page.getByTestId("controls-mute")).toHaveAttribute("aria-pressed", "true");
      // Peers see B's deafened badge.
      await expect(a.page.getByTestId(`voice-deafened-${b.user.userId}`)).toBeVisible({
        timeout: 2_000,
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("A sets B volume to 150 → userGains[B]===1.5; persists across reload (localStorage, FR-20)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      // Dashboard intentionally has no audio controls. Adjust B from their live voice chip instead:
      // ten upward wheel notches at 5% each moves the default 100% gain to 150%.
      const chip = a.page.getByTestId(`voice-chip-${b.user.userId}`);
      await chip.hover();
      await Array.from({ length: 10 }).reduce<Promise<void>>(
        (previous) => previous.then(() => a.page.mouse.wheel(0, -100)),
        Promise.resolve(),
      );
      await expect(a.page.getByTestId(`voice-volume-pct-${b.user.userId}`)).toHaveText("150%");

      await expect
        .poll(() => a.page.evaluate((id) => window.__tavernTestAudio?.userGains[id], b.user.userId))
        .toBe(1.5);

      // Persisted locally (settings.volumes.v1) → survives a fresh boot (full page reload via "/").
      await a.page.goto(`/?e2e=1`);
      await expect(a.page).toHaveURL(new RegExp(`/s/${serverId}$`));
      await expectServerReady(a.page);
      await expect
        .poll(() => a.page.evaluate((id) => window.__tavernTestAudio?.userGains[id], b.user.userId))
        .toBe(1.5);
    } finally {
      await closeClients(clients);
    }
  });

  // TASK-1 audibility regression: with 3+ members the old engine left asymmetric deaf pairs — a
  // pull racing the joiner's REST publish either 403'd past the flat retry budget or came back 200
  // with a swallowed per-track SFU error (no retry, silent forever). Four clients join
  // CONCURRENTLY (maximum registration racing), then every pair must be wired both ways: the
  // remote mic attached to the live audio graph is the mock-suite truth (no media plane). The
  // leave/rejoin churn then exercises grant cleanup + the micSeq re-pull of the fresh session.
  test("four concurrent joiners all hear each other pairwise; leave/rejoin re-wires (TASK-1)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(240_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b", "c", "d"]);
    const [a, b, c, d] = clients;
    if (!a || !b || !c || !d) throw new Error("expected four clients");
    try {
      // All four join at once — no serialization: this is exactly the §7.1 registration race.
      await Promise.all(clients.map((client) => joinVoice(client)));
      await Promise.all(
        clients.map((viewer) =>
          wiredTo(
            viewer,
            clients.filter((other) => other !== viewer),
          ),
        ),
      ).catch(async (err: unknown) => {
        await dumpVoiceDiagnostics(clients);
        throw err;
      });

      // D leaves mid-call: the survivors drop exactly D (stale mic nodes must not linger).
      await d.page.getByTestId("controls-leave").click();
      await Promise.all([wiredTo(a, [b, c]), wiredTo(b, [a, c]), wiredTo(c, [a, b])]).catch(
        async (err: unknown) => {
          await dumpVoiceDiagnostics(clients);
          throw err;
        },
      );

      // D rejoins mid-call: everyone re-wires — the survivors pull D's NEW mic session (micSeq
      // bump path) and D pulls all three existing mics.
      await joinVoice(d);
      await Promise.all(
        clients.map((viewer) =>
          wiredTo(
            viewer,
            clients.filter((other) => other !== viewer),
          ),
        ),
      ).catch(async (err: unknown) => {
        await dumpVoiceDiagnostics(clients);
        throw err;
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("both leave → live Home returns to quiet and timer disappears (FR-24)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b", "c"]);
    const [a, b, c] = clients;
    if (!a || !b || !c) throw new Error("expected three clients");
    try {
      // C observes the whole session without joining from the idle-center Home.
      await expect(c.page.getByTestId("tavern-home")).toBeVisible();
      await joinVoice(a);
      await joinVoice(b);
      await expect(c.page.getByTestId("voice-timer")).toBeVisible();

      // Both members drop their sockets. The DO preserves media for the 15 s reconnect lease, then
      // its alarm expires both leases and closes the empty session.
      await a.context.close();
      await b.context.close();

      // The timer disappears for C (sessionStartedAt → null) and Home returns to quiet.
      await expect(c.page.getByTestId("voice-timer")).toHaveCount(0, { timeout: 25_000 });
      await expect(c.page.getByText("The voice room is quiet", { exact: true })).toBeVisible({
        timeout: 25_000,
      });
    } finally {
      await c.context.close();
    }
  });
});
