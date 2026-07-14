/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook globals window.__tavernTest* */
// Real-SFU regression probe for a 1080p60 fullscreen share. Publishes A's display while rendering a
// 60fps high-entropy animation — a deliberately hard video/game-like workload — then samples
// BOTH ends of the pipe every 5s:
//   publisher outbound: encoding count / codec / implementation / frameHeight / fps / limitation
//   viewer   inbound          : frameHeight / fps / kbps / framesDecoded
// Run with the web-realtime project only (real SFU). Results are read from stdout.
import { chromium, expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import path from "node:path";
import { REALTIME_URL, TONE_WAV } from "../playwright.config";
import { expectServerReady, test as harness } from "../harness/fixtures";
import type { SeededUser } from "../harness/fixtures";

declare global {
  interface Window {
    __tavernResetMotionSource?: () => void;
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

const VISUAL_DEMO = process.env.TAVERN_VISUAL_DEMO === "1";
const requestedDemoMs = Number(process.env.TAVERN_VISUAL_DEMO_MS ?? "600000");
const VISUAL_DEMO_MS = Number.isFinite(requestedDemoMs)
  ? Math.max(60_000, Math.min(1_200_000, requestedDemoMs))
  : 600_000;
type ProbeCodec = "vp8" | "h264" | "vp9" | "av1";
const requestedCodec = process.env.TAVERN_PROBE_CODEC?.toLowerCase();
const PROBE_CODEC: ProbeCodec =
  requestedCodec === "h264" ||
  requestedCodec === "vp9" ||
  requestedCodec === "av1" ||
  requestedCodec === "vp8"
    ? requestedCodec
    : "vp8";
const PUBLISHER_CHANNEL = process.env.TAVERN_PROBE_BROWSER === "chrome" ? "chrome" : "chromium";
const requestedVisualSlot = process.env.TAVERN_VISUAL_SLOT;
const VISUAL_SLOT =
  requestedVisualSlot === "left" || requestedVisualSlot === "right" ? requestedVisualSlot : null;
const PROBE_RECORD_DIR = process.env.TAVERN_PROBE_RECORD_DIR ?? null;
const requestedProbeMs = Number(process.env.TAVERN_PROBE_MS ?? "60000");
const PROBE_MS = Number.isFinite(requestedProbeMs)
  ? Math.max(20_000, Math.min(120_000, requestedProbeMs))
  : 60_000;

async function newClient(
  browser: Browser,
  user: SeededUser,
  recordVideoDir: string | null = null,
): Promise<Client> {
  const context = await browser.newContext({
    baseURL: REALTIME_URL,
    storageState: await user.request.storageState(),
    permissions: ["microphone", "camera"],
    viewport: VISUAL_DEMO ? { width: 800, height: 820 } : { width: 1920, height: 1080 },
    ...(recordVideoDir === null
      ? {}
      : { recordVideo: { dir: recordVideoDir, size: { width: 1280, height: 720 } } }),
  });
  const page = await context.newPage();
  await page.goto(`/?e2e=1`);
  await expectServerReady(page);
  return { user, context, page };
}

async function placeDemoWindow(page: Page, left: number): Promise<void> {
  if (!VISUAL_DEMO) return;
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { left, top: 40, width: 800, height: 900 },
  });
  await cdp.detach();
}

async function joinVoice(client: Client): Promise<void> {
  await client.page.getByTestId("channel-voice").click();
  await expect(client.page.getByTestId(`voice-chip-${client.user.userId}`)).toBeVisible({
    timeout: 20_000,
  });
}

// A video/game-like 60fps motion source with gradients, sharp grid lines, particles, a scrolling
// checkerboard, and an on-frame counter. Manual demo mode captures this canvas directly, which keeps
// the media workload deterministic even when the viewer window is brought in front of the publisher.
async function startMotionSource(page: Page): Promise<void> {
  await page.evaluate(
    ({ syntheticCapture, synchronize }) => {
      const canvas = document.createElement("canvas");
      canvas.width = syntheticCapture ? 1920 : window.innerWidth;
      canvas.height = syntheticCapture ? 1080 : window.innerHeight;
      canvas.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";
      document.body.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if (syntheticCapture) {
        Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
          configurable: true,
          value: async () => canvas.captureStream(60),
        });
      }
      let startedAt = performance.now();
      let frame = 0;
      window.__tavernResetMotionSource = () => {
        startedAt = performance.now();
        frame = 0;
      };
      const draw = (): void => {
        frame += 1;
        const elapsed = synchronize
          ? (Date.now() % 60_000) / 1_000
          : (performance.now() - startedAt) / 1_000;
        const phaseFrame = synchronize ? Math.floor(Date.now() / (1_000 / 60)) : frame;
        const hue = (elapsed * 42) % 360;
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, `hsl(${hue} 80% 16%)`);
        gradient.addColorStop(0.5, `hsl(${(hue + 90) % 360} 85% 34%)`);
        gradient.addColorStop(1, `hsl(${(hue + 210) % 360} 75% 12%)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255,255,255,.32)";
        const grid = 64;
        const offsetX = (phaseFrame * 5) % grid;
        const offsetY = (phaseFrame * 3) % grid;
        for (let x = -grid + offsetX; x < canvas.width; x += grid) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
        }
        for (let y = -grid + offsetY; y < canvas.height; y += grid) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
        }

        for (let i = 0; i < 96; i += 1) {
          const speed = 2 + (i % 7);
          const x = ((i * 173 + phaseFrame * speed * 2) % (canvas.width + 120)) - 60;
          const y =
            canvas.height / 2 +
            Math.sin(elapsed * (0.8 + (i % 5) * 0.13) + i) * (canvas.height * 0.4);
          const radius = 5 + (i % 6) * 2;
          ctx.beginPath();
          ctx.fillStyle = `hsla(${(hue + i * 17) % 360} 100% 72% / .82)`;
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }

        const bandY = canvas.height - 170;
        const cell = 30;
        for (let x = -cell + ((phaseFrame * 8) % (cell * 2)); x < canvas.width; x += cell) {
          ctx.fillStyle = (Math.floor(x / cell) & 1) === 0 ? "#f8fafc" : "#111827";
          ctx.fillRect(x, bandY, cell, 74);
        }
        ctx.fillStyle = "rgba(0,0,0,.68)";
        ctx.fillRect(28, 28, 650, 122);
        ctx.fillStyle = "#fff";
        ctx.font = "700 38px system-ui, sans-serif";
        ctx.fillText("PUBLISHER A · 1080p60 SOURCE", 52, 78);
        ctx.font = "600 27px ui-monospace, monospace";
        ctx.fillStyle = "#86efac";
        ctx.fillText(
          `SOURCE FRAME ${String(phaseFrame).padStart(6, "0")}  ·  ${elapsed.toFixed(2)}s`,
          52,
          125,
        );
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
    { syntheticCapture: VISUAL_DEMO, synchronize: VISUAL_SLOT !== null },
  );
}

harness(
  "quality probe: 1080p60 share → fullscreen viewer @realtime",
  async ({ api, browser }, testInfo) => {
    test.skip(!process.env.REALTIME_APP_ID, "realtime secrets absent");
    test.setTimeout(VISUAL_DEMO ? VISUAL_DEMO_MS + 180_000 : 240_000);

    // A gets its OWN browser instance: fake-ui screen capture grabs that browser's own headless
    // display, and A's noise page is the only window there — so the captured pixels are guaranteed to
    // be the 60fps noise, not whichever window happens to sit on top. B stays in the project browser
    // (clean page → its screenshot shows what the viewer actually perceives).
    const aBrowser = await chromium.launch({
      channel: PUBLISHER_CHANNEL,
      headless: !VISUAL_DEMO,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
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
      const b = await newClient(browser, bUser, PROBE_RECORD_DIR);
      const viewerRecording = b.page.video();
      const viewerLeft = VISUAL_SLOT === "right" ? 820 : 0;
      await placeDemoWindow(a.page, VISUAL_SLOT === null ? 0 : viewerLeft);
      await placeDemoWindow(b.page, VISUAL_SLOT === null ? 820 : viewerLeft);
      await expect(a.page).toHaveURL(new RegExp(`/s/${server.id}$`));
      await expect(b.page).toHaveURL(new RegExp(`/s/${server.id}$`));

      await joinVoice(a);
      await joinVoice(b);
      await expect
        .poll(() => a.page.evaluate(() => window.__tavernTestRtc?.publishState), {
          timeout: 30_000,
        })
        .toBe("connected");
      await startMotionSource(a.page);

      // Select 1080p60 before the native capture starts, exactly like a user choosing the requested
      // ceiling in the picker. This avoids contaminating the codec probe with a second capture.
      const ownTiles = a.page.locator(`[data-testid^="stream-tile-screen:${a.user.userId}:"]`);
      let track: string | null = null;
      await expect(async () => {
        const existing = ownTiles.last();
        if (await existing.isVisible().catch(() => false)) {
          const testId = await existing.getAttribute("data-testid");
          track = testId?.replace(/^stream-tile-/, "") ?? null;
          expect(track).not.toBeNull();
          return;
        }
        if (
          !(await a.page
            .getByTestId("share-preset")
            .isVisible()
            .catch(() => false))
        ) {
          await a.page.getByTestId("controls-screen").click();
        }
        await expect(a.page.getByTestId("share-preset")).toBeVisible({ timeout: 5_000 });
        await a.page.getByTestId("share-preset").click();
        await a.page.getByTestId("preset-option-1080p60").click();
        await a.page.getByTestId("share-codec").click();
        await a.page.getByTestId(`codec-option-${PROBE_CODEC}`).click();
        await a.page.getByTestId("share-start").click();
        await expect(existing).toBeVisible({ timeout: 15_000 });
        const testId = await existing.getAttribute("data-testid");
        track = testId?.replace(/^stream-tile-/, "") ?? null;
        expect(track).not.toBeNull();
      }).toPass({ timeout: 60_000 });
      if (track === null) throw new Error("publisher never exposed a successful screen track");
      const publishedTrack: string = track;
      console.log(`PROBE publishedTrack=${publishedTrack}`);
      console.log(`PROBE requestedCodec=${PROBE_CODEC.toUpperCase()}`);
      console.log(`PROBE publisherBrowser=${PUBLISHER_CHANNEL}`);
      await expect(a.page.getByTestId("share-fps-60")).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(
          async () => {
            const outputs = await a.page.evaluate(
              (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
              publishedTrack,
            );
            return outputs?.[0]?.codec?.toUpperCase() ?? null;
          },
          { timeout: 20_000 },
        )
        .toBe(PROBE_CODEC.toUpperCase());

      // B explicitly clicks Watch. Automated regression mode enters fullscreen; the headed visual
      // demo focuses the watched tile so the surrounding Tavern UI remains available.
      await b.page
        .getByTestId(`stream-tile-${publishedTrack}`)
        .getByTestId(`stream-watch-${publishedTrack}`)
        .click();
      const video = b.page.getByTestId(`stream-video-${publishedTrack}`);
      await expect
        .poll(() => video.evaluate((el) => (el instanceof HTMLVideoElement ? el.videoWidth : 0)), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await a.page.evaluate(() => window.__tavernResetMotionSource?.());
      const viewerStats = b.page.getByTestId(`stream-stats-${publishedTrack}`);
      // A watched stream in the normal grid remains visually clean; the stats mount only after the
      // user promotes that exact tile to focus or fullscreen.
      await expect(viewerStats).toHaveCount(0);
      if (VISUAL_DEMO) {
        await video.click();
        await expect(b.page.getByTestId("canvas")).toHaveAttribute("data-focused", "true");
      } else {
        await b.page.keyboard.press("f");
        await expect(b.page.getByTestId("canvas")).toHaveAttribute("data-fullscreen", "true");
      }
      await expect(viewerStats).toBeVisible({ timeout: 15_000 });
      await expect(viewerStats).toContainText(PROBE_CODEC.toUpperCase());

      const layerCalls = await b.page.evaluate(() => window.__tavernTestRtc?.layerCalls ?? []);
      console.log(`PROBE layerCalls=${JSON.stringify(layerCalls)}`);
      const pullRid = await b.page.evaluate(
        (tn) =>
          (window.__tavernTestRtc?.pullCalls ?? []).find((call) => call.trackName === tn)?.rid,
        publishedTrack,
      );
      expect(pullRid).toBeNull();

      if (VISUAL_DEMO) {
        await expect
          .poll(
            async () => {
              const outputs = await a.page.evaluate(
                (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
                publishedTrack,
              );
              return outputs?.[0] ?? null;
            },
            { timeout: 20_000 },
          )
          .not.toBeNull();
        const outputs = await a.page.evaluate(
          (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
          publishedTrack,
        );
        const output = outputs?.[0];
        await b.page.bringToFront();
        await viewerStats.click();
        await expect(viewerStats).toHaveAttribute("aria-expanded", "true");
        await b.page.waitForTimeout(1_500);
        await b.page.screenshot({
          path: testInfo.outputPath("visual-demo-ready.png"),
          fullPage: false,
        });
        console.log(
          `VISUAL_DEMO_READY durationMs=${VISUAL_DEMO_MS} codec=${output?.codec ?? "unknown"} implementation=${output?.encoderImplementation ?? "not-exposed"}`,
        );
      }

      let prevIn = { bytes: 0, at: Date.now() };
      const prevOut = new Map<string, { bytes: number; at: number }>();
      const viewerHeights: number[] = [];
      const decodedFrames: number[] = [];
      const outboundCounts: number[] = [];
      const outboundRids: Array<string | null> = [];
      /* oxlint-disable no-await-in-loop -- the sampling loop is deliberately sequential: each sample
       is a 5s-spaced time series, not parallelizable work */
      const sampleCount = Math.ceil((VISUAL_DEMO ? VISUAL_DEMO_MS : PROBE_MS) / 5_000);
      for (let i = 0; i < sampleCount; i++) {
        await b.page.waitForTimeout(5_000);
        const inbound = await b.page.evaluate(
          (tn) => window.__tavernTestVideoStats?.(tn),
          publishedTrack,
        );
        const outbound = await a.page.evaluate(
          (tn) => window.__tavernTestRtc?.outboundVideoStats(tn),
          publishedTrack,
        );
        if (inbound?.frameHeight != null) viewerHeights.push(inbound.frameHeight);
        if (inbound !== undefined) decodedFrames.push(inbound.framesDecoded);
        outboundCounts.push(outbound?.length ?? 0);
        for (const encoding of outbound ?? []) outboundRids.push(encoding.rid);
        const now = Date.now();
        const inKbps =
          inbound === undefined
            ? null
            : Math.round(((inbound.bytesReceived - prevIn.bytes) * 8) / (now - prevIn.at));
        if (inbound !== undefined) prevIn = { bytes: inbound.bytesReceived, at: now };
        const outLines = (outbound ?? []).map((layer) => {
          const key = layer.rid ?? "single";
          const prev = prevOut.get(key) ?? { bytes: layer.bytesSent, at: now - 5_000 };
          const kbps = Math.round(((layer.bytesSent - prev.bytes) * 8) / (now - prev.at));
          prevOut.set(key, { bytes: layer.bytesSent, at: now });
          return `${key}: codec=${layer.codec} impl=${layer.encoderImplementation} efficient=${layer.powerEfficientEncoder} h=${layer.frameHeight} fps=${layer.framesPerSecond} target=${layer.targetBitrate} limit=${layer.qualityLimitationReason} kbps=${kbps}`;
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
      const finalStats = await b.page.evaluate(
        (tn) => window.__tavernTestVideoStats?.(tn),
        publishedTrack,
      );
      expect(finalStats?.framesDecoded ?? 0).toBeGreaterThan(0);
      // One selected encoding must remain one end-to-end: no h/i/l publisher and no 270p SFU fallback.
      expect(outboundCounts.every((count) => count === 1)).toBe(true);
      expect(outboundRids.every((rid) => rid === null)).toBe(true);
      const settled = viewerHeights.slice(2);
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.every((h) => h === 1080)).toBe(true);
      // After warmup, every five-second interval must decode new frames (no complete freeze window).
      const settledFrameDeltas = decodedFrames
        .slice(2)
        .map((frames, index, samples) =>
          index === 0 ? 1 : frames - (samples[index - 1] ?? frames),
        );
      expect(settledFrameDeltas.every((delta) => delta > 0)).toBe(true);

      await a.context.close();
      await b.context.close();
      if (PROBE_RECORD_DIR !== null && viewerRecording !== null) {
        const recordingPath = path.join(PROBE_RECORD_DIR, `${PROBE_CODEC}.webm`);
        await viewerRecording.saveAs(recordingPath);
        console.log(`PROBE recording=${recordingPath}`);
      }
    } finally {
      await aBrowser.close();
    }
  },
);
