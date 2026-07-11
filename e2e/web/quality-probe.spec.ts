/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
// DIAGNOSTIC probe (temporary): why does a 1080p60 screen share look terrible for a fullscreen
// viewer? Publishes A's OWN tab (auto-select tab capture) rendering a 60fps high-entropy noise
// animation — the worst-case dynamic content a real stream (video/game) resembles — then samples
// BOTH ends of the pipe every 5s:
//   publisher outbound per-rid: frameHeight / fps / targetBitrate / qualityLimitationReason / kbps
//   viewer   inbound          : frameHeight / fps / kbps / framesDecoded
// Run with the web-realtime project only (real SFU). Results are read from stdout.
import { chromium, expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { REALTIME_URL, TONE_WAV } from "../playwright.config";
import { test as harness } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";

declare global {
  interface Window {
    __tavernTestVideoStats?: (trackName: string) => Promise<{
      framesDecoded: number;
      frameHeight: number | null;
      bytesReceived: number;
      framesPerSecond: number | null;
    }>;
  }
}

interface Client {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

async function newClient(browser: Browser, user: SeededUser): Promise<Client> {
  const context = await browser.newContext({
    baseURL: REALTIME_URL,
    storageState: await user.request.storageState(),
    permissions: ["microphone", "camera"],
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  await page.goto(`/?e2e=1`);
  await expect(page.getByTestId("controls-bar")).toBeVisible({ timeout: 20_000 });
  return { user, context, page };
}

async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
}

// 60fps full-viewport noise: random blocks + a fast-moving bar. High-entropy every frame, so the
// encoder can never coast the way it can on a static desktop — this is the "streaming a video/game"
// content profile.
async function startNoise(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let t = 0;
    const draw = (): void => {
      t += 1;
      for (let i = 0; i < 600; i++) {
        ctx.fillStyle = `rgb(${(Math.random() * 256) | 0},${(Math.random() * 256) | 0},${(Math.random() * 256) | 0})`;
        ctx.fillRect(
          Math.random() * canvas.width,
          Math.random() * canvas.height,
          40 + Math.random() * 80,
          20 + Math.random() * 40,
        );
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect((t * 23) % canvas.width, 0, 60, canvas.height);
      ctx.fillStyle = "#000";
      ctx.font = "bold 48px sans-serif";
      ctx.fillText(`frame ${t}`, 40 + ((t * 7) % 600), 100 + ((t * 3) % 800));
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
}

harness("quality probe: 1080p60 share → fullscreen viewer @realtime", async ({ api, browser }) => {
  test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
  test.setTimeout(240_000);

  // A gets its OWN browser instance: fake-ui screen capture grabs that browser's own headless
  // display, and A's noise page is the only window there — so the captured pixels are guaranteed to
  // be the 60fps noise, not whichever window happens to sit on top. B stays in the project browser
  // (clean page → its screenshot shows what the viewer actually perceives).
  const aBrowser = await chromium.launch({
    channel: "chromium",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${TONE_WAV}`,
      // Deterministic getDisplayMedia surface — fake-ui alone occasionally rejects the display
      // picker in headless (observed bimodal across identical runs).
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });
  try {
    const admin = await api.createUser("a");
    const server = await api.createServer(admin);
    const bUser = await api.createUser("b");
    await api.join(bUser, server.nickname);

    const a = await newClient(aBrowser, admin);
    const b = await newClient(browser, bUser);
    await expect(a.page).toHaveURL(new RegExp(`/s/${server.id}$`));
    await expect(b.page).toHaveURL(new RegExp(`/s/${server.id}$`));

    await joinVoice(a);
    await joinVoice(b);
    await startNoise(a.page);

    // Share starts at the 1080p30 default; bump fps to 60 live (the real user flow). Retry the
    // click: a rejected capture leaves the app idle, so re-clicking re-opens getDisplayMedia.
    const track = `screen:${a.user.userId}:1`;
    await expect(async () => {
      await a.page.getByTestId("controls-screen").click();
      await expect(a.page.getByTestId(`stream-tile-${track}`)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await a.page.getByTestId("share-fps-60").click();
    await expect(a.page.getByTestId("share-fps-60")).toHaveAttribute("aria-pressed", "true");

    // B watches, then fullscreens (the `f` key targets the watched stream).
    await b.page.getByTestId(`stream-tile-${track}`).getByTestId(`stream-watch-${track}`).click();
    const video = b.page.getByTestId(`stream-video-${track}`);
    await expect
      .poll(() => video.evaluate((el) => (el instanceof HTMLVideoElement ? el.videoWidth : 0)), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await b.page.keyboard.press("f");
    await expect(b.page.getByTestId("canvas")).toHaveAttribute("data-fullscreen", "true");

    const layerCalls = await b.page.evaluate(() => window.__tavernTestRtc?.layerCalls ?? []);
    console.log(`PROBE layerCalls=${JSON.stringify(layerCalls)}`);

    let prevIn = { bytes: 0, at: Date.now() };
    const prevOut = new Map<string, { bytes: number; at: number }>();
    const viewerHeights: number[] = [];
    /* oxlint-disable no-await-in-loop -- the sampling loop is deliberately sequential: each sample
       is a 5s-spaced time series, not parallelizable work */
    for (let i = 0; i < 12; i++) {
      await b.page.waitForTimeout(5_000);
      const inbound = await b.page.evaluate((tn) => window.__tavernTestVideoStats?.(tn), track);
      const outbound = await a.page.evaluate(
        (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
        track,
      );
      if (inbound?.frameHeight != null) viewerHeights.push(inbound.frameHeight);
      const now = Date.now();
      const inKbps =
        inbound === undefined
          ? null
          : Math.round(((inbound.bytesReceived - prevIn.bytes) * 8) / (now - prevIn.at));
      if (inbound !== undefined) prevIn = { bytes: inbound.bytesReceived, at: now };
      const outLines = (outbound ?? []).map((layer) => {
        const key = layer.rid ?? "?";
        const prev = prevOut.get(key) ?? { bytes: layer.bytesSent, at: now - 5_000 };
        const kbps = Math.round(((layer.bytesSent - prev.bytes) * 8) / (now - prev.at));
        prevOut.set(key, { bytes: layer.bytesSent, at: now });
        return `${key}: h=${layer.frameHeight} fps=${layer.framesPerSecond} target=${layer.targetBitrate} limit=${layer.qualityLimitationReason} kbps=${kbps}`;
      });
      console.log(
        `PROBE t=${(i + 1) * 5}s viewer h=${inbound?.frameHeight} fps=${inbound?.framesPerSecond} kbps=${inKbps} framesDecoded=${inbound?.framesDecoded} || publisher ${outLines.join(" | ")}`,
      );
    }

    /* oxlint-enable no-await-in-loop */

    // Visual evidence of what the fullscreen viewer actually sees.
    await b.page.screenshot({
      path: "test-results/quality-probe-viewer.png",
      fullPage: false,
    });
    const finalStats = await b.page.evaluate((tn) => window.__tavernTestVideoStats?.(tn), track);
    expect(finalStats?.framesDecoded ?? 0).toBeGreaterThan(0);
    // THE regression this spec exists for (2026-07-11): a fullscreen watcher must HOLD the 1080p h
    // layer. Before the Worker pinned the layer (priorityOrdering:"none"), the SFU's automatic mode
    // flapped 270↔1080 on every bandwidth-estimate dip — half the samples were 270p mush. Warmup
    // (first 2 samples) tolerates the initial l→h switch; after that every sample must be 1080.
    const settled = viewerHeights.slice(2);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every((h) => h === 1080)).toBe(true);

    await a.context.close();
    await b.context.close();
  } finally {
    await aBrowser.close();
  }
});
