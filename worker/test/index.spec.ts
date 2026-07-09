import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker root route', () => {
  it('GET / returns 200 "ok"', async () => {
    const res = await SELF.fetch('https://tavern.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

import { env } from 'cloudflare:test';
import { buildManifest, manifestSchema } from '../src/lib/update-manifest';

describe('S6.3 updates route + manifest schema', () => {
  it('GET /updates/latest.json serves the R2 object with content-type + 60 s cache', async () => {
    const manifest = buildManifest({
      version: '0.1.1',
      notes: 'test',
      pubDate: '2026-07-09T00:00:00.000Z',
      baseUrl: 'https://tavern.test',
      artifacts: [{ platform: 'darwin-aarch64', signature: 'sig-b64', file: 'Tavern.app.tar.gz' }],
    });
    await env.UPDATES.put('latest.json', JSON.stringify(manifest));

    const res = await SELF.fetch('https://tavern.test/updates/latest.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = manifestSchema.parse(await res.json());
    expect(body.version).toBe('0.1.1');
    expect(body.platforms['darwin-aarch64']!.url).toBe(
      'https://tavern.test/updates/Tavern.app.tar.gz',
    );
  });

  it('GET /updates/<missing> → 404; bundles served as octet-stream', async () => {
    expect((await SELF.fetch('https://tavern.test/updates/nope.json')).status).toBe(404);

    await env.UPDATES.put('Tavern.app.tar.gz', new Uint8Array([1, 2, 3]));
    const res = await SELF.fetch('https://tavern.test/updates/Tavern.app.tar.gz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('manifest schema rejects bad version, empty platforms, bad url, missing signature', () => {
    const good = {
      version: '1.2.3',
      notes: '',
      pub_date: '2026-07-09T00:00:00.000Z',
      platforms: { 'linux-x86_64': { signature: 's', url: 'https://x/updates/a.AppImage' } },
    };
    expect(manifestSchema.safeParse(good).success).toBe(true);
    expect(manifestSchema.safeParse({ ...good, version: 'v1.2' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...good, platforms: {} }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...good, pub_date: 'yesterday' }).success).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...good,
        platforms: { 'linux-x86_64': { signature: '', url: 'https://x/a' } },
      }).success,
    ).toBe(false);
  });
});
