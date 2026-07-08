import { describe, expect, it } from 'vitest';
import {
  derivePbkdf2,
  hashPassword,
  hashToken,
  mintToken,
  verifyPassword,
} from '../src/lib/crypto';

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('password hashing', () => {
  it('round-trips: correct password verifies true, wrong verifies false', async () => {
    const { hash, salt } = await hashPassword('hunter2-correct');
    expect(await verifyPassword('hunter2-correct', salt, hash)).toBe(true);
    expect(await verifyPassword('hunter2-WRONG', salt, hash)).toBe(false);
  });

  it('length-mismatch expected hash verifies false without throwing', async () => {
    const { salt } = await hashPassword('x');
    // A truncated "expected" must not reach timingSafeEqual (which throws on
    // length mismatch); the guard returns false.
    expect(await verifyPassword('x', salt, new Uint8Array(8))).toBe(false);
  });

  it('matches a pinned PBKDF2-SHA-256 vector (guards params never silently change)', async () => {
    // salt = bytes 0..15, password fixed, 100k iters, 256-bit — derived once,
    // pinned here. If iterations/hash/bit-length drift, this fails.
    const salt = new Uint8Array(16);
    for (let i = 0; i < 16; i++) salt[i] = i;
    const PINNED = '49d49c25f597846209f0d92e7770ab64e1c75e94b4ce6c509265ee67175d2a1e';
    const derived = await derivePbkdf2('correct horse battery staple', salt);
    expect(bytesToHex(derived)).toBe(PINNED);
    // …and the public verify path agrees with the pinned vector.
    expect(
      await verifyPassword('correct horse battery staple', salt, hexToBytes(PINNED)),
    ).toBe(true);
  });
});

describe('session tokens', () => {
  it('hashToken returns 64 lowercase hex chars (sha256)', async () => {
    const h = await hashToken(mintToken());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mintToken is url-safe and unique per call', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(a).not.toBe(b);
  });
});
