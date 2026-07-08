import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker root route', () => {
  it('GET / returns 200 "ok"', async () => {
    const res = await SELF.fetch('https://tavern.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
