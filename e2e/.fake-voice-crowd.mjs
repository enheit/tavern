import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request as playwrightRequest } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "http://localhost:5173";
const SERVER_ID = "8b058d8e-50e0-444f-821c-bba6abec3bd5";
const SCREENSHOT_PATH = "/tmp/tavern-fake-voice-crowd.png";
const FULLSCREEN_SCREENSHOT_PATH = "/tmp/tavern-avatar-fullscreen.png";
const suffix = randomBytes(3).toString("hex");
const tonePath = path.join(ROOT, "e2e/fixtures/tone-440hz-10s.wav");

const looks = [
  {
    skinTone: "porcelain",
    hairColor: "ginger",
    hairStyle: "wavy",
    eyeColor: "green",
    glassesStyle: "none",
    facialHairStyle: "mustache",
    outfitColor: "#f97316",
  },
  {
    skinTone: "light-medium",
    hairColor: "black",
    hairStyle: "buzz",
    eyeColor: "brown",
    glassesStyle: "square",
    facialHairStyle: "stubble",
    outfitColor: "#22c55e",
  },
  {
    skinTone: "warm-medium",
    hairColor: "chestnut",
    hairStyle: "ponytail",
    eyeColor: "hazel",
    glassesStyle: "round",
    facialHairStyle: "none",
    outfitColor: "#06b6d4",
  },
  {
    skinTone: "tan",
    hairColor: "dark-brown",
    hairStyle: "curly",
    eyeColor: "amber",
    glassesStyle: "aviator",
    facialHairStyle: "goatee",
    outfitColor: "#eab308",
  },
  {
    skinTone: "medium-deep",
    hairColor: "black",
    hairStyle: "coily",
    eyeColor: "dark-brown",
    glassesStyle: "none",
    facialHairStyle: "short-beard",
    outfitColor: "#8b5cf6",
  },
  {
    skinTone: "deep",
    hairColor: "black",
    hairStyle: "locs",
    eyeColor: "gray",
    glassesStyle: "sunglasses",
    facialHairStyle: "none",
    outfitColor: "#ec4899",
  },
  {
    skinTone: "ebony",
    hairColor: "platinum",
    hairStyle: "spiked",
    eyeColor: "blue",
    glassesStyle: "none",
    facialHairStyle: "full-beard",
    outfitColor: "#3b82f6",
  },
];
const requestedCount = Number.parseInt(process.env.TAVERN_FAKE_COUNT ?? `${looks.length}`, 10);
const activeLooks = looks.slice(0, Math.max(1, Math.min(looks.length, requestedCount)));

const apiContexts = [];
const browserContexts = [];
let users = [];
let browser;

function readUserId(body) {
  const id = body?.user?.id;
  if (typeof id !== "string") throw new Error("Unexpected register response");
  return id;
}

