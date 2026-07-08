// Onboarding validation, mirroring the §1 limits enforced server-side so the
// form fails fast before a round-trip. Lengths in Unicode code points.
const NICKNAME_RE = /^[A-Za-z0-9_]{2,32}$/;

export function nicknameError(v: string): string | null {
  return NICKNAME_RE.test(v) ? null : '2–32 letters, numbers, or underscore';
}

export function passwordError(v: string): string | null {
  const n = [...v].length;
  return n >= 8 && n <= 128 ? null : 'Password must be 8–128 characters';
}
