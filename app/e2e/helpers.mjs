// Shared helpers for the real-browser e2e specs (plain playwright, no test framework).
// Run against a local `wrangler dev` serving the built web app (see README in this dir).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:8787';
export const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

// Continuous 440 Hz tone for the fake mic: the default fake beeps are too short
// for the §1 speaking rule (RMS > 0.02 sustained ≥100 ms), a steady tone isn't.
function toneWav() {
  const path = `${SHOTS}tone.wav`;
  const rate = 48_000;
  const seconds = 2;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16_000), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Media flags are harmless for chat-only specs and required for voice/webcam ones:
// fake mic (tone) + fake webcam (rolling pattern), auto-granted permission prompts,
// and auto-picked screen for getDisplayMedia. channel:'chromium' forces the full
// Chromium build — Playwright's default headless shell has no media capture at all.
export async function launch() {
  return chromium.launch({
    channel: 'chromium',
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${toneWav()}`, // played on a loop
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

export async function newUser(browser, nickname, password = 'hunter2hunter2') {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror:`, e.message));
  await page.goto(BASE);
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Repeat password').fill(password);
  await page.getByTestId('submit').click();
  // Main is up when the server rail's add button renders.
  await page.getByLabel('Add server').waitFor({ timeout: 10_000 });
  return { ctx, page, nickname, password };
}

export async function createServer(page, name) {
  await page.getByLabel('Add server').click();
  await page.getByRole('button', { name: 'Create server' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByTestId('submit').click();
  await page.getByTitle(name).waitFor({ timeout: 10_000 });
  // The freshly created server is auto-selected; grab its id via the API the
  // same way the app does (token from the web session in localStorage).
  return page.evaluate(async (base) => {
    const s = JSON.parse(localStorage.getItem('tavern-session'));
    const list = await (
      await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${s.token}` } })
    ).json();
    return list[list.length - 1].id;
  }, BASE);
}

export async function joinServer(page, serverId) {
  await page.getByLabel('Add server').click();
  await page.getByRole('button', { name: 'Join server' }).click();
  await page.getByLabel('Server ID').fill(serverId);
  await page.getByTestId('submit').click();
}

export async function createChannel(page, name, kind = 'text') {
  await page.getByLabel('Create channel').click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type').selectOption(kind);
  await page.getByTestId('submit').click();
}

export async function openChannel(page, name) {
  await page.getByRole('button', { name, exact: false }).first().click();
}

// Wait until this user's own presence dot renders — proof the server WS is open
// (frames sent before that are dropped, §1). Matters on real-network runs.
export async function waitOnline(page) {
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('tavern-session')).userId);
  await page.locator(`[data-testid="dot-${uid}"]`).waitFor({ timeout: 15_000 });
}

export async function shot(page, file) {
  await page.screenshot({ path: `${SHOTS}${file}`, fullPage: true });
  console.log(`  screenshot: e2e/screenshots/${file}`);
}