function runLocalSql(sql) {
  execFileSync(
    "pnpm",
    [
      "-F",
      "@tavern/worker",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "tavern-db",
      "--local",
      "--command",
      sql,
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
}

async function waitForRtc(page) {
  await page.waitForFunction(
    () => {
      const rtc = window["__tavernTestRtc"];
      return rtc?.publishState === "connected" && rtc.pullStates.voice === "connected";
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function cleanup() {
  await Promise.allSettled(browserContexts.map((context) => context.close()));
  await browser?.close().catch(() => undefined);
  if (users.length > 0) {
    const ids = users.map(({ userId }) => `'${userId}'`).join(",");
    try {
      const cleanupApi = apiContexts[0];
      if (cleanupApi !== undefined) {
        const response = await cleanupApi.post("/api/__test/remove-members", {
          data: { serverId: SERVER_ID, userIds: users.map(({ userId }) => userId) },
        });
        if (!response.ok()) {
          throw new Error(`Room cleanup failed: ${response.status()} ${await response.text()}`);
        }
      }
      runLocalSql(
        `DELETE FROM memberships WHERE user_id IN (${ids}); DELETE FROM user_settings WHERE user_id IN (${ids}); DELETE FROM session WHERE user_id IN (${ids}); DELETE FROM account WHERE user_id IN (${ids}); DELETE FROM user WHERE id IN (${ids});`,
      );
    } catch (error) {
      process.exitCode = 1;
      console.error("Temporary crowd cleanup failed", error);
    }
  }
  await Promise.allSettled(apiContexts.map((context) => context.dispose()));
}

async function createUser(look, index) {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  apiContexts.push(api);
  const username = `voice_guest_${index + 1}_${suffix}`;
  const password = `pw-fake-${suffix}-${index + 1}`;
  const register = await api.post("/api/auth-wrap/register", {
    data: { username, password, repeatPassword: password },
  });
  if (!register.ok()) {
    throw new Error(`Register ${index + 1} failed: ${register.status()} ${await register.text()}`);
  }
  const userId = readUserId(await register.json());
  const displayName = `Voice Guest ${index + 1}`;
  const profile = await api.patch("/api/me/profile", {
    data: { displayName, voiceAvatar: { version: 2, ...look } },
  });
  if (!profile.ok()) {
    throw new Error(`Profile ${index + 1} failed: ${profile.status()} ${await profile.text()}`);
  }
  return { userId, displayName, storageState: await api.storageState() };
}

async function joinUser(user) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: user.storageState,
    permissions: ["microphone", "camera"],
    viewport: { width: 1440, height: 1100 },
  });
  browserContexts.push(context);
  const page = await context.newPage();
  await page.goto(`/s/${SERVER_ID}?e2e=1`);
  await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("channel-voice").click();
  await page.getByTestId(`voice-chip-${user.userId}`).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await waitForRtc(page);
  console.log(`JOINED ${user.displayName}`);
  return { ...user, page };
}

try {
  users = await Promise.all(activeLooks.map((look, index) => createUser(look, index)));

  const joinedAt = Date.now();
  const membershipValues = users
    .map(({ userId }) => `('${userId}','${SERVER_ID}',${joinedAt})`)
    .join(",");
  runLocalSql(
    `INSERT OR IGNORE INTO memberships (user_id,server_id,joined_at) VALUES ${membershipValues};`,
  );

  browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${tonePath}`,
    ],
  });

  users = await Promise.all(users.map((user) => joinUser(user)));

  const viewer = users[0].page;
  await viewer.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid^="voice-avatar-tile-"]').length === expected,
    users.length,
    { timeout: 30_000 },
  );
  await viewer.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid^="voice-avatar-tile-"][data-speaking="true"]')
        .length === expected,
    users.length,
    { timeout: 30_000 },
  );
  await viewer.getByTestId("canvas").screenshot({ path: SCREENSHOT_PATH });
  const renderers = await viewer
    .locator('[data-testid^="voice-avatar-tile-"]')
    .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-renderer")));
  console.log(
    `CROWD_READY ${JSON.stringify({ count: users.length, speaking: users.length, renderers, screenshot: SCREENSHOT_PATH })}`,
  );

  if (process.env.TAVERN_VERIFY_FULLSCREEN === "1") {
    const targetUserId = users[0].userId;
    await viewer.getByTestId(`voice-avatar-tile-${targetUserId}`).click();
    await viewer.keyboard.press("f");
    await viewer.getByTestId("canvas").waitFor({ state: "visible" });
    await viewer.waitForFunction(
      (userId) =>
        document.querySelector('[data-testid="canvas"]')?.getAttribute("data-fullscreen") ===
          "true" &&
        document
          .querySelector(`[data-testid="voice-avatar-slot-${userId}"]`)
          ?.getAttribute("data-fullscreen-tile") === "true",
      targetUserId,
      { timeout: 10_000 },
    );
    await viewer.screenshot({ path: FULLSCREEN_SCREENSHOT_PATH });
    console.log(`AVATAR_FULLSCREEN_READY ${FULLSCREEN_SCREENSHOT_PATH}`);
  }

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
