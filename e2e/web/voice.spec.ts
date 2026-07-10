/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
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
      soundboardPlays: Array<{ soundId: string; at: number }>;
    };
    __tavernTestRtc?: {
      publishState: string;
      pullStates: Record<string, string>;
      stats(session: "voice"): Promise<{ bytesReceived: number; audioLevel: number | null }>;
      // Extends the S7.4 hook (S8.4 populates it; S8.5's streams specs assert it). Declared here so the
      // ambient window type stays a single source for every spec — voice.spec does not read it.
      layerCalls: Array<{ trackName: string; rid: "h" | "l" }>;
    };
  }
}

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

// Seeds a fresh server with `count` members (the first is the admin/creator) and opens one browser
// context per member, each booted onto /s/:id?e2e=1 with the People panel live. Members after the
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
      // Boot via "/" (the boot gate lands a single-server member on /s/:id — a direct /s/:id deep-link
      // gate is S11.1). `?e2e=1` on the initial URL sets platform.isE2E at module load (frozen; the
      // client-side redirect preserves it), so the test hooks install.
      await page.goto(`/?e2e=1`);
      await expect(page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      return { user, context, page };
    }),
  );
  // Every socket is live once each client sees the others in People (so voice.state broadcasts land).
  await Promise.all(
    clients.map((client) =>
      Promise.all(
        clients
          .filter((other) => other.user.userId !== client.user.userId)
          .map((other) =>
            expect(client.page.getByTestId(`member-${other.user.userId}`)).toBeVisible(),
          ),
      ),
    ),
  );
  return { serverId: server.id, clients };
}

// Clicks Join and waits until the joiner is FULLY wired: self in the voice list AND both the publish
// and voice-pull sessions `connected`. Returning only at the voice.state ack (self chip visible) is
// too early — the next client to join would race this client's doJoin ⑤ (which awaits a pull of any
// member already listed), and pulling a not-yet-published mic is `pull_denied` → the join reverts.
// Serializing on the fully-connected state removes that race.
async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("controls-join").click();
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

test.describe("FR-18 FR-19 voice (mock SFU)", () => {
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
      // Right-click B's People row → the per-user volume menu; drive the slider to 150% by keyboard
      // (Home → 0, then 30 × +5% steps) for a deterministic value.
      await a.page.getByTestId(`member-${b.user.userId}`).click({ button: "right" });
      await expect(a.page.getByTestId(`volume-menu-${b.user.userId}`)).toBeVisible();
      const thumb = a.page
        .getByTestId(`volume-slider-${b.user.userId}`)
        .locator('[data-slot="slider-thumb"]');
      await thumb.click();
      await a.page.keyboard.press("Home");
      await Array.from({ length: 30 }).reduce<Promise<void>>(
        (p) => p.then(() => a.page.keyboard.press("ArrowRight")),
        Promise.resolve(),
      );

      await expect
        .poll(() => a.page.evaluate((id) => window.__tavernTestAudio?.userGains[id], b.user.userId))
        .toBe(1.5);

      // Persisted locally (settings.volumes.v1) → survives a fresh boot (full page reload via "/").
      await a.page.goto(`/?e2e=1`);
      await expect(a.page).toHaveURL(new RegExp(`/s/${serverId}$`));
      await expect(a.page.getByTestId("controls-bar")).toBeVisible();
      await expect
        .poll(() => a.page.evaluate((id) => window.__tavernTestAudio?.userGains[id], b.user.userId))
        .toBe(1.5);
    } finally {
      await closeClients(clients);
    }
  });

  test("both leave → within 5s (fast alarm) activity shows session closed and timer disappears (FR-24)", async ({
    browser,
    baseURL,
    api,
  }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b", "c"]);
    const [a, b, c] = clients;
    if (!a || !b || !c) throw new Error("expected three clients");
    try {
      // C observes the whole session without joining. Open its Activity tab up front.
      await c.page.getByTestId("tab-activity").click();
      await joinVoice(a);
      await joinVoice(b);
      await expect(c.page.getByTestId("voice-timer")).toBeVisible();

      // Both members drop their sockets (leave). The DO closes the empty session (immediate on the
      // last socket close; the fast alarm — TAVERN_TEST_FAST_ALARM=1, 5 s — is the crash-safety net).
      await a.context.close();
      await b.context.close();

      // The timer disappears for C (sessionStartedAt → null) and the leave activity rows land live.
      await expect(c.page.getByTestId("voice-timer")).toHaveCount(0, { timeout: 8_000 });
      await expect(c.page.getByText(`${a.user.username} left voice`, { exact: true })).toBeVisible({
        timeout: 8_000,
      });
      await expect(c.page.getByText(`${b.user.username} left voice`, { exact: true })).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await c.context.close();
    }
  });
});
