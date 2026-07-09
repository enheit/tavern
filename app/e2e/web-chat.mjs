// Real-browser roundtrip for the web build (Phase A): two users register in two
// browser contexts, share a server, and exchange chat over the live WS. Verifies
// session persistence across reload. Run: `pnpm test:e2e` (wrangler dev must be up).
import { launch, newUser, createServer, joinServer, createChannel, openChannel, waitOnline, shot } from './helpers.mjs';

const run = Date.now().toString(36);
const browser = await launch();
try {
  console.log('web-chat: register two users');
  const alice = await newUser(browser, `alice_${run}`);
  const bob = await newUser(browser, `bob_${run}`);
  await shot(alice.page, 'chat-01-alice-main.png');

  console.log('web-chat: alice creates server + #general');
  const serverId = await createServer(alice.page, `E2E ${run}`);
  await waitOnline(alice.page);
  await createChannel(alice.page, 'general');
  await openChannel(alice.page, 'general');

  console.log('web-chat: alice sends a message');
  await alice.page.getByLabel('Message').fill('hello from the web build');
  await alice.page.getByLabel('Message').press('Enter');
  await alice.page.getByText('hello from the web build').waitFor({ timeout: 10_000 });

  console.log('web-chat: bob joins and reads it');
  await joinServer(bob.page, serverId);
  await waitOnline(bob.page);
  await openChannel(bob.page, 'general');
  await bob.page.getByText('hello from the web build').waitFor({ timeout: 10_000 });
  await shot(bob.page, 'chat-02-bob-sees-alice.png');

  console.log('web-chat: bob replies, alice receives over WS');
  await bob.page.getByLabel('Message').fill('bob here, via browser');
  await bob.page.getByLabel('Message').press('Enter');
  await alice.page.getByText('bob here, via browser').waitFor({ timeout: 10_000 });
  await shot(alice.page, 'chat-03-alice-sees-bob.png');

  console.log('web-chat: alice reloads — session persists (localStorage)');
  await alice.page.reload();
  await alice.page.getByLabel('Add server').waitFor({ timeout: 10_000 });
  await waitOnline(alice.page);
  await openChannel(alice.page, 'general');
  await alice.page.getByText('bob here, via browser').waitFor({ timeout: 10_000 });
  await shot(alice.page, 'chat-04-alice-after-reload.png');

  console.log('web-chat: PASS');
} finally {
  await browser.close();
}
