/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestAudio */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import type { Api, SeededUser } from "../harness/fixtures";
import { WEB_URL } from "../playwright.config";

// FR-36/37/38 soundboard, PR hermeticity (TAVERN_SFU_MOCK=1): pressing a sound broadcasts sound.play;
// the DO records it + fans out sound.played to ALL sockets; every in-voice, non-deafened client plays
// it locally (NEVER through WebRTC — A7). Under the e2e harness the player records the play into
// window.__tavernTestAudio.soundboardPlays instead of producing audio, so the cross-client sync AC
// (|tA − tB| < 500 ms) is deterministic. Every page opens with `?e2e=1` so the hooks install.

const BEEP_MP3: Buffer = readFileSync(
  fileURLToPath(new URL("../fixtures/beep.mp3", import.meta.url)),
);

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

// Seeds a fresh server with `count` members (first = admin/creator), each booted onto /s/:id?e2e=1.
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
      await expect(page.getByTestId("controls-bar")).toBeVisible();
      await expect(page.getByTestId("soundboard-panel")).toBeVisible();
      return { user, context, page };
    }),
  );
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

// Clicks Join and waits until FULLY wired (self in voice + publish & voice-pull `connected`) — the same
// race-free gate the voice spec uses (a too-early return lets a later joiner pull an unpublished mic).
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

// Uploads beep.mp3 via the panel's upload dialog; resolves once the multipart POST returns 201.
async function uploadSound(client: Client, name: string): Promise<void> {
  await client.page.getByTestId("soundboard-upload-open").click();
  await client.page.getByTestId("upload-file").setInputFiles({
    name: "beep.mp3",
    mimeType: "audio/mpeg",
    buffer: BEEP_MP3,
  });
  await client.page.getByTestId("upload-name").fill(name);
  const posted = client.page.waitForResponse(
    (res) =>
      res.url().endsWith("/sounds") && res.request().method() === "POST" && res.status() === 201,
  );
  await client.page.getByTestId("upload-submit").click();
  await posted;
}

// The single seeded sound's id, read from its play-count badge testid once it renders on `client`.
async function soundId(client: Client): Promise<string> {
  const badge = client.page.locator('[data-testid^="sound-plays-"]').first();
  await expect(badge).toBeVisible({ timeout: 10_000 });
  const testid = await badge.getAttribute("data-testid");
  if (testid === null) throw new Error("sound badge missing testid");
  return testid.replace("sound-plays-", "");
}

async function playCount(client: Client, id: string): Promise<number> {
  return client.page.evaluate(
    (sid) => window.__tavernTestAudio?.soundboardPlays.filter((p) => p.soundId === sid).length ?? 0,
    id,
  );
}

async function closeClients(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close()));
}

test.describe("FR-36 soundboard e2e", () => {
  test("A uploads beep.mp3 → appears on B via sound.updated", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await uploadSound(a, "beep");
      // B learns of the new sound via the DO's sound.updated broadcast → list refetch (no voice).
      await expect(
        b.page.getByTestId("soundboard-panel").getByText("beep", { exact: true }),
      ).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await closeClients(clients);
    }
  });

  test("A plays → both clients log a soundboardPlay within 500ms and playCount shows 1 on both", async ({
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
      await uploadSound(a, "beep");
      const id = await soundId(a);
      await expect(b.page.getByTestId(`sound-${id}`)).toBeVisible({ timeout: 10_000 });

      await a.page.getByTestId(`sound-${id}`).click();

      // Both clients record a play (the sender plays on its own broadcast receipt — single code path).
      await expect.poll(() => playCount(a, id), { timeout: 10_000 }).toBe(1);
      await expect.poll(() => playCount(b, id), { timeout: 10_000 }).toBe(1);
      // FR-36 AC: the two plays land within 500 ms of each other (shared clock, one browser process).
      const tA = await a.page.evaluate(
        (sid) => window.__tavernTestAudio?.soundboardPlays.find((p) => p.soundId === sid)?.at ?? 0,
        id,
      );
      const tB = await b.page.evaluate(
        (sid) => window.__tavernTestAudio?.soundboardPlays.find((p) => p.soundId === sid)?.at ?? 0,
        id,
      );
      expect(Math.abs(tA - tB)).toBeLessThan(500);
      // FR-37 live badge: playCount shows 1 on both.
      await expect(a.page.getByTestId(`sound-plays-${id}`)).toHaveText("1", { timeout: 5_000 });
      await expect(b.page.getByTestId(`sound-plays-${id}`)).toHaveText("1", { timeout: 5_000 });
    } finally {
      await closeClients(clients);
    }
  });

  test("deafened B logs no play but badge still increments", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { clients } = await seedRoom(browser, baseURL, api, ["a", "b"]);
    const [a, b] = clients;
    if (!a || !b) throw new Error("expected two clients");
    try {
      await joinVoice(a);
      await joinVoice(b);
      await uploadSound(a, "beep");
      const id = await soundId(a);
      await expect(b.page.getByTestId(`sound-${id}`)).toBeVisible({ timeout: 10_000 });

      await b.page.getByTestId("controls-deafen").click();
      await expect.poll(() => b.page.evaluate(() => window.__tavernTestAudio?.deafened)).toBe(true);

      await a.page.getByTestId(`sound-${id}`).click();

      // A (not deafened) plays; B's badge still increments to 1, but B logs NO play (deafened).
      await expect.poll(() => playCount(a, id), { timeout: 10_000 }).toBe(1);
      await expect(b.page.getByTestId(`sound-plays-${id}`)).toHaveText("1", { timeout: 5_000 });
      expect(await playCount(b, id)).toBe(0);
    } finally {
      await closeClients(clients);
    }
  });

  test("soundboard volume persists across reload", async ({ browser, baseURL, api }) => {
    test.setTimeout(90_000);
    const { serverId, clients } = await seedRoom(browser, baseURL, api, ["a"]);
    const [a] = clients;
    if (!a) throw new Error("expected one client");
    const stored = (): Promise<number | undefined> =>
      a.page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("settings.volumes.v1") ?? "{}") as {
              soundboard?: number;
            }
          ).soundboard,
      );
    try {
      // Drive the soundboard slider to its max (200% → gain 2.0). Press directly on the Base UI
      // a11y range input (Playwright focuses it first — more robust than a thumb click + page-level
      // key), and End is deterministic (no step counting) — moving it off the 100% default.
      const input = a.page.getByTestId("soundboard-volume").locator('input[type="range"]').first();
      await input.press("End");
      await expect.poll(stored).toBe(2);

      // Persisted locally (settings.volumes.v1) → survives a fresh boot (full reload via "/").
      await a.page.goto(`/?e2e=1`);
      await expect(a.page).toHaveURL(new RegExp(`/s/${serverId}$`));
      await expect(a.page.getByTestId("controls-bar")).toBeVisible();
      await expect.poll(stored).toBe(2);
    } finally {
      await closeClients(clients);
    }
  });
});
