// Server passwords ONLY (FR-09). User passwords are better-auth's concern — this module never
// touches them. Format: `pbkdf2$<iterations>$<saltB64>$<hashB64>` (PLAN §5.1 comment on
// servers.password_hash). WebCrypto PBKDF2-SHA256, 100_000 iterations, 16-byte random salt,
// 32-byte derived key; verification uses workerd's constant-time `crypto.subtle.timingSafeEqual`
// (a runtime extension — never a JS `===` compare, per the S2.1 STOP condition). No dependencies.
const ALGORITHM = "pbkdf2";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

// btoa/atob operate on binary strings; salt+hash are ≤32 bytes so the spread never risks the
// argument-count limit.
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
}

// Derives the 32-byte PBKDF2-SHA256 key for `plain` under the given salt + iteration count.
async function deriveKey(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// Hashes a plaintext server password into the storable `pbkdf2$…` string (fresh random salt).
export async function hashServerPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveKey(plain, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

// Constant-time verify of `plain` against a stored `pbkdf2$…` string. Returns false (never throws)
// on any structurally invalid stored value so a corrupt row can't crash the join path.
export async function verifyServerPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  const [scheme, iterStr, saltB64, hashB64] = parts;
  if (
    parts.length !== 4 ||
    scheme !== ALGORITHM ||
    iterStr === undefined ||
    saltB64 === undefined ||
    hashB64 === undefined
  ) {
    return false;
  }
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const expected = fromBase64(hashB64);
  if (expected.byteLength !== KEY_BYTES) return false;
  const actual = await deriveKey(plain, fromBase64(saltB64), iterations);
  return crypto.subtle.timingSafeEqual(actual, expected);
}
