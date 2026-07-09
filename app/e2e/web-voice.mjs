// Real-browser media roundtrip for the web build (Phase B): two users join a voice
// channel with fake mics (Chromium tone generator), REAL signaling through the
// Worker/DO to the Cloudflare Realtime SFU, real WebRTC audio both ways (asserted
// via the speaking rings, which are driven by decoded-audio RMS), then a real
// screen share and webcam with tiles rendering actual frames (data-fps > 0).
// Run: `pnpm test:e2e` (wrangler dev with .dev.vars SFU creds must be up).
import { launch, newUser, createServer, joinServer, createChannel, openChannel, waitOnline, shot, assert } from './helpers.mjs';

const run = Date.now().toString(36);

async function userId(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('tavern-session')).userId);
}

// Poll until the tile reports decoded frames (data-fps > 0).
async function pollFrames(page, what) {
  const tile = page.locator('[data-testid^="tile-"]').first();
  const started = Date.now();
  for (;;) {
    const fps = await tile.getAttribute('data-fps');
    if (Number(fps) > 0) {
      console.log(`  ${what}: decoding ${fps} fps`);
      return;
    }
    assert(Date.now() - started < 30_000, `${what}: no decoded frames within 30s`);
    await page.waitForTimeout(500);
  }
}

async function waitForFrames(page, what) {
  await page.locator('[data-testid^="tile-"]').first().locator('button', { hasText: 'Join Stream' }).click();
  await pollFrames(page, what);
}

const browser = await launch();
try {
  console.log('web-voice: two users into one server');
  const alice = await newUser(browser, `alice_${run}`);
  const bob = await newUser(browser, `bob_${run}`);
  const serverId = await createServer(alice.page, `E2E ${run}`);
  await waitOnline(alice.page);
  await createChannel(alice.page, 'lounge', 'voice');
  await joinServer(bob.page, serverId);
  await waitOnline(bob.page);

  console.log('web-voice: both join the voice channel');
  await openChannel(alice.page, 'lounge');
  await openChannel(bob.page, 'lounge');
  await alice.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 15_000 });
  await bob.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 15_000 });

  console.log('web-voice: audio flows — speaking rings light up from decoded RMS');
  const aliceId = await userId(alice.page);
  const bobId = await userId(bob.page);
  // The fake mic is a loud tone: each side must see the OTHER side speaking, which
  // requires SFU-pulled audio to actually decode in the browser (not just signaling).
  await alice.page.locator(`[data-testid="vdot-${bobId}"].speaking`).waitFor({ timeout: 20_000 });
  await bob.page.locator(`[data-testid="vdot-${aliceId}"].speaking`).waitFor({ timeout: 20_000 });
  await shot(alice.page, 'voice-01-alice-hears-bob.png');

  console.log('web-voice: alice mutes — her ring goes dark on bob’s screen');
  await alice.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await bob.page
    .locator(`[data-testid="vdot-${aliceId}"]:not(.speaking)`)
    .waitFor({ timeout: 20_000 });
  await alice.page.getByRole('button', { name: 'Unmute', exact: true }).click();

  console.log('web-voice: alice shares her screen (browser picker auto-selected)');
  await alice.page.getByRole('button', { name: 'Share screen' }).click();
  await alice.page.getByTestId('share-start').click();
  await alice.page.getByTestId('sharing-indicator').waitFor({ timeout: 15_000 });

  console.log('web-voice: bob joins the stream and decodes real frames');
  await bob.page.locator('[data-testid^="tile-"]').first().waitFor({ timeout: 15_000 });
  await waitForFrames(bob.page, 'screen share on bob');
  await shot(bob.page, 'voice-02-bob-watches-screen.png');

  console.log('web-voice: bob turns on his webcam, alice watches it');
  await bob.page.getByRole('button', { name: 'Webcam', exact: true }).click();
  await bob.page.getByTestId('cam-start').click();
  await bob.page.getByTestId('camera-indicator').waitFor({ timeout: 15_000 });
  await alice.page.locator('[data-testid^="tile-"]').first().waitFor({ timeout: 15_000 });
  await waitForFrames(alice.page, 'webcam on alice');

  console.log('web-voice: alice pins the webcam (simulcast l → h re-subscribe)');
  const aliceTile = alice.page.locator('[data-testid^="tile-"]').first();
  await aliceTile.locator('button[aria-label^="Pin"]').click();
  await pollFrames(alice.page, 'webcam at layer "h" after pin');
  await shot(alice.page, 'voice-03-alice-pinned-webcam.png');

  console.log('web-voice: teardown — unwatch, unpublish, leave');
  await bob.page.locator('[data-testid^="tile-"] button', { hasText: 'Leave' }).click(); // stop watching
  await alice.page.locator('[data-testid^="tile-"] button', { hasText: 'Leave' }).click();
  await alice.page.getByRole('button', { name: 'Stop sharing' }).click();
  await bob.page.getByRole('button', { name: 'Turn off webcam' }).click();
  await alice.page.getByRole('button', { name: 'Leave', exact: true }).click(); // voice leave (now unique)
  await bob.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await alice.page.getByText('Not in voice').waitFor({ timeout: 10_000 });
  await bob.page.getByText('Not in voice').waitFor({ timeout: 10_000 });

  console.log('web-voice: PASS');
} finally {
  await browser.close();
}
