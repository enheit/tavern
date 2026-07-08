// Password hashing + session-token primitives (PLAN §1 "Auth").
// PBKDF2-SHA-256, 100k iterations, 16-byte salt, 256-bit output; constant-time
// verify via crypto.subtle.timingSafeEqual. Session token = 32 random bytes as
// base64url; D1 stores sha256(token) hex. The SAME helper hashes user, server,
// and channel passwords. All primitives are WebCrypto (available in workerd).

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const TOKEN_BYTES = 32;

/** Raw PBKDF2-SHA-256 derivation — the shared primitive for hash + verify. */
export async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

/** Hash `password` with a fresh random 16-byte salt. Returns BLOBs for D1. */
export async function hashPassword(
  password: string,
): Promise<{ hash: Uint8Array; salt: Uint8Array; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { hash, salt, iterations: PBKDF2_ITERATIONS };
}

/** Constant-time verify `password` against a stored salt+hash (D1 BLOBs). */
export async function verifyPassword(
  password: string,
  salt: Uint8Array,
  expected: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<boolean> {
  const actual = await derivePbkdf2(password, salt, iterations);
  // timingSafeEqual throws on length mismatch — guard first (still non-secret info).
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

/** 32 random bytes as base64url. This is the raw token; it is NEVER stored. */
export function mintToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** SHA-256 of a token as lowercase hex — this is what the sessions table stores. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
